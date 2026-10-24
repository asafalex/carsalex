const { getPool, checkScopedToken, setCors } = require('./_db');
const RT_GROUPS = require('./_rt_groups');

function parseDate(v, fallback) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
}

function groupSum(rows, keyFn, extra) {
  const map = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    const k = key == null ? 'null' : String(key);
    let row = map.get(k);
    if (!row) { row = { regs: 0, ftds: 0 }; if (extra) extra(row, r); map.set(k, row); }
    row.regs += Number(r.regs) || 0;
    row.ftds += Number(r.ftds) || 0;
  }
  return Array.from(map.values());
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

  const countryCode = req.query.countryCode || null;
  const groupName = req.query.groupName || null;
  const rtPlaceholders = RT_GROUPS.map(() => '?').join(',');
  // Opt-in per request (mirrors keitaro-regftd.js): source Reg/FTD from
  // keitaro_conversions_report instead of keitaro_conversions_daily.
  const useReportTable = req.query.source === 'report';

  const clickConditions = ['ck.date BETWEEN ? AND ?'];
  const clickParams = [from, to];
  if (scope === 'rt') { clickConditions.push(`dg.name IN (${rtPlaceholders})`); clickParams.push(...RT_GROUPS); }
  if (countryCode) { clickConditions.push('ck.country_code = ?'); clickParams.push(countryCode); }
  if (groupName) { clickConditions.push('dg.name = ?'); clickParams.push(groupName); }
  const clickWhere = clickConditions.join(' AND ');
  const clickJoins = 'LEFT JOIN dev_groups dg ON dg.id = ck.campaign_group_id';

  try {
    const db = getPool();

    if (useReportTable) {
      // keitaro_conversions_report has no group_id of its own — resolve it via a single
      // (date-bounded, scope-restricted) lookup against clicks_keitaro by campaign_id,
      // then do the group aggregation in JS. See keitaro-regftd.js for why: repeating this
      // lookup per-query was the dominant cost (~70-90s) before this pattern was introduced.
      const reportConditions = ['date BETWEEN ? AND ?'];
      const reportParams = [from, to];
      if (countryCode) { reportConditions.push('country_code = ?'); reportParams.push(countryCode); }
      const reportWhere = reportConditions.join(' AND ');

      const lookupConditions = ['date BETWEEN ? AND ?'];
      const lookupParams = [from, to];
      if (scope === 'rt') {
        lookupConditions.push(`campaign_group_id IN (SELECT id FROM dev_groups WHERE name IN (${rtPlaceholders}))`);
        lookupParams.push(...RT_GROUPS);
      }
      if (groupName) {
        lookupConditions.push('campaign_group_id IN (SELECT id FROM dev_groups WHERE name = ?)');
        lookupParams.push(groupName);
      }
      const lookupWhere = lookupConditions.join(' AND ');

      const [
        [[clickTotals]],
        [clicksByOffer],
        [clicksByCountry],
        [clicksByGroup],
        [rows],
        [offerNameRows],
        [campaignLookupRows],
        [groupRows],
      ] = await Promise.all([
        db.query(
          `SELECT COALESCE(SUM(ck.click_amount),0) AS clicks, COALESCE(SUM(ck.unique_click_amount),0) AS unique_clicks
           FROM clicks_keitaro ck ${clickJoins} WHERE ${clickWhere}`, clickParams),

        db.query(
          `SELECT ck.offer_id, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
           FROM clicks_keitaro ck ${clickJoins} WHERE ${clickWhere}
           GROUP BY ck.offer_id`, clickParams),

        db.query(
          `SELECT ck.country_code, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
           FROM clicks_keitaro ck ${clickJoins} WHERE ${clickWhere}
           GROUP BY ck.country_code`, clickParams),

        db.query(
          `SELECT ck.campaign_group_id, dg.name AS group_name, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
           FROM clicks_keitaro ck ${clickJoins} WHERE ${clickWhere}
           GROUP BY ck.campaign_group_id, dg.name`, clickParams),

        db.query(
          `SELECT campaign_id, offer_id, country_code, SUM(conversion) AS regs, SUM(sale) AS ftds
           FROM keitaro_conversions_report WHERE ${reportWhere}
           GROUP BY campaign_id, offer_id, country_code`, reportParams),

        db.query(
          `SELECT offer_id, MAX(offer) AS offer_name
           FROM keitaro_conversions_report WHERE ${reportWhere}
           GROUP BY offer_id`, reportParams),

        db.query(
          `SELECT campaign_id, MAX(campaign_group_id) AS group_id
           FROM clicks_keitaro WHERE ${lookupWhere}
           GROUP BY campaign_id`, lookupParams),

        db.query(`SELECT id, name FROM dev_groups`),
      ]);

      const campaignLookup = new Map(campaignLookupRows.map(r => [r.campaign_id, r]));
      const offerNames = new Map(offerNameRows.map(r => [r.offer_id, r.offer_name]));
      const groupNames = new Map(groupRows.map(r => [r.id, r.name]));

      const isRestricted = scope === 'rt' || !!groupName;
      const filteredRows = isRestricted ? rows.filter(r => campaignLookup.has(r.campaign_id)) : rows;

      const convTotals = filteredRows.reduce((acc, r) => {
        acc.regs += Number(r.regs) || 0;
        acc.ftds += Number(r.ftds) || 0;
        return acc;
      }, { regs: 0, ftds: 0 });

      const convByOffer = groupSum(filteredRows, r => r.offer_id, (row, r) => {
        row.offer_id = r.offer_id;
        row.offer_name = offerNames.get(r.offer_id) || null;
      });

      const convByCountry = groupSum(filteredRows, r => r.country_code, (row, r) => {
        row.country = r.country_code;
      });

      const convByGroup = groupSum(filteredRows, r => campaignLookup.get(r.campaign_id)?.group_id, (row, r) => {
        const groupId = campaignLookup.get(r.campaign_id)?.group_id ?? null;
        row.group_id = groupId;
        row.group_name = groupId != null ? (groupNames.get(groupId) || null) : null;
      });

      res.status(200).json({
        scope, from, to,
        totals: { clicks: clickTotals.clicks, unique_clicks: clickTotals.unique_clicks, regs: convTotals.regs, ftds: convTotals.ftds },
        clicksByOffer, convByOffer,
        clicksByCountry, convByCountry,
        clicksByGroup, convByGroup,
      });
      return;
    }

    const convConditions = ['kcd.date BETWEEN ? AND ?'];
    const convParams = [from, to];
    if (scope === 'rt') { convConditions.push(`dg2.name IN (${rtPlaceholders})`); convParams.push(...RT_GROUPS); }
    if (countryCode) { convConditions.push('kcd.country = ?'); convParams.push(countryCode); }
    if (groupName) { convConditions.push('dg2.name = ?'); convParams.push(groupName); }
    const convWhere = convConditions.join(' AND ');
    const convJoins = 'LEFT JOIN dev_groups dg2 ON dg2.id = kcd.group_id';

    const REG_FTD_SUM = `SUM(CASE WHEN kcd.operation='lead' THEN kcd.amount ELSE 0 END) AS regs,
         SUM(CASE WHEN kcd.operation='sale' THEN kcd.amount ELSE 0 END) AS ftds`;

    // All 8 queries are independent — run them concurrently instead of one-at-a-time
    // so total latency is ~max(query time), not sum(query time).
    const [
      [[clickTotals]],
      [[convTotals]],
      [clicksByOffer],
      [convByOffer],
      [clicksByCountry],
      [convByCountry],
      [clicksByGroup],
      [convByGroup],
    ] = await Promise.all([
      db.query(
        `SELECT COALESCE(SUM(ck.click_amount),0) AS clicks, COALESCE(SUM(ck.unique_click_amount),0) AS unique_clicks
         FROM clicks_keitaro ck ${clickJoins} WHERE ${clickWhere}`, clickParams),

      db.query(
        `SELECT ${REG_FTD_SUM} FROM keitaro_conversions_daily kcd ${convJoins} WHERE ${convWhere}`, convParams),

      db.query(
        `SELECT ck.offer_id, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${clickJoins} WHERE ${clickWhere}
         GROUP BY ck.offer_id`, clickParams),

      db.query(
        `SELECT kcd.offer_id, MAX(kcd.offer) AS offer_name, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${convJoins} WHERE ${convWhere}
         GROUP BY kcd.offer_id`, convParams),

      db.query(
        `SELECT ck.country_code, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${clickJoins} WHERE ${clickWhere}
         GROUP BY ck.country_code`, clickParams),

      db.query(
        `SELECT kcd.country, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${convJoins} WHERE ${convWhere}
         GROUP BY kcd.country`, convParams),

      db.query(
        `SELECT ck.campaign_group_id, dg.name AS group_name, SUM(ck.click_amount) AS clicks, SUM(ck.unique_click_amount) AS unique_clicks
         FROM clicks_keitaro ck ${clickJoins} WHERE ${clickWhere}
         GROUP BY ck.campaign_group_id, dg.name`, clickParams),

      db.query(
        `SELECT kcd.group_id, dg2.name AS group_name, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${convJoins} WHERE ${convWhere}
         GROUP BY kcd.group_id, dg2.name`, convParams),
    ]);

    res.status(200).json({
      scope, from, to,
      totals: { clicks: clickTotals.clicks, unique_clicks: clickTotals.unique_clicks, regs: convTotals.regs, ftds: convTotals.ftds },
      clicksByOffer, convByOffer,
      clicksByCountry, convByCountry,
      clicksByGroup, convByGroup,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
