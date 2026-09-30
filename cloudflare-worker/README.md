# Trend Monitor Dashboard - Cloudflare Worker

Replaces the Render deployment of `../dashboard_server.js` (suspended: free-tier usage cap
hit). Same routes, same JSON shapes, same UI (`public/index.html` is a copy of
`../dashboard.html`) - the only real change is persistence: no local filesystem, no `git`
shell-out (`../git_sync.js`), state is read and written straight from/to GitHub via the
Contents API (`src/github.js`).

**What did NOT move here, on purpose:** the actual scraping (X doom-scroll via Playwright,
YouTube refresh, RSS `refresh_all_rss.js` with local Ollama) stays exactly where it already
is - `.github/workflows/sweep.yml`, a GitHub Actions cron running every 10 minutes. This
Worker only ever *reads* the `*_log.json` files that job commits, plus writes back the
small slice of state a human clicking the dashboard produces (`userStatus`, pipeline
outbox files, tracked YouTube channels).

## One-time setup

### 1. Create a GitHub Personal Access Token

The Worker needs write access to `Dev3mmm/trend-monitor` to persist review actions
(marking items newsworthy/dismissed, sending to a pipeline, add/remove YouTube channel).

- Go to https://github.com/settings/tokens?type=beta ("Fine-grained tokens" - preferred) or
  https://github.com/settings/tokens (classic, simpler if fine-grained gives you trouble).
- **Fine-grained token:** scope it to the `Dev3mmm/trend-monitor` repository only, under
  "Repository permissions" set **Contents: Read and write**. Nothing else is needed.
- **Classic token (simpler, broader):** just check the `repo` scope.
- Copy the token now - GitHub only shows it once.

### 2. Install dependencies and log in to Cloudflare

```bash
cd trend_monitor/cloudflare-worker
npm install
npx wrangler login
```

This opens a browser to authorize the Wrangler CLI against your Cloudflare account (free
tier is fine - no card required for Workers' free plan, which is the whole point of moving
off Render).

### 3. Set the GitHub token as a Worker secret

```bash
npx wrangler secret put GITHUB_TOKEN
```

Paste the PAT from step 1 when prompted. This stores it encrypted server-side - it is
**not** written to `wrangler.toml` or committed anywhere.

### 4. (Optional) Set a YouTube API key, to enable "Add channel" from the Worker

`resolveAndAddChannel` in `youtube_monitor.js` is pure YouTube Data API + file I/O (no
Playwright/browser), so it ports cleanly to the Worker - it just needs its own API key
here, same as `config.local.json`'s `youtubeApiKey` does locally:

```bash
npx wrangler secret put YOUTUBE_API_KEY
```

If you skip this, every other route works fine; only `POST /api/youtube/add` will fail
with a clear 500 explaining the missing secret (never silently no-ops).

### 5. Configure the target repo (only if it's not `Dev3mmm/trend-monitor`)

`wrangler.toml` already sets:

```toml
[vars]
GITHUB_REPO = "Dev3mmm/trend-monitor"
GITHUB_BRANCH = "main"
```

Edit those values directly in `wrangler.toml` if you ever fork/rename the repo or branch -
no secret needed for these two, they're not sensitive.

### 6. Deploy

```bash
npx wrangler deploy
```

Wrangler prints the live `*.workers.dev` URL (or your configured custom domain, if you add
a `[[routes]]`/`[[triggers]]` block later - not set up here). Open it; it's a drop-in
replacement for the old Render URL, same UI, same API contract.

### 7. Point anything that hit the old Render URL at the new one

Nothing else in this repo needs to change - the sweep workflow doesn't call the dashboard
at all (it writes straight to the repo), and `sync_pipeline_outbox.js` reads
`pipeline_outbox_<id>.json` from the repo either way, regardless of who wrote it (Render or
this Worker).

## Redeploying after a code change

```bash
cd trend_monitor/cloudflare-worker
npx wrangler deploy
```

Secrets persist across deploys - you only run `wrangler secret put` again if the token
itself changes/rotates.

## Keeping `public/index.html` in sync with `../dashboard.html`

`dashboard.html` is a single self-contained file (no external CSS/JS/image references), so
it's simply copied as-is into `public/index.html`. If you edit `../dashboard.html`, copy it
over again before redeploying:

```bash
cp ../dashboard.html public/index.html
npx wrangler deploy
```

## Notes / known differences from `dashboard_server.js`

- **Add-channel does not trigger an immediate refresh.** Locally, `POST /api/youtube/add`
  calls `youtubeMonitor.refreshAll()` right after tracking a new channel so its videos show
  up immediately. The Worker skips that follow-up call (it would mean re-implementing the
  whole refresh/prune pipeline that already lives in `sweep.yml`, just to save one 10-minute
  wait) - the channel is tracked instantly, its videos appear on the next scheduled sweep.
- **No offline/fallback mode.** If `GITHUB_TOKEN` is missing or any GitHub API call fails,
  every route that touches repo state returns a real HTTP error (4xx/5xx) with a clear
  message, not an empty list. This is intentional per the project's own "fail loudly"
  preference for a small personal tool - silently returning `[]` would look like "no items
  today" instead of "the Worker is broken."
- **Local dev/PC use of `dashboard_server.js` is untouched.** That file, `git_sync.js`, and
  everything scraping-related stay exactly as they are; this Worker is an addition, not a
  replacement of the local dev server's own already-working `ENABLE_LOCAL_SCRAPING=false` /
  `GIT_PERSIST=true` hosted mode.
