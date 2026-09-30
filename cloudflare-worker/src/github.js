// GitHub REST API-backed persistence for the Cloudflare Worker version of the dashboard.
// Workers have no filesystem and cannot shell out to `git` (git_sync.js's approach), so
// every read/write of a state file (*_log.json, *_sources.json, pipelines.json,
// pipeline_outbox_*.json, youtube_channels.json) goes through the GitHub Contents API
// instead. Reads and writes both use the Contents API (not raw.githubusercontent.com) so
// the same call gives us the blob `sha` a write needs anyway - one code path, always
// consistent, no risk of a raw-CDN read racing ahead of/behind the API's view.
//
// GITHUB_ACTIONS (.github/workflows/sweep.yml) remains the sole writer of the *_log.json
// scrape state on a 10-min cadence; this Worker only reads that state and writes back the
// small set of user-driven fields (userStatus) and pipeline outbox files.

const GITHUB_API = 'https://api.github.com';

class GitHubApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status || 502;
  }
}

function assertConfigured(env) {
  if (!env.GITHUB_TOKEN) {
    throw new GitHubApiError(
      'GITHUB_TOKEN is not configured on this Worker. Run `wrangler secret put GITHUB_TOKEN` (see README.md) before using any /api route that touches repo state.',
      500
    );
  }
  if (!env.GITHUB_REPO) {
    throw new GitHubApiError('GITHUB_REPO is not configured (set it in wrangler.toml [vars]).', 500);
  }
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'trend-monitor-worker',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Decodes the Contents API's base64 `content` field to a proper UTF-8 string. atob() gives
// back a binary string (one char per byte, Latin1-mapped) - re-map those char codes into a
// byte array and decode as UTF-8 so non-ASCII text (translated RSS items etc.) survives.
function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const branch = (env) => env.GITHUB_BRANCH || 'main';

// Fetches a repo file's current content + blob sha via the Contents API.
// Returns { exists: false, sha: null, json: null } for a 404 (file not yet created, e.g.
// a pipeline outbox that's never been written to) rather than throwing - callers decide
// their own fallback ({ pending: [] } etc.), same as dashboard_server.js's readJsonSafe.
async function getFile(env, path) {
  assertConfigured(env);
  const url = `${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${branch(env)}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return { exists: false, sha: null, json: null };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubApiError(`GitHub API GET ${path} failed: HTTP ${res.status} ${body.slice(0, 300)}`, 502);
  }
  const data = await res.json();
  const text = base64ToUtf8(data.content);
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new GitHubApiError(`GitHub file ${path} is not valid JSON: ${e.message}`, 502);
  }
  return { exists: true, sha: data.sha, json };
}

// Reads a JSON file, returning `fallback` if it doesn't exist yet. Mirrors
// dashboard_server.js's readJsonSafe() semantics for callers that don't need the sha.
//
// Uses the Contents API's raw media type instead of the default JSON+base64 wrapper - skips
// the base64-decode-then-JSON.parse double pass entirely (that per-character Latin1 remap in
// base64ToUtf8 is real, measurable CPU work on a 100-270KB file). Cloudflare Workers' free
// plan caps CPU time at 10ms/request; five lanes decoding in parallel on the Home page were
// intermittently blowing that budget and returning error 1102 to the browser - confirmed
// live 2026-09-30. putJson still needs the sha for its write, so it keeps using getFile().
async function getJsonRawOr(env, path, fallback) {
  assertConfigured(env);
  const url = `${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${branch(env)}`;
  const res = await fetch(url, { headers: { ...ghHeaders(env), Accept: 'application/vnd.github.raw' } });
  if (res.status === 404) return fallback;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubApiError(`GitHub API GET ${path} failed: HTTP ${res.status} ${body.slice(0, 300)}`, 502);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new GitHubApiError(`GitHub file ${path} is not valid JSON: ${e.message}`, 502);
  }
}

async function getJsonOr(env, path, fallback) {
  return getJsonRawOr(env, path, fallback);
}

// Writes a JSON file via PUT (create or update). Refetches the current sha immediately
// before writing and retries once on a 409 (sha-mismatch race) - this is a low-traffic
// single-user dashboard, so a single retry is enough rather than building out a full
// optimistic-concurrency loop.
async function putJson(env, path, value, message, _attempt = 0) {
  assertConfigured(env);
  const current = await getFile(env, path);
  const body = {
    message,
    content: utf8ToBase64(JSON.stringify(value, null, 2)),
    branch: branch(env),
    committer: { name: 'Trend Monitor Worker', email: 'dashboard@trend-monitor.local' },
  };
  if (current.exists) body.sha = current.sha;

  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 409 && _attempt === 0) {
    return putJson(env, path, value, message, _attempt + 1); // stale sha - refetch (above) and retry once
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new GitHubApiError(`GitHub API PUT ${path} failed: HTTP ${res.status} ${errBody.slice(0, 300)}`, 502);
  }
  return res.json();
}

export { getFile, getJsonOr, getJsonRawOr, putJson, GitHubApiError };
