const { getPool, checkToken, setCors } = require('./_db');

function parseDate(v, fallback) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkToken(req, res)) return;

  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const from = parseDate(req.query.from, monthAgo);
  const to = parseDate(req.query.to, today);

  const country = req.query.country || null;
  const appName = req.query.appName || null;
  const offer = req.query.offer || null;

  const conditions = ['date BETWEEN ? AND ?'];
  const params = [from, to];
  if (country) { conditions.push('country = ?'); params.push(country); }
  if (appName) { conditions.push('app_name = ?'); params.push(appName); }
  if (offer) { conditions.push('offer = ?'); params.push(offer); }
  const where = conditions.join(' AND ');

  const LEAD_SALE_SUM = `SUM(CASE WHEN operation='lead' THEN amount ELSE 0 END) AS leads,
       SUM(CASE WHEN operation='sale' THEN amount ELSE 0 END) AS sales`;

  try {
    const db = getPool();

    // All 5 queries are independent — run them concurrently instead of one-at-a-time
    // so total latency is ~max(query time), not sum(query time).
    const [
      [[totals]],
      [byDate],
      [byCountry],
      [byApp],
      [byOffer],
    ] = await Promise.all([
      db.query(
        `SELECT ${LEAD_SALE_SUM}, COUNT(*) AS segments
         FROM keitaro_conversions_daily WHERE ${where}`, params),

      db.query(
        `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, ${LEAD_SALE_SUM}
         FROM keitaro_conversions_daily WHERE ${where}
         GROUP BY date ORDER BY date`, params),

      db.query(
        `SELECT country, ${LEAD_SALE_SUM}
         FROM keitaro_conversions_daily WHERE ${where}
         GROUP BY country ORDER BY SUM(amount) DESC LIMIT 50`, params),

      db.query(
        `SELECT app_name, ${LEAD_SALE_SUM}
         FROM keitaro_conversions_daily WHERE ${where}
         GROUP BY app_name ORDER BY SUM(amount) DESC LIMIT 50`, params),

      db.query(
        `SELECT offer, ${LEAD_SALE_SUM}
         FROM keitaro_conversions_daily WHERE ${where}
         GROUP BY offer ORDER BY SUM(amount) DESC LIMIT 50`, params),
    ]);

    res.status(200).json({ from, to, totals, byDate, byCountry, byApp, byOffer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
