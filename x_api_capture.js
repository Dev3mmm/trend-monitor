const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--disable-blink-features=AutomationControlled','--window-position=-32000,-32000'] });
  const ctx = await browser.newContext({ storageState: __dirname + '/x_state.json' });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();
  const hits = [];
  page.on('request', r => { if (/graphql\/[^/]+\/(Home|Following)/.test(r.url())) hits.push({ url: r.url(), method: r.method(), body: r.postData(), headers: r.headers() }); });
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(8000);
  try { const t = page.getByRole('tab', { name: 'Following', exact: true }); await t.waitFor({ timeout: 15000 }); await t.click(); await page.waitForTimeout(6000); } catch (e) { console.log('no Following tab', e.message.split('\n')[0]); }
  console.log('articles', await page.locator('article').count());
  fs.writeFileSync(__dirname + '/captured.json', JSON.stringify(hits, null, 1));
  console.log(hits.map(h => h.url.slice(0, 120)));
  await browser.close();
})();
