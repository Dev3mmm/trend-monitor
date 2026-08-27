// One-time setup: follows the accounts trend_monitor actually reads (sources.json)
// plus a handful of other well-known crypto accounts, using the saved x_state.json
// session. Purpose: (1) make this account look like a normal human crypto user
// rather than a blank freshly-created one, lowering bot-suspicion after it just
// passed X's automation-detection wall; (2) give X's "For You" algorithm real
// signal in case a home-feed doom-scroll lane gets added later. Does NOT affect
// trend_monitor.js's actual scraping, which reads target profiles/search directly
// regardless of what this account follows.
//
// Safe to re-run - clicking Follow on an already-followed account is a no-op.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const X_STATE_FILE = path.join(__dirname, 'x_state.json');
const SOURCES_FILE = path.join(__dirname, 'sources.json');

// Extra well-known crypto accounts beyond what sources.json already reads,
// purely to broaden the algorithm's signal - not used by trend_monitor.js itself.
const EXTRA_ACCOUNTS = [
  'binance', 'coinbase', 'cz_binance', 'coinbureau', 'Cointelegraph',
  'DecryptMedia', 'saylor', 'VitalikButerin', 'CoinDesk',
  // 'TheBlock__' removed 2026-08-23 - account does not exist (verified: "This account doesn't exist" page)
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomDelay(min, max) { return min + Math.random() * (max - min); }

// Real X follow buttons render as data-testid="<userId>-follow" with
// aria-label "Follow @Handle" (or "Following @Handle" / "Unfollow @Handle"
// once followed) - confirmed by DOM inspection 2026-08-23 after the original
// text-based locator silently false-negatived on WatcherGuru (page hadn't
// finished rendering the button yet when the shorter wait checked it, and
// the fallback message wrongly conflated "not found" with "already following").
async function followAccount(page, handle) {
  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[data-testid$="-follow"], [data-testid$="-unfollow"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const alreadyFollowing = page.getByRole('button', { name: new RegExp(`^(Following|Unfollow) @${handle}$`, 'i') });
    if ((await alreadyFollowing.count()) > 0) {
      console.log(`  ${handle}: already following - skipping`);
      return;
    }

    const followBtn = page.getByRole('button', { name: new RegExp(`^Follow @${handle}$`, 'i') }).first();
    const count = await followBtn.count();
    if (count === 0) {
      console.log(`  ${handle}: FAILED - no Follow button found (wrong handle, suspended account, or private?)`);
      return;
    }
    await followBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);

    const verified = page.getByRole('button', { name: new RegExp(`^(Following|Unfollow) @${handle}$`, 'i') });
    if ((await verified.count()) > 0) {
      console.log(`  ${handle}: followed (verified)`);
    } else {
      console.log(`  ${handle}: clicked but NOT verified as following afterward - check manually`);
    }
  } catch (e) {
    console.log(`  ${handle}: FAILED (${e.message})`);
  }
}

async function main() {
  if (!fs.existsSync(X_STATE_FILE)) {
    console.error('x_state.json not found - run "node x_login.js" first.');
    process.exit(1);
  }
  const sources = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  const laneHandles = sources.lanes.filter((l) => l.type === 'profile').map((l) => l.handle);
  const allHandles = [...new Set([...laneHandles, ...EXTRA_ACCOUNTS])];

  console.log(`Following ${allHandles.length} accounts to seed this X account as crypto-focused...`);

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ storageState: X_STATE_FILE });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  for (const handle of allHandles) {
    await followAccount(page, handle);
    await sleep(randomDelay(3000, 6000));
  }

  await context.storageState({ path: X_STATE_FILE });
  await browser.close();
  console.log('Done. Session re-saved.');
}

main().catch((e) => {
  console.error('Seeding failed:', e);
  process.exit(1);
});
