// Git-backed persistence for the hosted dashboard. When deployed somewhere with an
// ephemeral filesystem (Render free tier etc.), local writes disappear on every restart/
// sleep - so instead of relying on disk, every write action gets committed and pushed back
// to the repo immediately, and a periodic pull picks up whatever GitHub Actions' scraping
// sweep has committed in the meantime. The repo itself is the real persistent database.
//
// Only active when GIT_PERSIST=true - local development on Martin's own PC leaves this
// off by default so clicking around the dashboard doesn't spam commits; only the hosted
// deployment sets this env var.

const { execFileSync } = require('child_process');

const ENABLED = process.env.GIT_PERSIST === 'true';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'Dev3mmm/trend-monitor';

function git(args) {
  return execFileSync('git', args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

// Render's runtime container doesn't inherit git push credentials from the build step, so
// the remote needs a token embedded in its URL. Also: Render checks out a detached HEAD
// (confirmed live - "You are not currently on a branch") and its clone has NO "origin"
// remote configured at all (confirmed live - "fatal: No configured push destination"), so
// this has to create both from scratch rather than assume a normal `git clone` state.
function setup() {
  if (!ENABLED) return;
  try {
    git(['config', 'user.email', 'dashboard@trend-monitor.local']);
    git(['config', 'user.name', 'Trend Monitor Dashboard']);
    if (!GITHUB_TOKEN) {
      console.error('GIT_PERSIST is enabled but GITHUB_TOKEN is not set - git push will fail.');
      return;
    }
    const remoteUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
    try {
      git(['remote', 'set-url', 'origin', remoteUrl]);
    } catch {
      git(['remote', 'add', 'origin', remoteUrl]); // no "origin" remote exists yet on this checkout
    }
    git(['checkout', '-B', 'main']); // detached HEAD -> a real local branch, so commits have somewhere to live
  } catch (e) {
    console.error('git_sync setup failed:', e.message);
  }
}
setup();

function pull() {
  if (!ENABLED) return;
  try {
    git(['pull', 'origin', 'main', '--rebase', '--autostash']);
  } catch (e) {
    console.error('git pull failed:', e.message);
  }
}

// Commits + pushes any pending changes. Safe to call after every write - a no-op commit
// (nothing changed) is skipped rather than erroring.
function commitAndPush(message) {
  if (!ENABLED) return;
  try {
    git(['add', '-A']);
    try {
      git(['commit', '-m', message]);
    } catch {
      return; // nothing to commit - not an error
    }
    git(['push', 'origin', 'main']);
  } catch (e) {
    console.error('git commitAndPush failed:', e.message);
  }
}

module.exports = { ENABLED, pull, commitAndPush };
