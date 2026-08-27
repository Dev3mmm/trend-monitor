// One-time setup: opens a real (headed) Chromium window pointed at x.com/login.
// Log in by hand (password + any 2FA prompt). This script polls the page URL
// and auto-saves your session to x_state.json the moment it detects you've
// landed on the home timeline - no need to switch back to a terminal.
//
// Re-run this any time X logs the session out (cookie expiry, security check).

const path = require('path');
const { chromium } = require('playwright');

const STATE_FILE = path.join(__dirname, 'x_state.json');
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes to complete login

function looksLoggedIn(url) {
  return /x\.com\/home/i.test(url) || (/^https:\/\/x\.com\/?$/i.test(url));
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  // X's login flow (the "Confirm your account" / knowledge_check wall) can silently
  // freeze its own Continue/Use-password buttons once it detects automation signals
  // Playwright otherwise leaves behind even under the real Chrome binary - strip the
  // most common ones before any page loads.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = window.chrome || { runtime: {} };
  });
  const page = await context.newPage();
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('Log in to X in the opened browser window. Waiting for you to reach your home timeline...');

  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (looksLoggedIn(page.url())) {
      await page.waitForTimeout(2000); // let cookies settle
      await context.storageState({ path: STATE_FILE });
      console.log(`Login detected. Saved session to ${STATE_FILE}`);
      await browser.close();
      return;
    }
    await page.waitForTimeout(2000);
  }

  console.error('Timed out waiting for login (10 min). Re-run this script and try again.');
  await browser.close();
  process.exit(1);
}

main().catch((e) => {
  console.error('Login capture failed:', e);
  process.exit(1);
});
