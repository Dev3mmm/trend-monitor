// Wakes on an external ping (cron-job.org, every 15min), runs the X doom-scroll home lane from
// Render's own IP (not GitHub Actions' blocked range - see project_trend_monitor memory), then
// pushes results back to the repo. Node/Playwright/Ollama are baked into the Docker image; the
// actual code+data comes from a fresh shallow clone of the repo at request time, since Render's
// free-tier disk is ephemeral across sleep/wake cycles (see git_sync.js's comment for the same
// reasoning on the old Render deployment).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = process.env.PORT || 10000;
const TRIGGER_KEY = process.env.TRIGGER_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'Dev3mmm/trend-monitor';
const X_STATE_JSON_B64 = process.env.X_STATE_JSON_B64;
const CONFIG_LOCAL_JSON_B64 = process.env.CONFIG_LOCAL_JSON_B64;

let busy = false;
let lastRun = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

async function runSweep() {
  const workDir = `/tmp/sweep-${Date.now()}`;
  const remoteUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
  try {
    log(`Cloning (shallow) into ${workDir}...`);
    sh(`git clone --depth 1 ${remoteUrl} ${workDir}`);
    sh(`git config user.email "render-doom-scroll@trend-monitor.local"`, workDir);
    sh(`git config user.name "Render Doom-Scroll"`, workDir);

    // node_modules (playwright + browser binary) are baked into the image at /app - symlink
    // rather than reinstall, since installing Playwright's Chromium fresh every wake would be slow.
    fs.symlinkSync('/app/node_modules', path.join(workDir, 'node_modules'));

    fs.writeFileSync(path.join(workDir, 'x_state.json'), Buffer.from(X_STATE_JSON_B64, 'base64'));
    fs.writeFileSync(path.join(workDir, 'config.local.json'), Buffer.from(CONFIG_LOCAL_JSON_B64, 'base64'));

    log('Running doom-scroll (10 cycles)...');
    await new Promise((resolve) => {
      const child = spawn('xvfb-run', ['-a', 'node', 'doom_scroll_agent.js', '10'], { cwd: workDir });
      child.stdout.on('data', (d) => process.stdout.write(d));
      child.stderr.on('data', (d) => process.stderr.write(d));
      child.on('close', (code) => {
        log(`doom_scroll_agent.js exited with code ${code}`);
        resolve();
      });
    });

    // Same push-conflict retry as the GitHub Actions sweep - merge by item id via the repo's
    // own merge_data.js rather than a text rebase on these big JSON arrays.
    const FILES = 'dashboard_activity_log.json doom_scroll_debug_home.png doom_scroll_debug_explore.png';
    sh(`git add ${FILES}`, workDir);
    try {
      sh(`git diff --cached --quiet`, workDir);
      log('Nothing new to commit this run.');
    } catch {
      sh(`git commit -m "Render doom-scroll sweep ${new Date().toISOString()}"`, workDir);
      let pushed = false;
      for (let i = 0; i < 5 && !pushed; i++) {
        try {
          sh(`git push origin main`, workDir);
          pushed = true;
        } catch (e) {
          log(`push rejected, merging by id and retrying (${i + 1}/5)...`);
          sh(`git fetch -q origin main`, workDir);
          sh(`node merge_data.js /tmp/merged-${Date.now()}`, workDir);
          const mergedDir = fs.readdirSync('/tmp').filter((d) => d.startsWith('merged-')).pop();
          sh(`git reset -q --hard origin/main`, workDir);
          sh(`cp /tmp/${mergedDir}/*.json ${workDir}/`, workDir);
          sh(`git add dashboard_activity_log.json`, workDir);
          try {
            sh(`git diff --cached --quiet`, workDir);
          } catch {
            sh(`git commit -q -m "Render doom-scroll sweep ${new Date().toISOString()} (merged)"`, workDir);
          }
        }
      }
      if (!pushed) log('ERROR: push failed after 5 retries');
    }
    lastRun = { at: new Date().toISOString(), ok: true };
  } catch (e) {
    log(`ERROR during sweep: ${e.message}`);
    lastRun = { at: new Date().toISOString(), ok: false, error: e.message };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
    busy = false;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/trigger') {
    if (!TRIGGER_KEY || url.searchParams.get('key') !== TRIGGER_KEY) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (busy) {
      res.writeHead(200).end('already running');
      return;
    }
    busy = true;
    res.writeHead(202).end('started');
    runSweep();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({ status: 'ok', busy, lastRun })
  );
});

server.listen(PORT, () => log(`Listening on ${PORT}`));
