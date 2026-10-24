const { getPool, checkScopedToken, setCors } = require('./_db');
const RT_GROUPS = require('./_rt_groups');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const scope = checkScopedToken(req, res);
  if (!scope) return;

  const rtPlaceholders = RT_GROUPS.map(() => '?').join(',');

  try {
    const db = getPool();

    if (scope === 'rt') {
      const [campaigns] = await db.query(
        `SELECT DISTINCT ck.campaign_name FROM clicks_keitaro ck
         LEFT JOIN dev_groups dg ON dg.id = ck.campaign_group_id
         WHERE ck.campaign_name IS NOT NULL AND ck.campaign_name <> '' AND dg.name IN (${rtPlaceholders})
         ORDER BY ck.campaign_name LIMIT 3000`, RT_GROUPS);

      const [countries] = await db.query(
        `SELECT DISTINCT ck.country_code FROM clicks_keitaro ck
         LEFT JOIN dev_groups dg ON dg.id = ck.campaign_group_id
         WHERE ck.country_code IS NOT NULL AND ck.country_code <> '' AND dg.name IN (${rtPlaceholders})
         ORDER BY ck.country_code LIMIT 500`, RT_GROUPS);

      const [offers] = await db.query(
        `SELECT DISTINCT ck.offer_id FROM clicks_keitaro ck
         LEFT JOIN dev_groups dg ON dg.id = ck.campaign_group_id
         WHERE ck.offer_id IS NOT NULL AND dg.name IN (${rtPlaceholders})
         ORDER BY ck.offer_id LIMIT 2000`, RT_GROUPS);

      const [groups] = await db.query(
        `SELECT name FROM dev_groups WHERE name IN (${rtPlaceholders}) ORDER BY name`, RT_GROUPS);

      res.status(200).json({
        scope,
        campaigns: campaigns.map(r => r.campaign_name),
        groups: groups.map(r => r.name),
        countries: countries.map(r => r.country_code),
        offers: offers.map(r => String(r.offer_id)),
      });
      return;
    }

    const [campaigns] = await db.query(
      `SELECT DISTINCT campaign_name FROM clicks_keitaro
       WHERE campaign_name IS NOT NULL AND campaign_name <> ''
       ORDER BY campaign_name LIMIT 3000`);

    const [groups] = await db.query(
      `SELECT name FROM dev_groups WHERE name IS NOT NULL AND name <> '' ORDER BY name LIMIT 2000`);

    const [countries] = await db.query(
      `SELECT DISTINCT country_code FROM clicks_keitaro
       WHERE country_code IS NOT NULL AND country_code <> ''
       ORDER BY country_code LIMIT 500`);

    const [offers] = await db.query(
      `SELECT DISTINCT offer_id FROM clicks_keitaro
       WHERE offer_id IS NOT NULL
       ORDER BY offer_id LIMIT 2000`);

    res.status(200).json({
      scope,
      campaigns: campaigns.map(r => r.campaign_name),
      groups: groups.map(r => r.name),
      countries: countries.map(r => r.country_code),
      offers: offers.map(r => String(r.offer_id)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
