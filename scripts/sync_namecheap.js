#!/usr/bin/env node
// Run this LOCALLY (from a machine whose public IP is whitelisted in Namecheap's
// Profile > Tools > API Access settings) — Namecheap's API rejects requests from any IP
// that isn't on that whitelist, and Vercel's serverless functions have no static outbound
// IP to whitelist, so this can't run as a Vercel API route.
//
// Usage: node scripts/sync_namecheap.js
// Reads credentials from .env.local (same file `vercel env pull` writes to) and upserts
// results into Supabase's namecheap_domains table (Postgres via REST, not the MySQL DB the
// rest of this project uses). Safe to re-run / schedule (e.g. daily cron).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

function getList(envVar) {
  return (process.env[envVar] || '').split(',').map(s => s.trim()).filter(Boolean);
}

function getAccounts() {
  const apiUsers = getList('NAMECHEAP_API_USERS');
  const apiKeys = getList('NAMECHEAP_API_KEYS');
  const usernames = getList('NAMECHEAP_USERNAMES');
  const labels = getList('NAMECHEAP_ACCOUNT_LABELS');
  return apiUsers.map((apiUser, i) => ({
    apiUser,
    apiKey: apiKeys[i],
    username: usernames[i] || apiUser,
    label: labels[i] || apiUser,
  }));
}

async function detectPublicIp() {
  const res = await fetch('https://api.ipify.org?format=json');
  const data = await res.json();
  return data.ip;
}

// Namecheap's domains.getList returns simple self-closing <Domain .../> tags and a
// <Paging> block — regex is enough here and avoids adding an XML parsing dependency for a
// script this narrow in scope.
function parseDomains(xml) {
  const domains = [];
  const domainRegex = /<Domain\s+([^>]+?)\/>/g;
  let m;
  while ((m = domainRegex.exec(xml))) {
    const attrs = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRegex.exec(m[1]))) attrs[am[1]] = am[2];
    domains.push(attrs);
  }
  return domains;
}

function parsePaging(xml) {
  const total = xml.match(/<TotalItems>(\d+)<\/TotalItems>/);
  const pageSize = xml.match(/<PageSize>(\d+)<\/PageSize>/);
  return { totalItems: total ? Number(total[1]) : 0, pageSize: pageSize ? Number(pageSize[1]) : 100 };
}

function parseErrors(xml) {
  const errors = [];
  const errorRegex = /<Error Number="([^"]*)">([^<]*)<\/Error>/g;
  let m;
  while ((m = errorRegex.exec(xml))) errors.push(`${m[1]}: ${m[2]}`);
  return errors;
}

async function fetchAllDomainsForAccount(account, clientIp) {
  let page = 1;
  let all = [];
  while (true) {
    const params = new URLSearchParams({
      ApiUser: account.apiUser,
      ApiKey: account.apiKey,
      UserName: account.username,
      ClientIp: clientIp,
      Command: 'namecheap.domains.getList',
      PageSize: '100',
      Page: String(page),
    });
    const res = await fetch(`https://api.namecheap.com/xml.response?${params}`);
    const xml = await res.text();
    const errors = parseErrors(xml);
    if (errors.length) throw new Error(`Namecheap API error (${account.label}): ${errors.join('; ')}`);
    const domains = parseDomains(xml);
    all = all.concat(domains);
    const { totalItems, pageSize } = parsePaging(xml);
    if (page * pageSize >= totalItems || domains.length === 0) break;
    page++;
  }
  return all;
}

function toIsoDate(str) {
  // Namecheap dates look like "03/14/2023" (MM/DD/YYYY)
  if (!str) return null;
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

async function supabaseUpsert(rows) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/namecheap_domains?on_conflict=account_label,name`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const accounts = getAccounts();
  if (!accounts.length) {
    console.error('No NAMECHEAP_API_USERS configured in .env.local');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local — run `vercel env pull` first.');
    process.exit(1);
  }

  console.log('Detecting public IP (must match a Namecheap-whitelisted IP)...');
  const clientIp = await detectPublicIp();
  console.log('Using ClientIp:', clientIp);

  for (const account of accounts) {
    console.log(`\nFetching domains for account "${account.label}"...`);
    const domains = await fetchAllDomainsForAccount(account, clientIp);
    console.log(`  ${domains.length} domains found`);

    const rows = domains.map(d => ({
      account_label: account.label,
      name: d.Name,
      expiration_date: toIsoDate(d.Expires),
      created_date: toIsoDate(d.Created),
      auto_renew: d.AutoRenew === 'true',
      is_locked: d.IsLocked === 'true',
      whois_guard: d.WhoisGuard || null,
    }));

    // Supabase/PostgREST happily accepts a batch upsert in one request — no need to loop
    // row by row the way the old MySQL version did.
    if (rows.length) await supabaseUpsert(rows);
    console.log(`  Synced into Supabase namecheap_domains.`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
