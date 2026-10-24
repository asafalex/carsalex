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

  // Opt-in per request (keitaro-mbm.html only, for now): source Reg/FTD from
  // keitaro_conversions_report instead of keitaro_conversions_daily. That table has no
  // group_id/brand_id/flow_id of its own, so those are resolved via a read-only lookup
  // join against clicks_keitaro (by campaign_id) — the clicks query/endpoint itself is untouched.
  const useReportTable = req.query.source === 'report';

  try {
    const db = getPool();

    if (useReportTable) {
      // keitaro_conversions_report has no group_id/brand_id/flow_id of its own. Resolving
      // those per-row via a JOIN to clicks_keitaro (repeated across 9 parallel queries) was
      // the dominant cost of this endpoint (~70-90s): that lookup alone takes ~9s, and running
      // it 9x concurrently causes contention, not just 9x the base cost. Instead, run the
      // clicks_keitaro lookup ONCE, keep every query against keitaro_conversions_report itself
      // join-free (fast: ~100-200ms each), and do the group/brand/flow aggregation in JS.
      const reportConditions = ['date BETWEEN ? AND ?'];
      const reportParams = [from, to];
      if (campaignName) { reportConditions.push('campaign = ?'); reportParams.push(campaignName); }
      if (countryCode) { reportConditions.push('country_code = ?'); reportParams.push(countryCode); }
      if (offerId) { reportConditions.push('offer_id = ?'); reportParams.push(offerId); }
      const reportWhere = reportConditions.join(' AND ');

      // Resolve which campaign_ids are allowed, and their group/brand/flow, from clicks_keitaro
      // in a single pass. When scoped to RT groups or filtered by groupName, restrict this
      // lookup itself (making it faster, not slower) and propagate as a campaign_id allowlist.
      const lookupConditions = ['date BETWEEN ? AND ?'];
      const lookupParams = [from, to];
      if (scope === 'rt') {
        const rtPlaceholders = RT_GROUPS.map(() => '?').join(',');
        lookupConditions.push(`campaign_group_id IN (SELECT id FROM dev_groups WHERE name IN (${rtPlaceholders}))`);
        lookupParams.push(...RT_GROUPS);
      }
      if (groupName) {
        lookupConditions.push('campaign_group_id IN (SELECT id FROM dev_groups WHERE name = ?)');
        lookupParams.push(groupName);
      }
      const lookupWhere = lookupConditions.join(' AND ');

      const [
        [campaignDateRows],
        [campaignNameRows],
        [byCountry],
        [byOffer],
        [campaignLookupRows],
        [groupRows],
        [flowRows],
        [brandRows],
      ] = await Promise.all([
        db.query(
          `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, campaign_id, SUM(conversion) AS regs, SUM(sale) AS ftds
           FROM keitaro_conversions_report WHERE ${reportWhere}
           GROUP BY date, campaign_id`, reportParams),

        db.query(
          `SELECT campaign_id, MAX(campaign) AS campaign_name
           FROM keitaro_conversions_report WHERE ${reportWhere}
           GROUP BY campaign_id`, reportParams),

        db.query(
          `SELECT country_code AS country, SUM(conversion) AS regs, SUM(sale) AS ftds
           FROM keitaro_conversions_report WHERE ${reportWhere}
           GROUP BY country_code`, reportParams),

        db.query(
          `SELECT offer_id, MAX(offer) AS offer_name, SUM(conversion) AS regs, SUM(sale) AS ftds
           FROM keitaro_conversions_report WHERE ${reportWhere}
           GROUP BY offer_id`, reportParams),

        db.query(
          `SELECT campaign_id, MAX(campaign_group_id) AS group_id, MAX(brand_id) AS brand_id, MAX(flow_id) AS flow_id
           FROM clicks_keitaro WHERE ${lookupWhere}
           GROUP BY campaign_id`, lookupParams),

        db.query(`SELECT id, name FROM dev_groups`),
        db.query(`SELECT id, name FROM keitaro_flow`),
        db.query(`SELECT id, name FROM brands`),
      ]);

      const campaignLookup = new Map(campaignLookupRows.map(r => [r.campaign_id, r]));
      const campaignNames = new Map(campaignNameRows.map(r => [r.campaign_id, r.campaign_name]));
      const groupNames = new Map(groupRows.map(r => [r.id, r.name]));
      const flowNames = new Map(flowRows.map(r => [r.id, r.name]));
      const brandNamesDb = new Map(brandRows.map(r => [r.id, r.name]));

      // When scoped/filtered, only campaigns present in campaignLookup (already restricted
      // in SQL above) are allowed through; everything else only had an unrestricted lookup,
      // so every campaign_id is implicitly allowed.
      const isRestricted = scope === 'rt' || !!groupName;
      const rows = isRestricted
        ? campaignDateRows.filter(r => campaignLookup.has(r.campaign_id))
        : campaignDateRows;

      const totals = rows.reduce((acc, r) => {
        acc.regs += Number(r.regs) || 0;
        acc.ftds += Number(r.ftds) || 0;
        return acc;
      }, { regs: 0, ftds: 0 });

      function groupSum(rows, keyFn, extra){
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

      const byDate = groupSum(rows, r => r.date, (row, r) => { row.date = r.date; });

      const byCampaign = groupSum(rows, r => r.campaign_id, (row, r) => {
        row.campaign_id = r.campaign_id;
        row.campaign_name = campaignNames.get(r.campaign_id) || null;
      });

      const byGroup = groupSum(rows, r => campaignLookup.get(r.campaign_id)?.group_id, (row, r) => {
        const groupId = campaignLookup.get(r.campaign_id)?.group_id ?? null;
        row.group_id = groupId;
        row.group_name = groupId != null ? (groupNames.get(groupId) || null) : null;
      });

      const byFlow = groupSum(rows, r => campaignLookup.get(r.campaign_id)?.flow_id, (row, r) => {
        const flowId = campaignLookup.get(r.campaign_id)?.flow_id ?? null;
        row.flow_id = flowId;
        row.flow_name = flowId != null ? (flowNames.get(flowId) || null) : null;
      });

      const byBrandGrouped = groupSum(rows, r => campaignLookup.get(r.campaign_id)?.brand_id, (row, r) => {
        const brandId = campaignLookup.get(r.campaign_id)?.brand_id ?? null;
        row.brand_id = brandId;
        row.brand_name = brandId != null ? (BRAND_NAMES[brandId] || brandNamesDb.get(brandId) || null) : null;
      });

      const byGroupDate = groupSum(rows, r => `${r.date}|${campaignLookup.get(r.campaign_id)?.group_id}`, (row, r) => {
        const groupId = campaignLookup.get(r.campaign_id)?.group_id ?? null;
        row.date = r.date;
        row.group_id = groupId;
        row.group_name = groupId != null ? (groupNames.get(groupId) || null) : null;
      });

      res.status(200).json({
        scope, from, to, totals,
        byDate, byGroupDate, byCampaign, byFlow, byGroup, byCountry, byOffer,
        byBrand: byBrandGrouped,
      });
      return;
    }

    const conditions = ['kcd.date BETWEEN ? AND ?'];
    const params = [from, to];
    if (scope === 'rt') {
      const rtPlaceholders = RT_GROUPS.map(() => '?').join(',');
      conditions.push(`dg.name IN (${rtPlaceholders})`);
      params.push(...RT_GROUPS);
    }
    if (campaignName) { conditions.push('ck2.campaign_name = ?'); params.push(campaignName); }
    if (countryCode) { conditions.push('kcd.country = ?'); params.push(countryCode); }
    if (groupName) { conditions.push('dg.name = ?'); params.push(groupName); }
    if (offerId) { conditions.push('kcd.offer_id = ?'); params.push(offerId); }
    const where = conditions.join(' AND ');
    // ck2 resolves campaign_name and is scoped to the same date range as the outer query —
    // without the date bound here it was a full unbounded scan of clicks_keitaro on every
    // single query below (9x per request), which was the dominant cost of this endpoint.
    const joins = `LEFT JOIN dev_groups dg ON dg.id = kcd.group_id
                   LEFT JOIN (SELECT DISTINCT campaign_id, campaign_name FROM clicks_keitaro WHERE date BETWEEN ? AND ?) ck2 ON ck2.campaign_id = kcd.campaign_id
                   LEFT JOIN keitaro_flow kf ON kf.id = kcd.flow_id`;
    const queryParams = [from, to, ...params];

    const REG_FTD_SUM = `SUM(CASE WHEN kcd.operation='lead' THEN kcd.amount ELSE 0 END) AS regs,
         SUM(CASE WHEN kcd.operation='sale' THEN kcd.amount ELSE 0 END) AS ftds`;

    // All 9 queries are independent (same WHERE, different GROUP BY) — run them concurrently
    // instead of one-at-a-time so total latency is ~max(query time), not sum(query time).
    const [
      [[totals]],
      [byDate],
      [byGroupDate],
      [byCampaign],
      [byFlow],
      [byGroup],
      [byCountry],
      [byOffer],
      [byBrandRaw],
    ] = await Promise.all([
      db.query(
        `SELECT ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${joins} WHERE ${where}`, queryParams),

      db.query(
        `SELECT DATE_FORMAT(kcd.date, '%Y-%m-%d') AS date, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${joins} WHERE ${where}
         GROUP BY kcd.date ORDER BY kcd.date`, queryParams),

      db.query(
        `SELECT DATE_FORMAT(kcd.date, '%Y-%m-%d') AS date, kcd.group_id, dg.name AS group_name, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${joins} WHERE ${where}
         GROUP BY kcd.date, kcd.group_id, dg.name ORDER BY kcd.date`, queryParams),

      db.query(
        `SELECT kcd.campaign_id, ck2.campaign_name, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${joins} WHERE ${where}
         GROUP BY kcd.campaign_id, ck2.campaign_name`, queryParams),

      db.query(
        `SELECT kcd.flow_id, kf.name AS flow_name, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${joins} WHERE ${where}
         GROUP BY kcd.flow_id, kf.name`, queryParams),

      db.query(
        `SELECT kcd.group_id, dg.name AS group_name, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${joins} WHERE ${where}
         GROUP BY kcd.group_id, dg.name`, queryParams),

      db.query(
        `SELECT kcd.country, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${joins} WHERE ${where}
         GROUP BY kcd.country`, queryParams),

      db.query(
        `SELECT kcd.offer_id, MAX(kcd.offer) AS offer_name, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${joins} WHERE ${where}
         GROUP BY kcd.offer_id`, queryParams),

      db.query(
        `SELECT kcd.brand_id, b.name AS brand_name, ${REG_FTD_SUM}
         FROM keitaro_conversions_daily kcd ${joins}
         LEFT JOIN brands b ON b.id = kcd.brand_id
         WHERE ${where}
         GROUP BY kcd.brand_id, b.name`, queryParams),
    ]);

    const byBrand = byBrandRaw.map(r => ({ ...r, brand_name: BRAND_NAMES[r.brand_id] || r.brand_name || null }));

    res.status(200).json({ scope, from, to, totals, byDate, byGroupDate, byCampaign, byFlow, byGroup, byCountry, byOffer, byBrand });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
