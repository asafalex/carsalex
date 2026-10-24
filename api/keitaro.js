const { getPool, checkScopedToken, setCors } = require('./_db');
const BRAND_NAMES = require('./_brand_names');
const RT_GROUPS = require('./_rt_groups');

function parseDate(v, fallback) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const scope = checkScopedToken(req, res);
  if (!scope) return;

  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const from = parseDate(req.query.from, monthAgo);
  const to = parseDate(req.query.to, today);

  const campaignName = req.query.campaignName || null;
  const groupName = req.query.groupName || null;
  const countryCode = req.query.countryCode || null;
  const offerId = req.query.offerId || null;

  const conditions = ['ck.date BETWEEN ? AND ?'];
  const params = [from, to];
  if (scope === 'rt') {
    const rtPlaceholders = RT_GROUPS.map(() => '?').join(',');
    conditions.push(`dg.name IN (${rtPlaceholders})`);
    params.push(...RT_GROUPS);
  }
  if (campaignName) { conditions.push('ck.campaign_name = ?'); params.push(campaignName); }
  if (countryCode) { conditions.push('ck.country_code = ?'); params.push(countryCode); }
  if (groupName) { conditions.push('dg.name = ?'); params.push(groupName); }
  if (offerId) { conditions.push('ck.offer_id = ?'); params.push(offerId); }
  const where = conditions.join(' AND ');
  const joins = 'LEFT JOIN dev_groups dg ON dg.id = ck.campaign_group_id LEFT JOIN keitaro_flow kf ON kf.id = ck.flow_id';

  try {
    const db = getPool();

    // All 9 queries are independent (same WHERE, different GROUP BY) — run them concurrently
    // instead of one-at-a-time so total latency is ~max(query time), not sum(query time).
    const [
      [[totals]],
      [byDate],
      [byCampaign],
      [byFlow],
      [byGroup],
      [byCountry],
      [byOffer],
      [byBrandRaw],
      [byGroupDate],
    ] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(ck.click_amount),0) AS clicks,
                COALESCE(SUM(ck.unique_click_amount),0) AS unique_clicks,
                COUNT(DISTINCT ck.campaign_id) AS campaigns
         FROM clicks_keitaro ck ${joins} WHERE ${where}`, params),

      db.query(
        `SELECT DATE_FORMAT(ck.date, '%Y-%m-%d') AS date, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${joins} WHERE ${where}
         GROUP BY ck.date ORDER BY ck.date`, params),

      db.query(
        `SELECT ck.campaign_id, ck.campaign_name, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${joins} WHERE ${where}
         GROUP BY ck.campaign_id, ck.campaign_name ORDER BY clicks DESC LIMIT 50`, params),

      db.query(
        `SELECT ck.flow_id, kf.name AS flow_name, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${joins} WHERE ${where}
         GROUP BY ck.flow_id, kf.name ORDER BY clicks DESC LIMIT 50`, params),

      db.query(
        `SELECT ck.campaign_group_id, dg.name AS group_name, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${joins} WHERE ${where}
         GROUP BY ck.campaign_group_id, dg.name ORDER BY clicks DESC LIMIT 50`, params),

      db.query(
        `SELECT ck.country_code, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${joins} WHERE ${where}
         GROUP BY ck.country_code ORDER BY clicks DESC LIMIT 50`, params),

      db.query(
        `SELECT ck.offer_id, ofn.offer_name, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${joins}
         LEFT JOIN (SELECT offer_id, MAX(offer) AS offer_name FROM keitaro_conversions_daily GROUP BY offer_id) ofn ON ofn.offer_id = ck.offer_id
         WHERE ${where}
         GROUP BY ck.offer_id, ofn.offer_name ORDER BY clicks DESC LIMIT 50`, params),

      db.query(
        `SELECT ck.brand_id, b.name AS brand_name, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${joins}
         LEFT JOIN brands b ON b.id = ck.brand_id
         WHERE ${where}
         GROUP BY ck.brand_id, b.name ORDER BY clicks DESC LIMIT 50`, params),

      db.query(
        `SELECT DATE_FORMAT(ck.date, '%Y-%m-%d') AS date, ck.campaign_group_id, dg.name AS group_name,
                SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${joins} WHERE ${where}
         GROUP BY ck.date, ck.campaign_group_id, dg.name ORDER BY ck.date`, params),
    ]);

    const byBrand = byBrandRaw.map(r => ({ ...r, brand_name: BRAND_NAMES[r.brand_id] || r.brand_name || null }));

    res.status(200).json({ scope, from, to, totals, byDate, byCampaign, byFlow, byGroup, byCountry, byOffer, byBrand, byGroupDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
