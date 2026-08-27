// Bridges pipeline sends made from the HOSTED dashboard (which can't reach Martin's local
// absolute file paths) into the real local queue files the daily pipelines actually check.
// Run this on Martin's own PC periodically (or before a pipeline run) after `git pull`.
//
// How it works: dashboard_server.js's sendToPipeline() falls back to a repo-relative
// `pipeline_outbox_<pipelineId>.json` file whenever the configured absolute queueFile path
// doesn't exist on the machine it's running on (i.e. when hosted, not local). This script
// merges each outbox's `pending` entries into the real queueFile from pipelines.json,
// deduped by URL, then empties the outbox so the same items aren't merged twice.

const fs = require('fs');
const path = require('path');

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function main() {
  const pipelines = loadJson(path.join(__dirname, 'pipelines.json'), { pipelines: [] }).pipelines;
  let totalMerged = 0;

  for (const pipeline of pipelines) {
    const outboxFile = path.join(__dirname, `pipeline_outbox_${pipeline.id}.json`);
    const outbox = loadJson(outboxFile, { pending: [] });
    if (!outbox.pending || !outbox.pending.length) continue;

    const realQueue = loadJson(pipeline.queueFile, { pending: [] });
    if (!Array.isArray(realQueue.pending)) realQueue.pending = [];
    const seenUrls = new Set(realQueue.pending.map((p) => p.url));

    let merged = 0;
    for (const item of outbox.pending) {
      if (item.url && seenUrls.has(item.url)) continue;
      realQueue.pending.push(item);
      if (item.url) seenUrls.add(item.url);
      merged++;
    }

    if (merged > 0) {
      fs.writeFileSync(pipeline.queueFile, JSON.stringify(realQueue, null, 2));
      console.log(`${pipeline.name}: merged ${merged} item(s) into ${pipeline.queueFile}`);
      totalMerged += merged;
    }

    fs.writeFileSync(outboxFile, JSON.stringify({ pending: [] }, null, 2));
  }

  console.log(totalMerged > 0 ? `Done. ${totalMerged} total item(s) merged.` : 'Nothing to merge.');
}

main();
