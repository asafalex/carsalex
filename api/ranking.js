const { getPool, checkToken, setCors } = require('./_db');

const COUNTRY_NAMES = require('./_country_names');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkToken(req, res)) return;

  try {
    const db = getPool();

    const [[range]] = await db.query(
      `SELECT DATE_FORMAT(MIN(check_date), '%Y-%m-%d') AS minDate,
              DATE_FORMAT(MAX(check_date), '%Y-%m-%d') AS maxDate
       FROM rt_ranking_history`);

    const [apps] = await db.query(
      `SELECT h.target_id AS id, h.id_name AS name
       FROM rt_ranking_history h
       INNER JOIN (
         SELECT target_id, MAX(check_date) AS max_date
         FROM rt_ranking_history GROUP BY target_id
       ) m ON h.target_id = m.target_id AND h.check_date = m.max_date
       GROUP BY h.target_id, h.id_name`);

    const [platformRows] = await db.query(`SELECT DISTINCT platform FROM rt_ranking_history WHERE platform IS NOT NULL`);
    const platforms = platformRows.map(r => r.platform);

    const [countryRows] = await db.query(`SELECT DISTINCT country_code FROM rt_ranking_history WHERE country_code IS NOT NULL`);
    const countries = countryRows.map(r => ({ code: r.country_code, name: COUNTRY_NAMES[r.country_code] || r.country_code }));

    const [latest] = await db.query(
      `SELECT h.target_id AS appId, h.country_code AS country, h.platform, h.keyword, h.rank,
              DATE_FORMAT(h.check_date, '%Y-%m-%d') AS checkDate, h.found
       FROM rt_ranking_history h
       INNER JOIN (
         SELECT target_id, country_code, platform, keyword, MAX(check_date) AS max_date
         FROM rt_ranking_history
         GROUP BY target_id, country_code, platform, keyword
       ) lt ON h.target_id = lt.target_id AND h.country_code = lt.country_code
            AND h.platform = lt.platform AND h.keyword = lt.keyword AND h.check_date = lt.max_date`);

    const [dailyTrend] = await db.query(
      `SELECT target_id AS appId, DATE_FORMAT(check_date, '%Y-%m-%d') AS date, AVG(rank) AS avgRank
       FROM rt_ranking_history
       WHERE found = 1 AND rank IS NOT NULL AND check_date >= DATE_SUB(NOW(), INTERVAL 60 DAY)
       GROUP BY target_id, DATE(check_date)`);

    const [dailyTrendByPlatform] = await db.query(
      `SELECT target_id AS appId, DATE_FORMAT(check_date, '%Y-%m-%d') AS date, platform, AVG(rank) AS avgRank
       FROM rt_ranking_history
       WHERE found = 1 AND rank IS NOT NULL AND check_date >= DATE_SUB(NOW(), INTERVAL 60 DAY)
       GROUP BY target_id, DATE(check_date), platform`);

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      dateRange: { min: range.minDate, max: range.maxDate },
      platforms,
      countries,
      apps,
      latest,
      dailyTrend,
      dailyTrendByPlatform,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
