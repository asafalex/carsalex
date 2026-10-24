// Shared Cloudflare zone-listing helpers, used by both api/domains.js and api/zone.js.
// Keeping this in one place matters: the rate-limit/retry/caching behavior here was tuned
// after a real incident (Cloudflare throttled us when the zone list was refetched on every
// page load with no caching) — duplicating it per-file would risk fixing it in one place
// and not the other next time.

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function getCfTokens() {
  return (process.env.CF_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);
}

// Parallel list to CF_TOKENS, same order — a friendly label per Cloudflare account, so the
// UI can show/filter by account without ever exposing the token itself to the client.
function getCfAccountLabels() {
  return (process.env.CF_ACCOUNT_LABELS || '').split(',').map(t => t.trim());
}

function getCfTokensWithLabels() {
  const tokens = getCfTokens();
  const labels = getCfAccountLabels();
  return tokens.map((token, i) => ({ token, label: labels[i] || `Account ${i + 1}` }));
}

// Cloudflare returns rate-limit errors in a few different shapes (a JSON body with
// success:false, or sometimes a non-2xx status with an empty/non-JSON body that throws on
// .json()) — retry with backoff on either case before giving up, rather than failing the
// whole page load on a single transient 429.
async function fetchCfJson(url, token, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success === false) throw new Error('Cloudflare API error: ' + JSON.stringify(data.errors));
      return data;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
}

// Fetch page 1 first to learn total_pages, then fetch the rest concurrently instead of
// sequentially — with hundreds of zones on some accounts, sequential pagination alone
// was the dominant cost of this endpoint (~6s of a ~7.5s total).
async function fetchZonesForToken(token, label, accountIndex) {
  const firstData = await fetchCfJson(`https://api.cloudflare.com/client/v4/zones?per_page=50&page=1`, token);
  const toZone = z => ({ id: z.id, name: z.name, token, accountLabel: label, accountIndex });
  const zones = firstData.result.map(toZone);
  const totalPages = firstData.result_info?.total_pages || 1;
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => i + 2).map(async page => {
        const data = await fetchCfJson(`https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`, token);
        return data.result.map(toZone);
      })
    );
    zones.push(...rest.flat());
  }
  return zones;
}

// The zone list (500+ zones across 3 accounts, paginated) was being refetched from
// Cloudflare on every single page load of every domains page, which started tripping
// Cloudflare's own rate limit ("Please wait and consider throttling your request speed")
// under normal repeated use. Cache it in memory for a few minutes — serverless instances
// stay warm between requests on Vercel, so this meaningfully cuts duplicate zone calls.
let zonesCache = { data: null, expiresAt: 0 };
const ZONES_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchAllZones() {
  if (zonesCache.data && Date.now() < zonesCache.expiresAt) {
    return zonesCache.data;
  }
  try {
    const perToken = await Promise.all(getCfTokensWithLabels().map(({ token, label }, i) => fetchZonesForToken(token, label, i)));
    const zones = perToken.flat();
    zonesCache = { data: zones, expiresAt: Date.now() + ZONES_CACHE_TTL_MS };
    return zones;
  } catch (err) {
    // Even stale data beats a hard failure of the whole page when Cloudflare is
    // transiently rate-limiting or erroring.
    if (zonesCache.data) return zonesCache.data;
    throw err;
  }
}

// Longest-suffix match: "ads.example.com" matches zone "example.com".
function findZoneForDomain(domainName, zones) {
  const dn = domainName.toLowerCase();
  let best = null;
  for (const zone of zones) {
    const zn = zone.name.toLowerCase();
    if (dn === zn || dn.endsWith('.' + zn)) {
      if (!best || zn.length > best.name.length) best = zone;
    }
  }
  return best;
}

module.exports = {
  CHROME_UA,
  getCfTokens,
  getCfAccountLabels,
  getCfTokensWithLabels,
  fetchCfJson,
  fetchZonesForToken,
  fetchAllZones,
  findZoneForDomain,
  ZONES_CACHE_TTL_MS,
};
