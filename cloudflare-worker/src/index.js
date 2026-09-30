// Cloudflare Worker replacement for dashboard_server.js (Render deployment, suspended on
// free-tier usage cap). Same routes, same JSON shapes, same pagination/sort logic as the
// Node server - only the persistence layer changes: no fs, no `git` shell-out
// (git_sync.js), state is read/written straight from/to GitHub via the Contents API
// (src/github.js).
//
// What this Worker does NOT do, on purpose:
// - No scraping (X doom-scroll, YouTube refresh loop, RSS refreshAll). That stays exactly
//   where it is: .github/workflows/sweep.yml, running Playwright + Ollama on a GitHub
//   Actions runner every 10 minutes, committing straight to the repo. This Worker only
//   ever reads the files that job writes and reads/writes user-review state on top.
// - dashboard.html is served as a static asset via Workers assets ([assets] in
//   wrangler.toml, public/index.html), not inlined here.
//
// GET /                                    -> static asset (public/index.html)
// GET  /api/x                              -> X activity feed (tab, page, pageSize)
// POST /api/x/:id/status                   -> set userStatus
// POST /api/x/:id/send-to-pipeline         -> append to a pipeline outbox
// GET  /api/youtube                        -> YouTube feed (tab, page, pageSize)
// POST /api/youtube/:id/status             -> set userStatus
// POST /api/youtube/:id/send-to-pipeline   -> append to a pipeline outbox
// GET  /api/youtube/channels               -> list tracked channels
// POST /api/youtube/add                    -> resolve + track a new channel
// DELETE /api/youtube/channels/:id         -> untrack a channel
// GET  /api/institutional(|/:id/status|/:id/send-to-pipeline|/sources)   -- regulator lane
// GET  /api/exchanges(...)                                                -- exchange lane
// GET  /api/protocols(...)                                                -- protocol lane
// GET  /api/hacks                          -> live DeFiLlama fetch, unchanged
// GET  /api/pipelines                      -> pipelines.json

import { getJsonOr, putJson, GitHubApiError } from './github.js';

const FILES = {
  x: 'dashboard_activity_log.json',
  youtubeLatest: 'youtube_latest_log.json',
  youtubeChannels: 'youtube_channels.json',
  pipelines: 'pipelines.json',
};

const RSS_LANES = {
  institutional: {
    sourcesFile: 'regulator_sources.json',
    latestFile: 'regulator_latest_log.json',
    idPrefix: 'reg',
  },
  exchanges: {
    sourcesFile: 'exchange_sources.json',
    latestFile: 'exchange_latest_log.json',
    idPrefix: 'exch',
  },
  protocols: {
    sourcesFile: 'protocol_sources.json',
    latestFile: 'protocol_latest_log.json',
    idPrefix: 'proto',
  },
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function errorResponse(e) {
  if (e instanceof GitHubApiError) return json(e.status, { error: e.message });
  return json(500, { error: e.message || String(e) });
}

// Same freshness-first sort + pagination as dashboard_server.js's paginate().
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

function xAge(item) {
  if (item.originTimestamp) return Date.now() - new Date(item.originTimestamp).getTime();
  return Date.now() - new Date(item.ts).getTime();
}
function ytAge(item) {
  if (item.publishedAt) return Date.now() - new Date(item.publishedAt).getTime();
  return item.ts ? Date.now() - new Date(item.ts).getTime() : Date.now();
}

async function loadPipelines(env) {
  return (await getJsonOr(env, FILES.pipelines, { pipelines: [] })).pipelines || [];
}

// Mirrors dashboard_server.js's sendToPipeline(), except the "does the absolute local
// queueFile path exist on this host" check is meaningless on a Worker (there is no local
// filesystem at all) - a Worker is never Martin's own PC, so it always takes the outbox
// branch dashboard_server.js falls back to when hosted. sync_pipeline_outbox.js already
// expects and merges these pipeline_outbox_<id>.json files locally; left untouched.
async function sendToPipeline(env, pipelineId, item) {
  const pipelines = await loadPipelines(env);
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  if (!pipeline) throw new Error(`Unknown pipeline: ${pipelineId}`);

  const outboxPath = `pipeline_outbox_${pipeline.id}.json`;
  const queue = await getJsonOr(env, outboxPath, { pending: [] });
  if (!Array.isArray(queue.pending)) queue.pending = [];
  queue.pending.push({ ...item, sentToPipelineAt: new Date().toISOString(), sentFrom: item.source || 'dashboard' });
  await putJson(env, outboxPath, queue, `[worker] send item to pipeline ${pipeline.id}`);
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

async function readBody(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function pathSegment(pathname, index) {
  return decodeURIComponent(pathname.split('/')[index]);
}

// ---- YouTube channel add/delete (Contents-API-backed; see README for the "can this run
// on a Worker at all" note - short answer: yes, resolveAndAddChannel/deleteChannel in
// youtube_monitor.js are pure YouTube Data API + fs, no Playwright/browser involved, so
// they port cleanly once fs is swapped for GitHub reads/writes). One deliberate behavior
// difference from the local server: after adding a channel, dashboard_server.js
// immediately calls youtubeMonitor.refreshAll() so the new channel's videos show up right
// away. This Worker does NOT do that follow-up refresh (it would mean re-implementing the
// whole refresh/prune pipeline here, duplicating refresh_all logic that already lives in
// .github/workflows/sweep.yml) - the new channel is tracked immediately, and its videos
// appear on the next scheduled sweep (<=10 min later) same as any other channel.
async function youtubeApiKey(env) {
  const key = env.YOUTUBE_API_KEY;
  if (!key) throw new GitHubApiError('YOUTUBE_API_KEY is not configured on this Worker (wrangler secret put YOUTUBE_API_KEY).', 500);
  return key;
}

async function resolveAndAddChannel(env, query) {
  const key = await youtubeApiKey(env);
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=channel&maxResults=1&key=${key}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`search.list failed: HTTP ${searchRes.status}`);
  const searchData = await searchRes.json();
  const match = (searchData.items || [])[0];
  if (!match) throw new Error(`No YouTube channel found for "${query}"`);
  const channelId = match.snippet.channelId;

  const existing = await getJsonOr(env, FILES.youtubeChannels, { channels: [] });
  const channels = existing.channels || [];
  if (channels.some((c) => c.channelId === channelId)) {
    return { alreadyTracked: true, name: match.snippet.title, channelId };
  }

  const detailUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&id=${channelId}&key=${key}`;
  const detailRes = await fetch(detailUrl);
  const detailData = await detailRes.json();
  const detail = (detailData.items || [])[0];
  if (!detail) throw new Error(`Could not fetch channel details for ${channelId}`);

  const entry = {
    name: detail.snippet.title,
    channelId,
    uploadsPlaylistId: detail.contentDetails.relatedPlaylists.uploads,
  };
  channels.push(entry);
  await putJson(env, FILES.youtubeChannels, { ...existing, channels }, `[worker] add YouTube channel: ${entry.name}`);
  return { alreadyTracked: false, name: entry.name, channelId, subscribers: detail.statistics.subscriberCount };
}

async function deleteChannel(env, channelId) {
  const existing = await getJsonOr(env, FILES.youtubeChannels, { channels: [] });
  const channels = existing.channels || [];
  const remaining = channels.filter((c) => c.channelId !== channelId);
  if (remaining.length === channels.length) throw new Error(`No channel with id ${channelId}`);
  await putJson(env, FILES.youtubeChannels, { ...existing, channels: remaining }, `[worker] remove YouTube channel ${channelId}`);
  return remaining;
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // ---- X activity ----
  if (pathname === '/api/x' && method === 'GET') {
    let items = await getJsonOr(env, FILES.x, []);
    const tab = url.searchParams.get('tab') || 'fresh';
    if (tab === 'fresh') items = items.filter((i) => i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
    else if (tab === 'rejected') items = items.filter((i) => i.status === 'rejected' && i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
    else if (tab === 'newsworthy') items = items.filter((i) => i.userStatus === 'newsworthy' || i.status === 'caught');
    else if (tab === 'dismissed') items = items.filter((i) => i.userStatus === 'dismissed');
    return json(200, paginate(items, url, xAge));
  }

  if (/^\/api\/x\/[^/]+\/status$/.test(pathname) && method === 'POST') {
    const id = pathSegment(pathname, 3);
    const { userStatus } = await readBody(request);
    const items = await getJsonOr(env, FILES.x, []);
    const item = items.find((i) => i.id === id);
    if (!item) return json(404, { error: 'not found' });
    item.userStatus = userStatus;
    await putJson(env, FILES.x, items, `[worker] X item ${id} -> ${userStatus}`);
    return json(200, item);
  }

  if (/^\/api\/x\/[^/]+\/send-to-pipeline$/.test(pathname) && method === 'POST') {
    const id = pathSegment(pathname, 3);
    const { pipeline } = await readBody(request);
    const items = await getJsonOr(env, FILES.x, []);
    const item = items.find((i) => i.id === id);
    if (!item) return json(404, { error: 'not found' });
    try {
      const p = await sendToPipeline(env, pipeline, item);
      return json(200, { sent: true, pipeline: p.name });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  // ---- YouTube ----
  if (pathname === '/api/youtube' && method === 'GET') {
    let items = await getJsonOr(env, FILES.youtubeLatest, []);
    const tab = url.searchParams.get('tab') || 'fresh';
    if (tab === 'fresh') items = items.filter((i) => i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
    else if (tab === 'newsworthy') items = items.filter((i) => i.userStatus === 'newsworthy');
    else if (tab === 'dismissed') items = items.filter((i) => i.userStatus === 'dismissed');
    return json(200, paginate(items, url, ytAge));
  }

  if (/^\/api\/youtube\/[^/]+\/status$/.test(pathname) && method === 'POST') {
    const id = pathSegment(pathname, 3);
    const { userStatus } = await readBody(request);
    const items = await getJsonOr(env, FILES.youtubeLatest, []);
    const item = items.find((v) => v.id === id);
    if (!item) return json(404, { error: `No video with id ${id}` });
    item.userStatus = userStatus;
    await putJson(env, FILES.youtubeLatest, items, `[worker] YouTube item ${id} -> ${userStatus}`);
    return json(200, item);
  }

  if (/^\/api\/youtube\/[^/]+\/send-to-pipeline$/.test(pathname) && method === 'POST') {
    const id = pathSegment(pathname, 3);
    const { pipeline } = await readBody(request);
    const items = await getJsonOr(env, FILES.youtubeLatest, []);
    const item = items.find((i) => i.id === id);
    if (!item) return json(404, { error: 'not found' });
    try {
      const p = await sendToPipeline(env, pipeline, item);
      return json(200, { sent: true, pipeline: p.name });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }

  if (pathname === '/api/youtube/channels' && method === 'GET') {
    const existing = await getJsonOr(env, FILES.youtubeChannels, { channels: [] });
    return json(200, existing.channels || []);
  }

  if (pathname === '/api/youtube/add' && method === 'POST') {
    let query;
    try {
      query = (await readBody(request)).query;
    } catch {
      return json(400, { error: 'Invalid JSON body, expected { "query": "..." }' });
    }
    if (!query || !query.trim()) return json(400, { error: 'query is required' });
    try {
      const result = await resolveAndAddChannel(env, query.trim());
      return json(200, result);
    } catch (e) {
      return json(e instanceof GitHubApiError ? e.status : 500, { error: e.message });
    }
  }

  if (/^\/api\/youtube\/channels\/[^/]+$/.test(pathname) && method === 'DELETE') {
    const channelId = pathSegment(pathname, 4);
    try {
      const remaining = await deleteChannel(env, channelId);
      return json(200, { deleted: true, remaining });
    } catch (e) {
      return json(404, { error: e.message });
    }
  }

  // ---- Regulators + Exchanges + Protocols (independent RSS lanes, same route shape) ----
  const rssLanePrefix = Object.keys(RSS_LANES).find((p) => pathname === `/api/${p}` || pathname.startsWith(`/api/${p}/`));
  if (rssLanePrefix) {
    const lane = RSS_LANES[rssLanePrefix];

    if (pathname === `/api/${rssLanePrefix}` && method === 'GET') {
      let items = await getJsonOr(env, lane.latestFile, []);
      const tab = url.searchParams.get('tab') || 'fresh';
      if (tab === 'fresh') items = items.filter((i) => !i.relevanceRejected && i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
      else if (tab === 'rejected') items = items.filter((i) => i.relevanceRejected && i.userStatus !== 'dismissed' && i.userStatus !== 'newsworthy');
      else if (tab === 'newsworthy') items = items.filter((i) => i.userStatus === 'newsworthy');
      else if (tab === 'dismissed') items = items.filter((i) => i.userStatus === 'dismissed');
      const kind = url.searchParams.get('kind');
      if (kind) items = items.filter((i) => i.sourceKind === kind);
      return json(200, paginate(items, url, ytAge));
    }

    if (new RegExp(`^/api/${rssLanePrefix}/[^/]+/status$`).test(pathname) && method === 'POST') {
      const id = pathSegment(pathname, 3);
      const { userStatus } = await readBody(request);
      const items = await getJsonOr(env, lane.latestFile, []);
      const item = items.find((v) => v.id === id);
      if (!item) return json(404, { error: `No item with id ${id}` });
      item.userStatus = userStatus;
      await putJson(env, lane.latestFile, items, `[worker] ${rssLanePrefix} item ${id} -> ${userStatus}`);
      return json(200, item);
    }

    if (new RegExp(`^/api/${rssLanePrefix}/[^/]+/send-to-pipeline$`).test(pathname) && method === 'POST') {
      const id = pathSegment(pathname, 3);
      const { pipeline } = await readBody(request);
      const items = await getJsonOr(env, lane.latestFile, []);
      const item = items.find((i) => i.id === id);
      if (!item) return json(404, { error: 'not found' });
      try {
        const p = await sendToPipeline(env, pipeline, item);
        return json(200, { sent: true, pipeline: p.name });
      } catch (e) {
        return json(400, { error: e.message });
      }
    }

    if (pathname === `/api/${rssLanePrefix}/sources` && method === 'GET') {
      const sources = await getJsonOr(env, lane.sourcesFile, { sources: [] });
      return json(200, sources.sources || []);
    }
  }

  // ---- Hacks (live public API, no GitHub involved - identical to dashboard_server.js) ----
  if (pathname === '/api/hacks' && method === 'GET') {
    try {
      return json(200, await fetchHacks());
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  // ---- Pipelines ----
  if (pathname === '/api/pipelines' && method === 'GET') {
    return json(200, await loadPipelines(env));
  }

  return null; // not an API route
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        const result = await handleApi(request, env, url);
        if (result) return result;
        return new Response('Not found', { status: 404 });
      }
      // Non-API paths (including "/") fall through to the Workers assets binding, which
      // serves public/index.html (a copy of dashboard.html) - configured in wrangler.toml.
      // Assets are normally matched before the Worker script even runs; this fetch handler
      // only gets non-API requests here if asset routing didn't already resolve one, in
      // which case there's genuinely nothing to serve.
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return errorResponse(e);
    }
  },
};
