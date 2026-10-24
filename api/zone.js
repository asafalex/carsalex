const { checkToken, setCors, getPool } = require('./_db');
const { CHROME_UA, fetchAllZones } = require('./_cf');

// Full records (not just names) from both Keitaro-sync tables (see api/domains.js for the
// same two-table setup), keyed by lowercased name — used both to determine which zones are
// untracked, and to attach group/expiry/campaign info to a zone in the rare case a direct
// name match exists despite not being filtered out as "tracked" (e.g. a zone whose own name
// is tracked but only via a subdomain relationship, not an exact match).
async function fetchTrackedDomainRecords() {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT name, \`group\`, expiration_date, campaigns_count FROM keitaro_domain
     UNION ALL
     SELECT name, NULL AS \`group\`, expiration_date, campaigns_count FROM keitaro_domain_media`
  );
  const map = new Map();
  for (const r of rows) {
    let expiryDate = null, daysRemaining = null;
    if (r.expiration_date) {
      const d = new Date(r.expiration_date);
      expiryDate = d.toISOString();
      daysRemaining = Math.ceil((d.getTime() - Date.now()) / 86400000);
    }
    map.set(r.name.toLowerCase(), { group: r.group || null, expiryDate, daysRemaining, campaignsCount: r.campaigns_count ?? null });
  }
  return map;
}

// A zone counts as "tracked" if any tracked domain name equals the zone name or is a
// subdomain of it (mirrors the longest-suffix match used the other way around in
// api/domains.js's findZoneForDomain).
function isZoneTracked(zoneName, trackedNames) {
  const zn = zoneName.toLowerCase();
  if (trackedNames.has(zn)) return true;
  for (const name of trackedNames) {
    if (name.endsWith('.' + zn)) return true;
  }
  return false;
}

async function checkUrl(url, redirect = 'follow') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, redirect, signal: controller.signal });
    return { code: res.status, error: false };
  } catch {
    return { code: null, error: true };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkToken(req, res)) return;

  try {
    if (req.method === 'POST') {
      // Batch HTTP check for a small list of zone names (chunked client-side, same pattern
      // as api/domains.js): one request to /index.html, one to the domain root, each just
      // reporting the raw HTTP status code.
      const zoneNames = Array.isArray(req.body?.zones) ? req.body.zones.slice(0, 30) : [];
      const results = await Promise.all(zoneNames.map(async name => {
        const [indexRes, rootRes, firstRootRes] = await Promise.all([
          checkUrl(`https://${name}/index.html`),
          checkUrl(`https://${name}/`),
          // Same root URL, but redirect: 'manual' so we capture the very first response
          // code (e.g. a 301 redirect) instead of the final one after redirects resolve.
          checkUrl(`http://${name}/`, 'manual'),
        ]);
        return {
          zone: name,
          indexCode: indexRes.code, indexError: indexRes.error,
          rootCode: rootRes.code, rootError: rootRes.error,
          firstRootCode: firstRootRes.code, firstRootError: firstRootRes.error,
        };
      }));
      res.status(200).json({ results });
      return;
    }

    // GET: Cloudflare zones (across all accounts) that have no matching record in either
    // Keitaro-sync table — an audit view to catch domains that exist in Cloudflare but
    // aren't tracked anywhere on the Keitaro side.
    const [zones, trackedRecords] = await Promise.all([fetchAllZones(), fetchTrackedDomainRecords()]);
    const trackedNames = new Set(trackedRecords.keys());
    const orphaned = zones
      .filter(z => !isZoneTracked(z.name, trackedNames))
      .map(z => {
        const rec = trackedRecords.get(z.name.toLowerCase()) || {};
        return {
          zone: z.name,
          accountLabel: z.accountLabel,
          accountIndex: z.accountIndex,
          group: rec.group || null,
          expiryDate: rec.expiryDate || null,
          daysRemaining: rec.daysRemaining ?? null,
          campaignsCount: rec.campaignsCount ?? null,
        };
      });

    // So the "Total Domains" stat can update when the UI's account filter changes, not
    // just show one fixed global number regardless of the selected account.
    const totalZonesByAccount = {};
    for (const z of zones) {
      totalZonesByAccount[z.accountLabel] = (totalZonesByAccount[z.accountLabel] || 0) + 1;
    }

    res.status(200).json({ generatedAt: new Date().toISOString(), totalZones: zones.length, totalZonesByAccount, zones: orphaned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};
