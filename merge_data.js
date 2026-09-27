// Used by the sweep workflow when a push is rejected because the remote moved (an overlapping run or the
// dashboard committed first). Instead of a text rebase that conflicts on these big JSON arrays, merge by item id:
// every item already on origin/main wins (keeps dashboard promote/dismiss edits), and items only this run
// scraped are appended. Writes merged files into the directory given as argv[2].
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FILES = ['dashboard_activity_log.json', 'youtube_latest_log.json', 'regulator_latest_log.json', 'exchange_latest_log.json', 'protocol_latest_log.json'];
const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });

// dashboard_activity_log.json carries its own retention policy in doom_scroll_agent.js
// (10-day age gate + 500-item rolling cap, "no accumulating pages" per project decision) -
// but that only runs on the writer's OWN local array. A merge concatenates remote+local
// without ever re-checking either bound, so repeated push conflicts let the file grow
// unbounded (hit 2470 items / 1.38MB on 2026-09-27, past GitHub Contents API's 1MB
// inline-content limit, which silently returns content:"" for larger files and broke the
// Cloudflare Worker dashboard's reads with "not valid JSON"). Re-apply the same cap here
// so a merge can never bypass it again.
const RETENTION = {
  'dashboard_activity_log.json': { maxAgeDays: 10, cap: 500 },
};

function applyRetention(file, items) {
  const policy = RETENTION[file];
  if (!policy || !Array.isArray(items)) return items;
  let out = items.filter((it) => {
    const ts = it && (it.originTimestamp || it.ts);
    if (!ts) return false;
    return (Date.now() - new Date(ts).getTime()) / 86400000 <= policy.maxAgeDays;
  });
  if (out.length > policy.cap) out = out.slice(-policy.cap);
  return out;
}

for (const f of FILES) {
  if (!fs.existsSync(f)) continue;
  const local = JSON.parse(fs.readFileSync(f, 'utf8'));
  let remote = [];
  try { remote = JSON.parse(execSync(`git show origin/main:${f}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })); } catch { /* new file */ }
  let merged = local;
  if (Array.isArray(local) && Array.isArray(remote)) {
    const ids = new Set(remote.map((x) => x && x.id));
    merged = remote.concat(local.filter((x) => x && x.id && !ids.has(x.id)));
  }
  const before = Array.isArray(merged) ? merged.length : '?';
  merged = applyRetention(f, merged);
  fs.writeFileSync(path.join(outDir, f), JSON.stringify(merged, null, 2));
  const remoteLen = Array.isArray(remote) ? remote.length : '?';
  const afterNote = RETENTION[f] ? `, after retention ${merged.length}` : '';
  console.log(`merged ${f}: remote ${remoteLen} + local-only ${typeof before === 'number' ? before - remoteLen : '?'}${afterNote}`);
}
