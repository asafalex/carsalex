// Minimal Supabase REST (PostgREST) client via plain fetch — no @supabase/supabase-js
// dependency needed for the simple select/upsert calls this project does. Uses the
// service_role key, which bypasses Row Level Security, so this must only ever be called
// from server-side code (API routes / local scripts), never exposed to the browser.
// Used for NEW tables only (e.g. namecheap_domains) — the existing Keitaro-side tables
// stay in MySQL, see api/_db.js.

function supabaseHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function supabaseUrl(table, query = '') {
  const base = process.env.SUPABASE_URL;
  return `${base}/rest/v1/${table}${query ? `?${query}` : ''}`;
}

async function supabaseSelect(table, query = 'select=*') {
  const res = await fetch(supabaseUrl(table, query), { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Supabase select error on ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Upsert rows, matching conflicts on `onConflict` (a comma-separated column list that must
// have a unique/exclusion constraint in the table).
async function supabaseUpsert(table, rows, onConflict) {
  const res = await fetch(supabaseUrl(table, `on_conflict=${onConflict}`), {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert error on ${table}: ${res.status} ${await res.text()}`);
}

module.exports = { supabaseSelect, supabaseUpsert };
