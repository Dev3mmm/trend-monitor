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
  fs.writeFileSync(path.join(outDir, f), JSON.stringify(merged, null, 2));
  console.log(`merged ${f}: remote ${Array.isArray(remote) ? remote.length : '?'} + local-only ${Array.isArray(merged) ? merged.length - (Array.isArray(remote) ? remote.length : 0) : '?'}`);
}
