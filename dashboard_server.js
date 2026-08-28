// Live local dashboard for the trend-monitoring stack.
// - X tab: reads dashboard_activity_log.json (written by doom_scroll_agent.js as it scrolls)
// - YouTube tab: reads youtube_latest_log.json, refreshed on an interval by youtube_monitor.js
// - Hacks tab: live-fetches DeFiLlama's public hacks API directly (same source hack_monitor.js
//   already polls) - no need to duplicate that bot's state, just read the same public feed
// Supports a manual review workflow: every X/YouTube item carries a userStatus
// (null | 'newsworthy' | 'dismissed') that the dashboard UI can set, plus a
// "send to pipeline" action that appends the item to a chosen pipeline's queue file
// (pipelines.json lists the available pipelines).
// Plain Node http server, no framework, to avoid adding dependencies to this project.

const http = require('http');
const fs = require('fs');
const path = require('path');
const youtubeMonitor = require('./youtube_monitor');
const { createRssMonitor } = require('./rss_monitor');
const gitSync = require('./git_sync');

// GitHub Actions (.github/workflows/sweep.yml) now does the actual scraping (needs
// Chromium + Ollama, neither available on a lightweight host like Render's free tier) and
// commits results to this repo every 15 min. This server's own local-refresh calls below
// are for running on Martin's own PC only - disabled by setting ENABLE_LOCAL_SCRAPING=false
// on a hosted deployment, which instead just periodically `git pull`s what the Action wrote.
const LOCAL_SCRAPING_ENABLED = process.env.ENABLE_LOCAL_SCRAPING !== 'false';

const regulatorMonitor = createRssMonitor({
  sourcesFile: path.join(__dirname, 'regulator_sources.json'),
  latestFile: path.join(__dirname, 'regulator_latest_log.json'),
  idPrefix: 'reg',
  filterCryptoRelevance: true, // general regulators cover far more than crypto - filter to relevant items only
});
const exchangeMonitor = createRssMonitor({
  sourcesFile: path.join(__dirname, 'exchange_sources.json'),
  latestFile: path.join(__dirname, 'exchange_latest_log.json'),
  idPrefix: 'exch',
});
const protocolMonitor = createRssMonitor({
  sourcesFile: path.join(__dirname, 'protocol_sources.json'),
  latestFile: path.join(__dirname, 'protocol_latest_log.json'),
  idPrefix: 'proto',
  // No crypto-relevance filter needed - a protocol's own blog is inherently on-topic,
  // same reasoning already applied to skip the filter on the Exchanges tab.
});

const PORT = process.env.PORT || 4173;
const DASHBOARD_LOG_FILE = path.join(__dirname, 'dashboard_activity_log.json');
const PIPELINES_FILE = path.join(__dirname, 'pipelines.json');
const YOUTUBE_REFRESH_MS = 5 * 60 * 1000;
const RSS_REFRESH_MS = 10 * 60 * 1000;

function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadXItems() {
  return readJsonSafe(DASHBOARD_LOG_FILE, []);
}
function saveXItems(items) {
  fs.writeFileSync(DASHBOARD_LOG_FILE, JSON.stringify(items, null, 2));
}

function loadPipelines() {
  return readJsonSafe(PIPELINES_FILE, { pipelines: [] }).pipelines;
}

function sendToPipeline(pipelineId, item) {
  const pipelines = loadPipelines();
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineId}`);

  // pipelines.json's queueFile is an absolute path on Martin's own PC (e.g.
  // C:\Users\Martin\Documents\trend_pending_queue.json), which won't exist when this
  // server runs on a host like Render. Fall back to a repo-relative outbox file that
  // gets git-committed instead - a local sync step (sync_pipeline_outbox.js) then merges
  // it into the real local queue file on Martin's PC. Detected by checking whether the
  // queueFile's parent directory actually exists here.
  const targetFile = fs.existsSync(path.dirname(pipeline.queueFile))
    ? pipeline.queueFile
    : path.join(__dirname, `pipeline_outbox_${pipeline.id}.json`);

  const queue = readJsonSafe(targetFile, { pending: [] });
  if (!Array.isArray(queue.pending)) queue.pending = [];
  queue.pending.push({ ...item, sentToPipelineAt: new Date().toISOString(), sentFrom: item.source || 'dashboard' });
  fs.writeFileSync(targetFile, JSON.stringify(queue, null, 2));
  return pipeline;
}

async function fetchHacks() {
  const res = await fetch('https://api.llama.fi/hacks');
  if (!res.ok) throw new Error(`DeFiLlama hacks API HTTP ${res.status}`);
  const data = await res.json();
  return data
    .filter((h) => h.date)
    .sort((a, b) => b.date - a.date)
    .slice(0, 50)
    .map((h) => ({
      name: h.name,
      date: h.date,
      dateIso: new Date(h.date * 1000).toISOString(),
      amount: h.amount,
      chain: h.chain,
      technique: h.technique,
      classification: h.classification,
      targetType: h.targetType,
    }));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Applies freshness-first sort (lowest age first) then paginates. items must each have
// ageMin; used identically for X and YouTube lists so both tabs behave the same way.
function paginate(items, url, ageFn) {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = Math.max(1, Math.min(100, parseInt(url.searchParams.get('pageSize') || '20', 10)));
  const sorted = items.slice().sort((a, b) => ageFn(a) - ageFn(b));
  const start = (page - 1) * pageSize;
  return {
    page,
    pageSize,
    total: sorted.length,
    totalPages: Math.max(1, Math.ceil(sorted.length / pageSize)),
    items: sorted.slice(start, start + pageSize),
  };
}

// Older items logged before originTimestamp existed only have a static ageMin snapshot
// captured once at scrape time - using it directly would make those items sort as
// permanently "fresh" forever (frozen age), burying real new catches under them. Falling
// back to elapsed time since ts (catch/log time, always present) instead keeps age growing
// naturally so newest-first sorting actually reflects the current moment.
function xAge(item) {
  if (item.originTimestamp) return Date.now() - new Date(item.originTimestamp).getTime();
  return Date.now() - new Date(item.ts).getTime();
}
function ytAge(item) {
  if (item.publishedAt) return Date.now() - new Date(item.publishedAt).getTime();
  return item.ts ? Date.now() - new Date(item.ts).getTime() : Date.now();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/' && req.method === 'GET') {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // ---- X activity ----
    if (url.pathname === '/api/x' && req.method === 'GET') {
      let items = loadXItems();
      const tab = url.searchParams.get('tab') || 'fresh';
      if (tab === 'fresh') items = items.filter((i) => i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
      else if (tab === 'rejected') items = items.filter((i) => i.status === 'rejected' && i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
      else if (tab === 'newsworthy') items = items.filter((i) => i.userStatus === 'newsworthy' || i.status === 'caught');
      else if (tab === 'dismissed') items = items.filter((i) => i.userStatus === 'dismissed');
      sendJson(res, 200, paginate(items, url, xAge));
      return;
    }

    if (url.pathname.match(/^\/api\/x\/[^/]+\/status$/) && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readBody(req);
      const { userStatus } = JSON.parse(body);
      const items = loadXItems();
      const item = items.find((i) => i.id === id);
      if (!item) { sendJson(res, 404, { error: 'not found' }); return; }
      item.userStatus = userStatus;
      saveXItems(items);
      gitSync.commitAndPush(`X item ${id} -> ${userStatus}`);
      sendJson(res, 200, item);
      return;
    }

    if (url.pathname.match(/^\/api\/x\/[^/]+\/send-to-pipeline$/) && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readBody(req);
      const { pipeline } = JSON.parse(body);
      const items = loadXItems();
      const item = items.find((i) => i.id === id);
      if (!item) { sendJson(res, 404, { error: 'not found' }); return; }
      try {
        const p = sendToPipeline(pipeline, item);
        gitSync.commitAndPush(`X item ${id} sent to pipeline ${pipeline}`);
        sendJson(res, 200, { sent: true, pipeline: p.name });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    // ---- YouTube ----
    if (url.pathname === '/api/youtube' && req.method === 'GET') {
      let items = youtubeMonitor.loadLatest();
      const tab = url.searchParams.get('tab') || 'fresh';
      if (tab === 'fresh') items = items.filter((i) => i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
      else if (tab === 'newsworthy') items = items.filter((i) => i.userStatus === 'newsworthy');
      else if (tab === 'dismissed') items = items.filter((i) => i.userStatus === 'dismissed');
      sendJson(res, 200, paginate(items, url, ytAge));
      return;
    }

    if (url.pathname.match(/^\/api\/youtube\/[^/]+\/status$/) && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readBody(req);
      const { userStatus } = JSON.parse(body);
      try {
        const item = youtubeMonitor.setVideoUserStatus(id, userStatus);
        gitSync.commitAndPush(`YouTube item ${id} -> ${userStatus}`);
        sendJson(res, 200, item);
      } catch (e) {
        sendJson(res, 404, { error: e.message });
      }
      return;
    }

    if (url.pathname.match(/^\/api\/youtube\/[^/]+\/send-to-pipeline$/) && req.method === 'POST') {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await readBody(req);
      const { pipeline } = JSON.parse(body);
      const items = youtubeMonitor.loadLatest();
      const item = items.find((i) => i.id === id);
      if (!item) { sendJson(res, 404, { error: 'not found' }); return; }
      try {
        const p = sendToPipeline(pipeline, item);
        gitSync.commitAndPush(`YouTube item ${id} sent to pipeline ${pipeline}`);
        sendJson(res, 200, { sent: true, pipeline: p.name });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return;
    }

    if (url.pathname === '/api/youtube/channels' && req.method === 'GET') {
      sendJson(res, 200, youtubeMonitor.loadChannels());
      return;
    }

    if (url.pathname === '/api/youtube/add' && req.method === 'POST') {
      const body = await readBody(req);
      let query;
      try {
        query = JSON.parse(body).query;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body, expected { "query": "..." }' });
        return;
      }
      if (!query || !query.trim()) {
        sendJson(res, 400, { error: 'query is required' });
        return;
      }
      try {
        const result = await youtubeMonitor.resolveAndAddChannel(query.trim());
        if (!result.alreadyTracked) youtubeMonitor.refreshAll().catch(() => {});
        gitSync.commitAndPush(`Added YouTube channel: ${result.name}`);
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    if (url.pathname.match(/^\/api\/youtube\/channels\/[^/]+$/) && req.method === 'DELETE') {
      const channelId = decodeURIComponent(url.pathname.split('/')[4]);
      try {
        const remaining = youtubeMonitor.deleteChannel(channelId);
        gitSync.commitAndPush(`Removed YouTube channel ${channelId}`);
        sendJson(res, 200, { deleted: true, remaining });
      } catch (e) {
        sendJson(res, 404, { error: e.message });
      }
      return;
    }

    // ---- Regulators + Exchanges + Protocols (independent RSS lanes, same route shape) ----
    const RSS_LANES = {
      institutional: regulatorMonitor,
      exchanges: exchangeMonitor,
      protocols: protocolMonitor,
    };
    const rssLanePrefix = Object.keys(RSS_LANES).find(
      (p) => url.pathname === `/api/${p}` || url.pathname.startsWith(`/api/${p}/`)
    );
    const rssLane = rssLanePrefix ? { prefix: rssLanePrefix, monitor: RSS_LANES[rssLanePrefix] } : null;

    if (rssLane) {
      const { prefix, monitor } = rssLane;

      if (url.pathname === `/api/${prefix}` && req.method === 'GET') {
        let items = monitor.loadLatest();
        const tab = url.searchParams.get('tab') || 'fresh';
        if (tab === 'fresh') items = items.filter((i) => !i.relevanceRejected && i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
        else if (tab === 'rejected') items = items.filter((i) => i.relevanceRejected && i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
        else if (tab === 'newsworthy') items = items.filter((i) => i.userStatus === 'newsworthy');
        else if (tab === 'dismissed') items = items.filter((i) => i.userStatus === 'dismissed');
        const kind = url.searchParams.get('kind'); // 'blog' | 'forum' - only meaningful for the protocols lane
        if (kind) items = items.filter((i) => i.sourceKind === kind);
        sendJson(res, 200, paginate(items, url, ytAge));
        return;
      }

      if (url.pathname.match(new RegExp(`^/api/${prefix}/[^/]+/status$`)) && req.method === 'POST') {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const body = await readBody(req);
        const { userStatus } = JSON.parse(body);
        try {
          const item = monitor.setUserStatus(id, userStatus);
          gitSync.commitAndPush(`${prefix} item ${id} -> ${userStatus}`);
          sendJson(res, 200, item);
        } catch (e) {
          sendJson(res, 404, { error: e.message });
        }
        return;
      }

      if (url.pathname.match(new RegExp(`^/api/${prefix}/[^/]+/send-to-pipeline$`)) && req.method === 'POST') {
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const body = await readBody(req);
        const { pipeline } = JSON.parse(body);
        const item = monitor.loadLatest().find((i) => i.id === id);
        if (!item) { sendJson(res, 404, { error: 'not found' }); return; }
        try {
          const p = sendToPipeline(pipeline, item);
          gitSync.commitAndPush(`${prefix} item ${id} sent to pipeline ${pipeline}`);
          sendJson(res, 200, { sent: true, pipeline: p.name });
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
        return;
      }

      if (url.pathname === `/api/${prefix}/sources` && req.method === 'GET') {
        sendJson(res, 200, monitor.loadSources());
        return;
      }
    }

    // ---- Hacks ----
    if (url.pathname === '/api/hacks' && req.method === 'GET') {
      try {
        const hacks = await fetchHacks();
        sendJson(res, 200, hacks);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // ---- Pipelines ----
    if (url.pathname === '/api/pipelines' && req.method === 'GET') {
      sendJson(res, 200, loadPipelines());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});

if (LOCAL_SCRAPING_ENABLED) {
  youtubeMonitor.refreshAll().then((r) => console.log('Initial YouTube refresh:', r)).catch((e) => console.error('YouTube refresh failed:', e.message));
  setInterval(() => {
    youtubeMonitor.refreshAll().then((r) => {
      if (r.added > 0) console.log(`YouTube refresh: +${r.added} new video(s)`);
    }).catch((e) => console.error('YouTube refresh failed:', e.message));
  }, YOUTUBE_REFRESH_MS);

  regulatorMonitor.refreshAll().then((r) => console.log('Initial regulator refresh:', r)).catch((e) => console.error('Regulator refresh failed:', e.message));
  setInterval(() => {
    regulatorMonitor.refreshAll().then((r) => {
      if (r.added > 0) console.log(`Regulator refresh: +${r.added} new item(s)`);
    }).catch((e) => console.error('Regulator refresh failed:', e.message));
  }, RSS_REFRESH_MS);

  exchangeMonitor.refreshAll().then((r) => console.log('Initial exchange refresh:', r)).catch((e) => console.error('Exchange refresh failed:', e.message));
  setInterval(() => {
    exchangeMonitor.refreshAll().then((r) => {
      if (r.added > 0) console.log(`Exchange refresh: +${r.added} new item(s)`);
    }).catch((e) => console.error('Exchange refresh failed:', e.message));
  }, RSS_REFRESH_MS);

  protocolMonitor.refreshAll().then((r) => console.log('Initial protocol refresh:', r)).catch((e) => console.error('Protocol refresh failed:', e.message));
  setInterval(() => {
    protocolMonitor.refreshAll().then((r) => {
      if (r.added > 0) console.log(`Protocol refresh: +${r.added} new item(s)`);
    }).catch((e) => console.error('Protocol refresh failed:', e.message));
  }, RSS_REFRESH_MS);
} else {
  console.log('Local scraping disabled (ENABLE_LOCAL_SCRAPING=false) - relying on GitHub Actions + git pull for fresh data.');
}

if (gitSync.ENABLED) {
  const GIT_PULL_MS = 3 * 60 * 1000; // pick up the Action's 15-min-cadence commits promptly
  gitSync.pull();
  setInterval(() => gitSync.pull(), GIT_PULL_MS);
}
