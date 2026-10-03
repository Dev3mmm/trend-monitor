// Re-captures x_api_template.json: loads x.com/home once with the scraper session, clicks the
// Following tab, records the HomeLatestTimeline GraphQL request X's own web app makes, and writes
// the template that x_api_timeline.js replays. Run via refresh_x_api.cmd after X rotates its
// query id (the sweep sends a Telegram alert telling you when).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000'] });
  const ctx = await browser.newContext({ storageState: path.join(__dirname, 'x_state.json') });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await ctx.newPage();
  const hits = [];
  page.on('request', (r) => { if (/graphql\/[^/]+\/HomeLatestTimeline/.test(r.url())) hits.push({ url: r.url(), method: r.method(), body: r.postData(), headers: r.headers() }); });
  for (let attempt = 1; attempt <= 4 && !hits.length; attempt++) {
    console.log('attempt', attempt);
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('goto:', e.message.split(String.fromCharCode(10))[0]));
    await page.waitForTimeout(8000 + attempt * 4000);
    try { const t = page.getByRole('tab', { name: 'Following', exact: true }); await t.waitFor({ timeout: 20000 }); await t.click(); await page.waitForTimeout(7000); } catch (e) { console.log('no Following tab:', e.message.split(String.fromCharCode(10))[0]); }
  }
  await browser.close();
  const c = hits[0];
  if (!c) { console.error('FAIL: no HomeLatestTimeline request captured (session expired? run refresh_x_login.cmd)'); process.exit(1); }
  const b = JSON.parse(c.body);
  const h = c.headers;
  const out = {
    capturedAt: new Date().toISOString(), url: c.url, variables: b.variables, features: b.features, fieldToggles: b.fieldToggles || null,
    headers: { authorization: h.authorization, 'user-agent': h['user-agent'], 'x-twitter-client-language': h['x-twitter-client-language'], 'x-twitter-active-user': h['x-twitter-active-user'], 'x-twitter-auth-type': h['x-twitter-auth-type'], referer: h.referer, 'content-type': h['content-type'] },
  };
  fs.writeFileSync(path.join(__dirname, 'x_api_template.json'), JSON.stringify(out, null, 1));
  console.log('OK: wrote x_api_template.json for', c.url.split('/').slice(-2).join('/'));
})();
