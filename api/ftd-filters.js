const { getPool, checkToken, setCors } = require('./_db');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkToken(req, res)) return;

  try {
    const db = getPool();

    const [countryRows] = await db.query(
      `SELECT DISTINCT country FROM keitaro_conversions_daily
       WHERE country IS NOT NULL AND country <> '' ORDER BY country LIMIT 500`);

    const [appRows] = await db.query(
      `SELECT DISTINCT app_name FROM keitaro_conversions_daily
       WHERE app_name IS NOT NULL AND app_name <> '' ORDER BY app_name LIMIT 2000`);

    const [offerRows] = await db.query(
      `SELECT DISTINCT offer FROM keitaro_conversions_daily
       WHERE offer IS NOT NULL AND offer <> '' ORDER BY offer LIMIT 2000`);

    res.status(200).json({
      countries: countryRows.map(r => r.country),
      apps: appRows.map(r => r.app_name),
      offers: offerRows.map(r => r.offer),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
