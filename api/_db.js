const mysql = require('mysql2/promise');

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.KEITARO_DB_HOST,
      port: Number(process.env.KEITARO_DB_PORT || 3306),
      user: process.env.KEITARO_DB_USER,
      password: process.env.KEITARO_DB_PASSWORD,
      database: process.env.KEITARO_DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      ssl: process.env.KEITARO_DB_SSL === '1' ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

function checkToken(req, res) {
  const token = req.headers['x-api-token'];
  if (!process.env.KEITARO_DASH_TOKEN || token !== process.env.KEITARO_DASH_TOKEN) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return false;
  }
  return true;
}

// Resolves which password was sent: 'main' (the regular dashboard suite), 'rt' (the
// isolated RT dashboard system, scoped to a fixed set of groups — see api/_rt_groups.js),
// or 'all' (the isolated keitaro_all/chat_all pair — unscoped data, just a separate
// password/session, same as 'main' but kept apart from it). Each password only ever
// resolves to its own scope; there is no overlap between them.
function resolveScope(req) {
  const token = req.headers['x-api-token'];
  if (process.env.KEITARO_DASH_TOKEN && token === process.env.KEITARO_DASH_TOKEN) return 'main';
  if (process.env.RT_DASH_TOKEN && token === process.env.RT_DASH_TOKEN) return 'rt';
  if (process.env.ALL_DASH_TOKEN && token === process.env.ALL_DASH_TOKEN) return 'all';
  return null;
}

// Like checkToken, but accepts either the main or the RT password and tells the caller
// which scope matched (so it can apply the RT group restriction when scope === 'rt').
function checkScopedToken(req, res) {
  const scope = resolveScope(req);
  if (!scope) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return null;
  }
  return scope;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

module.exports = { getPool, checkToken, checkScopedToken, setCors };
