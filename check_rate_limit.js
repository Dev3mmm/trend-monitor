const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const X_STATE_FILE = path.join(__dirname, 'x_state.json');

async function main() {
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ storageState: X_STATE_FILE });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();

  // Read-only navigation, no clicks, no follow actions.
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000));
  console.log('=== /home page text ===');
  console.log(bodyText);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
