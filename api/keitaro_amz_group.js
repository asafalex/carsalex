const { checkToken, setCors } = require('./_db');

// All campaigns from the live "amz" Keitaro system (the main KEITARO_API_URL account — as
// opposed to keitaro_domain_media's separate system). Each campaign record already carries
// its own domain and group, and a created_at timestamp, so no DB join is needed here.
let campaignsCache = { data: null, expiresAt: 0 };
const CAMPAIGNS_CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchCampaigns() {
  if (campaignsCache.data && Date.now() < campaignsCache.expiresAt) {
    return campaignsCache.data;
  }
  const url = `${process.env.KEITARO_API_URL}/admin_api/v1/campaigns`;
  const res = await fetch(url, { headers: { 'Api-Key': process.env.KEITARO_API_KEY } });
  if (!res.ok) throw new Error(`Keitaro API error ${res.status}`);
  const data = await res.json();
  const campaigns = Array.isArray(data) ? data : (data.data || []);
  campaignsCache = { data: campaigns, expiresAt: Date.now() + CAMPAIGNS_CACHE_TTL_MS };
  return campaigns;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkToken(req, res)) return;

  try {
    const campaigns = await fetchCampaigns();
    const weekAgo = Date.now() - 7 * 86400000;

    const byGroup = new Map(); // group label -> { domains: Set, total: 0, thisWeek: 0 }
    for (const c of campaigns) {
      const groupLabel = c.group || 'No group';
      if (!byGroup.has(groupLabel)) byGroup.set(groupLabel, { domains: new Set(), total: 0, thisWeek: 0 });
      const g = byGroup.get(groupLabel);
      if (c.domain) g.domains.add(c.domain);
      g.total += 1;
      const createdAt = c.created_at ? new Date(c.created_at.replace(' ', 'T') + 'Z').getTime() : null;
      if (createdAt && createdAt >= weekAgo) g.thisWeek += 1;
    }

    const groups = Array.from(byGroup.entries()).map(([group, g]) => ({
      group,
      domainCount: g.domains.size,
      totalCampaigns: g.total,
      campaignsThisWeek: g.thisWeek,
    })).sort((a, b) => b.totalCampaigns - a.totalCampaigns);

    res.status(200).json({ generatedAt: new Date().toISOString(), groups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};
