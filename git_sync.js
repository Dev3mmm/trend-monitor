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
// the remote needs a token embedded in its URL. Configures the local git identity too
// (required for commit to work at all) - done once at module load.
function setup() {
  if (!ENABLED) return;
  try {
    git(['config', 'user.email', 'dashboard@trend-monitor.local']);
    git(['config', 'user.name', 'Trend Monitor Dashboard']);
    if (GITHUB_TOKEN) {
      git(['remote', 'set-url', 'origin', `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`]);
    } else {
      console.error('GIT_PERSIST is enabled but GITHUB_TOKEN is not set - git push will fail.');
    }
  } catch (e) {
    console.error('git_sync setup failed:', e.message);
  }
}
setup();

function pull() {
  if (!ENABLED) return;
  try {
    git(['pull', '--rebase', '--autostash']);
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
    git(['push']);
  } catch (e) {
    console.error('git commitAndPush failed:', e.message);
  }
}

module.exports = { ENABLED, pull, commitAndPush };
