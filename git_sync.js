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

function git(args) {
  return execFileSync('git', args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

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
