const { checkToken, setCors } = require('./_db');

function getOrgConfigs() {
  const ids = (process.env.ONESIGNAL_ORG_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const labels = (process.env.ONESIGNAL_ORG_LABELS || '').split(',').map(s => s.trim());
  const keys = (process.env.ONESIGNAL_ORG_KEYS || '').split(',').map(s => s.trim());
  return ids.map((orgId, i) => ({ orgId, label: labels[i] || orgId, key: keys[i] }));
}

async function fetchAppsForOrg(cfg) {
  const res = await fetch('https://api.onesignal.com/apps', {
    headers: { Authorization: `Key ${cfg.key}` },
  });
  if (!res.ok) throw new Error(`OneSignal API error ${res.status} for ${cfg.label}`);
  const apps = await res.json();
  return apps.map(a => ({
    id: a.id,
    name: a.name,
    players: a.players || 0,
    messageablePlayers: a.messageable_players || 0,
    createdAt: a.created_at,
  }));
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkToken(req, res)) return;

  try {
    const configs = getOrgConfigs();
    const accounts = await Promise.all(configs.map(async cfg => {
      try {
        const apps = await fetchAppsForOrg(cfg);
        apps.sort((a, b) => b.players - a.players);
        const totalPlayers = apps.reduce((s, a) => s + a.players, 0);
        const totalMessageable = apps.reduce((s, a) => s + a.messageablePlayers, 0);
        return { label: cfg.label, orgId: cfg.orgId, totalApps: apps.length, totalPlayers, totalMessageable, apps, error: null };
      } catch (err) {
        return { label: cfg.label, orgId: cfg.orgId, totalApps: 0, totalPlayers: 0, totalMessageable: 0, apps: [], error: err.message };
      }
    }));
    res.status(200).json({ generatedAt: new Date().toISOString(), accounts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
  }
};
