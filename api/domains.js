const { checkToken, setCors, getPool } = require('./_db');
const {
  CHROME_UA, getCfTokens, getCfAccountLabels,
  fetchCfJson, fetchAllZones, findZoneForDomain, ZONES_CACHE_TTL_MS,
} = require('./_cf');
const { supabaseSelect } = require('./_supabase');

async function fetchKeitaroDomains() {
  const url = `${process.env.KEITARO_API_URL}/admin_api/v1/domains`;
  const res = await fetch(url, { headers: { 'Api-Key': process.env.KEITARO_API_KEY } });
  if (!res.ok) throw new Error(`Keitaro API error ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.data || []);
}

// Alternative domain source: tables the user syncs from Keitaro once a day themselves,
// so the page never has to call a live Keitaro production API on load. They also already
// have expiration_date stored, so no live RDAP lookup is needed for this source either.
// Two separate Keitaro systems are synced into two separate tables — keitaro_domain (has
// its own `group` column already) and keitaro_domain_media (no group column). The two
// tables cover almost entirely disjoint domain sets, so results are combined, each tagged
// with which system it came from.
async function fetchDomainsFromDb() {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT name, \`group\`, expiration_date, auto_renew, domain_status, check_expiration, 'keitaro' AS system
     FROM keitaro_domain
     UNION ALL
     SELECT name, NULL AS \`group\`, expiration_date, auto_renew, domain_status, check_expiration, 'keitaro_media' AS system
     FROM keitaro_domain_media`
  );
  return rows.map(r => {
    let expiryDate = null, daysRemaining = null;
    if (r.expiration_date) {
      const d = new Date(r.expiration_date);
      expiryDate = d.toISOString();
      daysRemaining = Math.ceil((d.getTime() - Date.now()) / 86400000);
    }
    return { name: r.name, group: r.group || null, system: r.system, expiryDate, daysRemaining };
  });
}

// Namecheap domain list — synced locally by the user (Namecheap's API requires a whitelisted
// IP, which Vercel's serverless functions don't have a static one for), see
// scripts/sync_namecheap.js and namecheap.html. Lives in Supabase (Postgres), not the
// MySQL DB the rest of this file uses — the MySQL account available to this app has no
// CREATE TABLE privilege, and Supabase is where new tables like this one go from now on.
// Multiple Namecheap accounts can land in this same table, each tagged with its own
// account_label.
async function fetchNamecheapDomains() {
  const rows = await supabaseSelect('namecheap_domains', 'select=account_label,name,expiration_date,created_date,auto_renew,is_locked,whois_guard,updated_at');
  return rows.map(r => {
    let expiryDate = null, daysRemaining = null;
    if (r.expiration_date) {
      const d = new Date(r.expiration_date);
      expiryDate = d.toISOString();
      daysRemaining = Math.ceil((d.getTime() - Date.now()) / 86400000);
    }
    return {
      accountLabel: r.account_label,
      domain: r.name,
      expiryDate,
      daysRemaining,
      createdDate: r.created_date ? new Date(r.created_date).toISOString() : null,
      autoRenew: !!r.auto_renew,
      isLocked: !!r.is_locked,
      whoisGuard: r.whois_guard || null,
      updatedAt: r.updated_at || null,
    };
  });
}

// This was the dominant source of Cloudflare API load — called once per matched zone
// (hundreds of them) on every single page load with no caching at all, which is what was
// actually tripping Cloudflare's rate limit (the zones-list call above is comparatively
// rare: once per account, not once per domain). Cache per zone with the same TTL pattern.
const aRecordsCache = new Map(); // zoneId -> { data, expiresAt }

async function fetchARecordsForZone(zoneId, token) {
  const cached = aRecordsCache.get(zoneId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  try {
    const records = [];
    let page = 1;
    while (true) {
      const data = await fetchCfJson(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&per_page=100&page=${page}`, token);
      records.push(...data.result);
      const totalPages = data.result_info?.total_pages || 1;
      if (page >= totalPages) break;
      page++;
    }
    aRecordsCache.set(zoneId, { data: records, expiresAt: Date.now() + ZONES_CACHE_TTL_MS });
    return records;
  } catch (err) {
    if (cached) return cached.data; // stale beats a hard failure for this one zone
    throw err;
  }
}

function isoDate(d){ return d.toISOString().slice(0, 10); }

// Cloudflare's GraphQL Analytics API caps zoneTag_in filters at 10 zones per query
// (empirically verified — 11+ returns "too many zones requested").
const MAX_ZONES_PER_ANALYTICS_QUERY = 10;

// Batched 7-day daily requests series for up to 10 zones on the SAME account/token at once —
// used to build the traffic drop/stop overview without needing one query per domain.
async function fetchBatchTrafficSeries(token, zoneIds) {
  if (!zoneIds.length) return {};
  if (zoneIds.length > MAX_ZONES_PER_ANALYTICS_QUERY) throw new Error('Too many zones in one batch');
  const now = new Date();
  const from = new Date(now.getTime() - 7 * 86400000);
  const query = `query {
    viewer {
      zones(filter: {zoneTag_in: [${zoneIds.map(id => `"${id}"`).join(',')}]}) {
        zoneTag
        httpRequests1dGroups(limit: 7, filter: {date_geq: "${isoDate(from)}", date_leq: "${isoDate(now)}"}, orderBy: [date_ASC]) {
          dimensions { date }
          sum { requests }
        }
      }
    }
  }`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (data.errors && data.errors.length) {
    const msg = data.errors[0].message || 'Analytics error';
    const err = new Error(msg);
    err.noPermission = /permission/i.test(msg);
    throw err;
  }
  const byZone = {};
  for (const z of data.data?.viewer?.zones || []) {
    byZone[z.zoneTag] = (z.httpRequests1dGroups || []).map(g => ({ label: g.dimensions.date, requests: g.sum.requests }));
  }
  return byZone;
}

// Classify a 7-day daily series into ok / drop / stopped, comparing the most recent
// FULL day against the one before it (today is partial and would look like a false drop).
function classifyTraffic(series) {
  if (series.length < 2) return { status: 'unknown', pctChange: null };
  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  if (prev.requests === 0) return { status: 'unknown', pctChange: null };
  const pctChange = Math.round(((last.requests - prev.requests) / prev.requests) * 100);
  if (last.requests === 0 && prev.requests > 10) return { status: 'stopped', pctChange: -100 };
  if (pctChange <= -50) return { status: 'drop', pctChange };
  return { status: 'ok', pctChange };
}

async function fetchRequestsAnalytics(zone, range) {
  const now = new Date();
  let query, extract;
  if (range === '24h') {
    const from = new Date(now.getTime() - 24 * 3600 * 1000);
    query = `query {
      viewer {
        zones(filter: {zoneTag: "${zone.id}"}) {
          httpRequests1hGroups(limit: 24, filter: {datetime_geq: "${from.toISOString()}", datetime_leq: "${now.toISOString()}"}, orderBy: [datetime_ASC]) {
            dimensions { datetime }
            sum { requests }
            uniq { uniques }
          }
        }
      }
    }`;
    extract = data => (data?.viewer?.zones?.[0]?.httpRequests1hGroups || []).map(g => ({
      label: g.dimensions.datetime, requests: g.sum.requests, uniques: g.uniq.uniques,
    }));
  } else {
    const days = range === '30d' ? 30 : 7;
    const from = new Date(now.getTime() - days * 86400000);
    query = `query {
      viewer {
        zones(filter: {zoneTag: "${zone.id}"}) {
          httpRequests1dGroups(limit: ${days}, filter: {date_geq: "${isoDate(from)}", date_leq: "${isoDate(now)}"}, orderBy: [date_ASC]) {
            dimensions { date }
            sum { requests }
            uniq { uniques }
          }
        }
      }
    }`;
    extract = data => (data?.viewer?.zones?.[0]?.httpRequests1dGroups || []).map(g => ({
      label: g.dimensions.date, requests: g.sum.requests, uniques: g.uniq.uniques,
    }));
  }

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${zone.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (data.errors && data.errors.length) {
    const msg = data.errors[0].message || 'Analytics error';
    const noPermission = /permission/i.test(msg);
    const err = new Error(msg);
    err.noPermission = noPermission;
    throw err;
  }
  return extract(data.data);
}

async function checkHttp(domain) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`https://${domain}/lander/curll/ok.html`, {
      headers: { 'User-Agent': CHROME_UA },
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = await res.text().catch(() => '');
    if (res.status === 200 && body.includes('Live!!!')) return { httpStatus: 'live', httpCode: 200 };
    if (res.status === 200) return { httpStatus: 'no-live', httpCode: 200 };
    return { httpStatus: 'error-code', httpCode: res.status };
  } catch {
    return { httpStatus: 'error', httpCode: null };
  } finally {
    clearTimeout(timer);
  }
}

// Domain registration expiry via RDAP (the modern, standardized successor to WHOIS) — a free
// public JSON API, no API key or IP whitelist needed (unlike the Namecheap API). rdap.org acts
// as a bootstrap redirector to the right registry (Verisign for .com, etc.) per TLD. It sits
// behind Cloudflare bot protection itself, so it needs the same Chrome User-Agent trick as the
// domain liveness check above.
async function fetchExpiry(domain) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { Accept: 'application/rdap+json', 'User-Agent': CHROME_UA },
      signal: controller.signal,
    });
    if (!res.ok) return { expiryDate: null, daysRemaining: null };
    const data = await res.json();
    const expEvent = (data.events || []).find(e => e.eventAction === 'expiration');
    if (!expEvent) return { expiryDate: null, daysRemaining: null };
    const daysRemaining = Math.ceil((new Date(expEvent.eventDate).getTime() - Date.now()) / 86400000);
    return { expiryDate: expEvent.eventDate, daysRemaining };
  } catch {
    return { expiryDate: null, daysRemaining: null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkToken(req, res)) return;

  try {
    if (req.method === 'POST' && req.body?.mode === 'traffic') {
      // Batched 7-day traffic series + drop/stop classification for up to 10 zones on the
      // SAME Cloudflare account at once (Cloudflare's own query limit — see constant above).
      const accountIndex = Number(req.body.accountIndex);
      const zoneIds = Array.isArray(req.body.zoneIds) ? req.body.zoneIds.slice(0, MAX_ZONES_PER_ANALYTICS_QUERY) : [];
      const tokens = getCfTokens();
      const token = tokens[accountIndex];
      if (!token || !zoneIds.length) { res.status(400).json({ error: 'INVALID_BATCH' }); return; }
      try {
        const byZone = await fetchBatchTrafficSeries(token, zoneIds);
        const results = zoneIds.map(zoneId => {
          const series = byZone[zoneId] || [];
          return { zoneId, series, ...classifyTraffic(series) };
        });
        res.status(200).json({ results });
      } catch (err) {
        if (err.noPermission) { res.status(200).json({ results: [], noPermission: true }); return; }
        throw err;
      }
      return;
    }

    if (req.method === 'POST' && req.body?.mode === 'whois') {
      // Batch domain expiry lookup via RDAP, same chunking approach as the HTTP check below.
      const domains = Array.isArray(req.body.domains) ? req.body.domains.slice(0, 30) : [];
      const results = await Promise.all(domains.map(async d => ({ domain: d, ...(await fetchExpiry(d)) })));
      res.status(200).json({ results });
      return;
    }

    if (req.method === 'POST') {
      // Batch HTTP liveness check for a small list of domains. The client sends domains
      // in chunks (~25 at a time) so each call stays well within the serverless time limit,
      // regardless of total domain count.
      const domains = Array.isArray(req.body?.domains) ? req.body.domains.slice(0, 30) : [];
      const results = await Promise.all(domains.map(async d => ({ domain: d, ...(await checkHttp(d)) })));
      res.status(200).json({ results });
      return;
    }

    if (req.query.mode === 'analytics') {
      // On-demand Total Requests time series for a single domain — not fetched for all
      // domains up front (too slow/rate-limit-prone for hundreds of zones).
      const domainName = (req.query.domain || '').toString();
      const range = ['24h', '7d', '30d'].includes(req.query.range) ? req.query.range : '7d';
      if (!domainName) { res.status(400).json({ error: 'MISSING_DOMAIN' }); return; }
      const zones = await fetchAllZones();
      const zone = findZoneForDomain(domainName, zones);
      if (!zone) { res.status(404).json({ error: 'ZONE_NOT_FOUND' }); return; }
      try {
        const series = await fetchRequestsAnalytics(zone, range);
        res.status(200).json({ domain: domainName, zoneName: zone.name, accountLabel: zone.accountLabel, range, series });
      } catch (err) {
        if (err.noPermission) {
          res.status(200).json({ domain: domainName, zoneName: zone.name, accountLabel: zone.accountLabel, range, series: [], noPermission: true });
          return;
        }
        throw err;
      }
      return;
    }

    // source=namecheap is a plain domain + registrar-expiry list, no Cloudflare/Keitaro
    // matching involved at all — short-circuit before the DNS-matching logic below.
    if (req.query.source === 'namecheap') {
      const domains = await fetchNamecheapDomains();
      res.status(200).json({ generatedAt: new Date().toISOString(), domains });
      return;
    }

    // GET: domains matched against Cloudflare DNS — fast, no live HTTP probing.
    // source=db reads the domain list (and pre-computed expiry) from keitaro_domain_media
    // instead of calling the live Keitaro production API — see keitaro_domains.html.
    const useDbSource = req.query.source === 'db';
    const [rawDomains, zones] = await Promise.all([
      useDbSource ? fetchDomainsFromDb() : fetchKeitaroDomains(),
      fetchAllZones(),
    ]);

    const matched = rawDomains.map(d => {
      const name = d.name || d.domain || '';
      return {
        name,
        group: d.group || null,
        system: d.system || null,
        expiryDate: d.expiryDate ?? null,
        daysRemaining: d.daysRemaining ?? null,
        zone: findZoneForDomain(name, zones),
      };
    });

    // Only fetch A records for zones that are actually matched to a Keitaro domain.
    const neededZones = new Map();
    for (const m of matched) {
      if (m.zone && !neededZones.has(m.zone.id)) neededZones.set(m.zone.id, m.zone);
    }
    const zoneRecords = new Map();
    await Promise.all(Array.from(neededZones.values()).map(async z => {
      // One zone erroring (e.g. a fresh, uncached zone during a Cloudflare rate-limit
      // window) shouldn't 500 the whole page — just leave that zone's records empty, it
      // falls back to "No A record" in the UI instead of taking the other 600+ down with it.
      try {
        zoneRecords.set(z.id, await fetchARecordsForZone(z.id, z.token));
      } catch (err) {
        console.error(`A record fetch failed for zone ${z.name}:`, err.message);
        zoneRecords.set(z.id, []);
      }
    }));

    const domains = matched.map(m => {
      const expiry = { expiryDate: m.expiryDate, daysRemaining: m.daysRemaining };
      if (!m.zone) {
        return { domain: m.name, group: m.group, system: m.system, aRecords: [], proxied: null, dnsStatus: 'not-in-cf', zoneName: null, accountLabel: null, zoneId: null, accountIndex: null, ...expiry };
      }
      const records = (zoneRecords.get(m.zone.id) || []).filter(r => r.name.toLowerCase() === m.name.toLowerCase());
      if (!records.length) {
        return { domain: m.name, group: m.group, system: m.system, aRecords: [], proxied: null, dnsStatus: 'no-record', zoneName: m.zone.name, accountLabel: m.zone.accountLabel, zoneId: m.zone.id, accountIndex: m.zone.accountIndex, ...expiry };
      }
      const proxied = records.some(r => r.proxied);
      return {
        domain: m.name,
        group: m.group,
        system: m.system,
        aRecords: records.map(r => r.content),
        proxied,
        dnsStatus: proxied ? 'proxied' : 'direct',
        zoneName: m.zone.name,
        accountLabel: m.zone.accountLabel,
        zoneId: m.zone.id,
        accountIndex: m.zone.accountIndex,
        ...expiry,
      };
    });

    res.status(200).json({ generatedAt: new Date().toISOString(), accountLabels: getCfAccountLabels(), domains });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};
