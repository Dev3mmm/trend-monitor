// Pings the hosted dashboard's data API once per sweep. If it stops returning data (e.g. its
// GITHUB_TOKEN secret on Cloudflare expires -> 401), sends ONE Telegram message; sends one more
// when it recovers. State lives in dashboard_health.json via the GitHub Contents API (same
// pattern as x_api_health.json) so it survives ephemeral runners.
const fs = require('fs');
const path = require('path');

const URL_ = 'https://trend-monitor-dashboard.mtandaokonnect.workers.dev/api/x';
const REPO = process.env.GITHUB_REPOSITORY || 'Dev3mmm/trend-monitor';
const FILE = 'dashboard_health.json';
const GH = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'trend-monitor', Accept: 'application/vnd.github+json' };
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));

async function telegram(text) {
  await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, text }),
  }).catch(() => {});
}
async function readState() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, { headers: GH });
  if (!r.ok) return { state: { failing: false }, sha: undefined };
  const j = await r.json();
  return { state: JSON.parse(Buffer.from(j.content, 'base64').toString()), sha: j.sha };
}
async function writeState(state, sha) {
  await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
    method: 'PUT', headers: GH,
    body: JSON.stringify({ message: 'dashboard health', branch: 'main', sha, content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64') }),
  });
}

(async () => {
  let ok = false, why = '';
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    ok = r.ok && Array.isArray(j.items);
    if (!ok) why = `HTTP ${r.status} ${String(j.error || '').slice(0, 120)}`;
  } catch (e) { why = e.message; }
  const { state, sha } = await readState();
  if (!ok && !state.failing) {
    await writeState({ failing: true, since: new Date().toISOString(), error: why }, sha);
    await telegram(`Trend Monitor: the hosted dashboard can't load data (${why}). Sweeps are still running. Likely its GITHUB_TOKEN secret on Cloudflare expired: from trend_monitor\cloudflare-worker run "npx wrangler secret put GITHUB_TOKEN".`);
  } else if (ok && state.failing) {
    await writeState({ failing: false, since: new Date().toISOString() }, sha);
    await telegram('Trend Monitor: the hosted dashboard is loading data again.');
  }
  console.log(ok ? 'dashboard ok' : `dashboard FAILING: ${why}`);
})();
