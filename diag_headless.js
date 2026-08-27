const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const X_STATE_FILE = path.join(__dirname, 'x_state.json');

async function main() {
  // Same headless mode, but now with the anti-detection patch from x_login.js applied.
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ storageState: X_STATE_FILE, locale: 'en-US' });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = window.chrome || { runtime: {} };
  });
  const page = await context.newPage();
  await page.goto('https://x.com/WatcherGuru', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const articleCount = await page.locator('article').count();
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log(`Article count: ${articleCount}`);
  console.log('=== body text ===');
  console.log(bodyText);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
