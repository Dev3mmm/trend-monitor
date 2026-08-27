const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const X_STATE_FILE = path.join(__dirname, 'x_state.json');

async function main() {
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ storageState: X_STATE_FILE });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();

  await page.goto('https://x.com/WatcherGuru', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="button"], button')).map((el) => ({
      tag: el.tagName,
      testid: el.getAttribute('data-testid'),
      text: el.innerText.trim().slice(0, 30),
      ariaLabel: el.getAttribute('aria-label'),
    }))
  );
  console.log(`Total buttons found: ${buttons.length}`);
  console.log(JSON.stringify(buttons.filter((b) => /follow/i.test(b.text) || /follow/i.test(b.ariaLabel || '') || /follow/i.test(b.testid || '')), null, 2));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
