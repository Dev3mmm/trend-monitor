// CryptoNewsLive Doom-Scroll Agent - human-style live feed monitoring.
//
// Why this exists: manual testing (see project_trend_monitor.md) proved a
// plain "For You" scroll catches real fresh stories that trend_monitor.js's
// keyword-search/profile-lane sweep structurally misses (wording never
// matches canned phrases). This script automates that manual behavior
// instead of a fixed sweep: it opens the home timeline and scrolls like a
// person would - variable pixel amounts, variable pauses (quick skims mixed
// with occasional longer "reading" pauses), reasoning about each new tweet
// with Ollama as it goes, rather than grabbing a batch on a timer.
//
// Uses the SAME dedicated X account/session as trend_monitor.js (x_state.json)
// - deliberately not the Hopium Influencer posting profile. Reuses trend_monitor's
// proven freshness logic (origin <time datetime> per article, not human "2h ago"
// text) and Ollama triage prompt. Separate state/queue-approval bookkeeping so it
// can run standalone without colliding with trend_monitor.js if that's ever
// resumed at the same time.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const STATE_FILE = path.join(__dirname, 'doom_scroll_state.json');
const LOG_FILE = path.join(__dirname, 'doom_scroll_agent.log');
const X_STATE_FILE = path.join(__dirname, 'x_state.json');
const QUEUE_FILE = 'C:\\Users\\Martin\\Documents\\trend_pending_queue.json';
const DASHBOARD_LOG_FILE = path.join(__dirname, 'dashboard_activity_log.json');
const DASHBOARD_LOG_MAX = 500; // rolling cap so the file doesn't grow unbounded

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5:3b';
const MAX_ORIGIN_AGE_MINUTES = 120; // freshness bar from project memory: minutes-to-~2h, not "10h old dressed as a 5-min wrapper"

// Human-like pacing. Most pauses are a quick skim; occasionally a longer "actually
// reading this" pause; rarely a distracted idle gap. Scroll distance varies too -
// a real thumb doesn't move a fixed number of pixels every time.
const SCROLL_PX_RANGE = [300, 1100];
const PAUSE_QUICK_MS = [2000, 6000];
const PAUSE_READ_MS = [9000, 24000];
const PAUSE_IDLE_MS = [30000, 70000];
const READ_PAUSE_CHANCE = 0.25;
const IDLE_PAUSE_CHANCE = 0.08;

// Rotate targets every ROTATE_EVERY cycles - the single-feed repetition ceiling found
// in testing (~20-25 items before it starts recycling posts) means one feed can't
// carry a whole session alone.
//
// DELIBERATELY algorithmic feeds only (Home "For You" + Explore) - NOT specific
// accounts' own profile timelines and NOT the chronological "Following" tab. Those are
// a different job: precisely reading known-good accounts (WatcherGuru, Rarma_, etc.) is
// what trend_monitor.js's lane-sweep design already does well, on its own schedule.
// Doom-scrolling exists specifically to catch what a curated account list CAN'T - the
// whole reason this script exists (see project_trend_monitor.md) is the manual test
// that found a real story (Binance/UAE) whose wording matched no curated source or
// query. Mixing the two jobs into one rotation was tried and reverted 2026-08-25: it
// diluted doom-scroll time with an account's personal-opinion noise (Rarma_'s own
// timeline surfaced Australian-politics and AI-lab-drama tweets, not just his crypto
// forensic work) instead of broad discovery. A tighter freshness gate correctly filters
// most of what these algorithmic feeds show (proven: 86/88 evaluated were stale in one
// run) - that's the expected cost of genuine discovery, not a bug to engineer away by
// switching to a precision source.
const ROTATE_EVERY = 6;
const ROTATE_TARGETS = ['https://x.com/home', 'https://x.com/explore/tabs/for-you'];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// Rolling activity log for the live dashboard - every tweet the agent looked at,
// with its outcome, so the dashboard can show "what it's done" in near-real-time
// instead of only per-session txt reports.
function appendDashboardLog(entry) {
  let items = [];
  if (fs.existsSync(DASHBOARD_LOG_FILE)) {
    try {
      items = JSON.parse(fs.readFileSync(DASHBOARD_LOG_FILE, 'utf8'));
      if (!Array.isArray(items)) items = [];
    } catch {
      items = [];
    }
  }
  const id = `x-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  items.push({ id, source: 'x', ts: new Date().toISOString(), userStatus: null, ...entry });
  // Prune anything now past a 10-day freshness window (using originTimestamp when known,
  // falling back to when it was logged) - no accumulating stale items, same bar as the
  // RSS and YouTube lanes.
  const DASHBOARD_MAX_AGE_DAYS = 10;
  items = items.filter((it) => {
    const ts = it.originTimestamp || it.ts;
    return (Date.now() - new Date(ts).getTime()) / 86400000 <= DASHBOARD_MAX_AGE_DAYS;
  });
  if (items.length > DASHBOARD_LOG_MAX) items = items.slice(-DASHBOARD_LOG_MAX);
  fs.writeFileSync(DASHBOARD_LOG_FILE, JSON.stringify(items, null, 2));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomBetween([min, max]) { return min + Math.random() * (max - min); }

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { seenTweetIds: [] };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.seenTweetIds) s.seenTweetIds = [];
    return s;
  } catch {
    return { seenTweetIds: [] };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return { pending: [] };
  try {
    const q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (!Array.isArray(q.pending)) q.pending = [];
    return q;
  } catch {
    return { pending: [] };
  }
}
function saveQueue(q) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}

const CONFIG_FILE = path.join(__dirname, 'config.local.json');
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN, telegramChatId: process.env.TELEGRAM_CHAT_ID };
}
const config = loadConfig();
async function sendTelegram(text) {
  if (!config.telegramBotToken || !config.telegramChatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: config.telegramChatId, text }),
    });
    const data = await res.json();
    if (!data.ok) log(`ERROR: Telegram send failed: ${JSON.stringify(data)}`);
    return data.ok;
  } catch (e) {
    log(`ERROR: Telegram send threw: ${e.message}`);
    return false;
  }
}

// Live price context so the model can judge significance against REAL recent price
// action (e.g. "$81k" is a big deal after 3 weeks stuck at $62-65k) instead of only
// what the tweet's own wording happens to state. Refreshed periodically, not per-tweet.
let priceContextCache = { text: '(price data unavailable)', fetchedAt: 0 };
const PRICE_CONTEXT_REFRESH_MS = 20 * 60 * 1000;
const PRICE_CONTEXT_ASSETS = [
  { id: 'bitcoin', symbol: 'BTC' },
  { id: 'ethereum', symbol: 'ETH' },
  { id: 'solana', symbol: 'SOL' },
];

async function fetchPriceContext() {
  if (Date.now() - priceContextCache.fetchedAt < PRICE_CONTEXT_REFRESH_MS) return priceContextCache.text;
  try {
    const lines = [];
    for (const { id, symbol } of PRICE_CONTEXT_ASSETS) {
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30`);
      if (!res.ok) continue;
      const data = await res.json();
      const prices = (data.prices || []).map((p) => p[1]);
      if (!prices.length) continue;
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const latest = prices[prices.length - 1];
      lines.push(`${symbol}: currently ~$${Math.round(latest).toLocaleString()}, 30-day range $${Math.round(min).toLocaleString()}-$${Math.round(max).toLocaleString()}`);
      await sleep(1500); // be gentle with CoinGecko's free tier
    }
    if (lines.length) {
      priceContextCache = { text: lines.join('\n'), fetchedAt: Date.now() };
      log(`Refreshed price context:\n${priceContextCache.text}`);
    }
  } catch (e) {
    log(`WARN: price context fetch failed (${e.message}), keeping previous context`);
  }
  return priceContextCache.text;
}

async function scoreWithOllama(tweetText) {
  const priceContext = await fetchPriceContext();
  const prompt = `You are an experienced crypto news editor doing a live doom-scroll of X's home feed, deciding in real time which tweets are worth a human's attention as breaking or noteworthy news.

Use your own judgment for what counts as newsworthy - do not restrict yourself to a fixed list of categories. A price milestone or notable move, a bank or institution doing something notable with crypto, a new use of a token/stablecoin, an exploit, a regulatory move, a partnership, an on-chain data point, or anything else you'd genuinely expect a crypto news outlet to report on can qualify - if it's concrete and specific enough that a reader could verify it, it counts.

Treat as noise: generic hype with no real content, ads, giveaways, vague opinions with no factual claim, memes, a meme-coin shill, a prediction/price call with no basis given, or an old story just being reposted/quote-tweeted with commentary.

Reference market data (use this to judge whether a price mentioned in the tweet is actually significant - e.g. a price far outside the recent range is a real move even if the tweet doesn't spell out "breakout"; a price well inside the recent range is not news just because a number is stated):
${priceContext}

Examples:
Tweet: "Bitcoin just hit a new all-time high of $135,000" -> VERDICT: YES | REASON: Concrete, verifiable price milestone.
Tweet: "gm fam WAGMI lets pump this coin to the moon guys dont miss out link in bio" -> VERDICT: NO | REASON: Generic hype with no factual claim.
Tweet: "Standard Chartered has become the first bank to distribute Hong Kong's HKDAP stablecoin for institutional payments" -> VERDICT: YES | REASON: Specific, verifiable institutional adoption event.
Tweet: "BTC at $81,000 right now" (given a recent range of $62k-65k above) -> VERDICT: YES | REASON: Price is well outside the recent trading range, a genuine breakout even though the tweet doesn't say so explicitly.
Tweet: "ETH still chilling around its usual price today" (given a price inside the recent range above) -> VERDICT: NO | REASON: No notable move, price is within its normal recent range.

Tweet: """${tweetText}"""

Reply with EXACTLY one line in this format, nothing else:
VERDICT: YES|NO | REASON: <one short sentence>`;

  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const out = (data.response || '').trim();
    const isYes = /VERDICT:\s*YES/i.test(out);
    const reasonMatch = out.match(/REASON:\s*(.+)/i);
    return { newsworthy: isYes, reason: reasonMatch ? reasonMatch[1].trim() : out.slice(0, 140) };
  } catch (e) {
    log(`WARN: Ollama scoring failed (${e.message}) - is 'ollama serve' running with ${OLLAMA_MODEL} pulled? Skipping this tweet rather than guessing.`);
    return { newsworthy: false, reason: 'ollama unavailable' };
  }
}

function extractTweetId(href) {
  const m = href && href.match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

// Same origin-timestamp logic as trend_monitor.js: take the OLDEST <time datetime>
// inside the article (covers quote-tweets - a fresh wrapper around old news should
// not read as fresh).
async function scrapeVisibleArticles(page) {
  const raw = await page.$$eval('article', (articles) =>
    articles.map((a) => {
      const textEl = a.querySelector('[data-testid="tweetText"]');
      const linkEl = a.querySelector('a[href*="/status/"]');
      const userEl = a.querySelector('[data-testid="User-Name"]');
      const times = Array.from(a.querySelectorAll('time'))
        .map((t) => t.getAttribute('datetime'))
        .filter(Boolean);
      return {
        text: textEl ? textEl.innerText : '',
        href: linkEl ? linkEl.getAttribute('href') : '',
        author: userEl ? userEl.innerText.split('\n')[0] : 'unknown',
        times,
      };
    })
  );
  const now = Date.now();
  return raw
    .filter((t) => t.text && t.href && t.times.length)
    .map((t) => {
      const id = extractTweetId(t.href);
      const timestamps = t.times.map((iso) => new Date(iso).getTime()).filter((n) => !Number.isNaN(n));
      const originTime = timestamps.length ? Math.min(...timestamps) : null;
      return {
        ...t,
        id,
        url: `https://x.com${t.href}`,
        originAgeMinutes: originTime ? Math.round((now - originTime) / 60000) : null,
        originTimestamp: originTime ? new Date(originTime).toISOString() : null,
      };
    })
    .filter((t) => t.id && t.originAgeMinutes !== null);
}

let candidateCounter = 1;

async function processArticle(t, state, report) {
  const seen = new Set(state.seenTweetIds);
  if (seen.has(t.id)) return null;
  seen.add(t.id);
  state.seenTweetIds = Array.from(seen).slice(-8000);
  saveState(state);

  // The age gate decides ELIGIBILITY FOR THE EARLY-ALERT QUEUE, not newsworthiness -
  // those are different questions. Every tweet still gets judged by Ollama regardless of
  // age; a stale-but-newsworthy item is logged to the report (for the daily pipeline's
  // broader research) instead of being silently discarded, which is what happened before
  // 2026-08-25 (a real multi-chain exploit saga from Rarma_ was thrown away unseen because
  // it was hours old, never because it wasn't news).
  const isStale = t.originAgeMinutes > MAX_ORIGIN_AGE_MINUTES;

  const { newsworthy, reason } = await scoreWithOllama(t.text);
  if (!newsworthy) {
    log(`REJECT (${reason}) ${t.author} [${t.originAgeMinutes}m]: ${t.text.slice(0, 100).replace(/\n/g, ' ')}`);
    report.rejected.push({ author: t.author, ageMin: t.originAgeMinutes, reason, text: t.text, url: t.url });
    appendDashboardLog({ status: 'rejected', author: t.author, ageMin: t.originAgeMinutes, originTimestamp: t.originTimestamp, reason, text: t.text, url: t.url });
    return null;
  }

  if (isStale) {
    log(`NEWSWORTHY BUT STALE (${t.originAgeMinutes}m > ${MAX_ORIGIN_AGE_MINUTES}m gate, ${reason}) ${t.author}: ${t.text.slice(0, 100).replace(/\n/g, ' ')}`);
    report.staleButNewsworthy.push({ author: t.author, ageMin: t.originAgeMinutes, reason, text: t.text, url: t.url });
    appendDashboardLog({ status: 'stale_newsworthy', author: t.author, ageMin: t.originAgeMinutes, originTimestamp: t.originTimestamp, reason, text: t.text, url: t.url });
    return null; // real news, but too old for the early-alert queue - not queued to trend_pending_queue.json
  }

  const candidateId = candidateCounter++;
  const candidate = {
    candidateId,
    text: t.text,
    url: t.url,
    author: t.author,
    lane: 'doom-scroll',
    originAgeMinutes: t.originAgeMinutes,
    reason,
    flaggedAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(), // doom-scroll candidates already passed freshness+Ollama triage; queued directly, no separate Telegram approval step
  };

  const queue = loadQueue();
  queue.pending.push(candidate);
  saveQueue(queue);

  await sendTelegram(
    [
      `DOOM-SCROLL CATCH #${candidateId}`,
      `From: ${t.author}`,
      `Origin age: ~${t.originAgeMinutes} min`,
      `Why: ${reason}`,
      ``,
      t.text.slice(0, 300),
      ``,
      t.url,
      ``,
      `Queued directly to the pipeline.`,
    ].join('\n')
  );
  log(`CAUGHT #${candidateId} from ${t.author} (origin age ~${t.originAgeMinutes}m): ${reason}`);
  report.caught.push({ author: t.author, ageMin: t.originAgeMinutes, reason, text: t.text, url: t.url });
  appendDashboardLog({ status: 'caught', candidateId, author: t.author, ageMin: t.originAgeMinutes, originTimestamp: t.originTimestamp, reason, text: t.text, url: t.url });
  return candidate;
}

async function humanScroll(page) {
  const px = randomBetween(SCROLL_PX_RANGE);
  await page.mouse.wheel(0, px);

  const roll = Math.random();
  let pause;
  if (roll < IDLE_PAUSE_CHANCE) pause = randomBetween(PAUSE_IDLE_MS);
  else if (roll < IDLE_PAUSE_CHANCE + READ_PAUSE_CHANCE) pause = randomBetween(PAUSE_READ_MS);
  else pause = randomBetween(PAUSE_QUICK_MS);
  await sleep(pause);
  return { px: Math.round(px), pause: Math.round(pause) };
}

async function runSession(cycles) {
  if (!fs.existsSync(X_STATE_FILE)) {
    log('FATAL: x_state.json not found. Run "node x_login.js" first.');
    process.exit(1);
  }

  log(`Doom-scroll session starting: ${cycles} cycles, freshness gate ${MAX_ORIGIN_AGE_MINUTES}min.`);
  const browser = await chromium.launch({
    headless: false, // headless never got past X's bot wall in prior testing - must run headed
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ storageState: X_STATE_FILE });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  const state = loadState();

  let caught = 0;
  let evaluated = 0;
  const report = { caught: [], rejected: [], staleButNewsworthy: [] };

  for (let i = 0; i < cycles; i++) {
    if (i === 0 || i % ROTATE_EVERY === 0) {
      const target = ROTATE_TARGETS[Math.floor(i / ROTATE_EVERY) % ROTATE_TARGETS.length];
      log(`Cycle ${i + 1}/${cycles}: navigating to ${target}`);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(randomBetween(PAUSE_READ_MS));
      try {
        await page.waitForSelector('article', { timeout: 10000 });
      } catch {
        log('WARN: no articles loaded on this page, continuing anyway');
      }
    }

    let articles = [];
    try {
      articles = await scrapeVisibleArticles(page);
    } catch (e) {
      log(`WARN: scrape failed mid-cycle: ${e.message}`);
    }

    for (const t of articles) {
      evaluated++;
      const result = await processArticle(t, state, report);
      if (result) caught++;
    }

    const { px, pause } = await humanScroll(page);
    log(`Cycle ${i + 1}/${cycles}: ${articles.length} visible, scrolled ${px}px, paused ${pause}ms`);
  }

  await browser.close();
  log(`Session done: ${cycles} cycles, ${evaluated} tweets evaluated, ${caught} caught.`);
  console.log(`\n=== SESSION SUMMARY: ${caught} candidate(s) caught, queued to trend_pending_queue.json ===`);

  writeReportFile(report);
}

function fmtEntry(e) {
  return `[${e.author}] [${e.ageMin}m old]${e.reason ? ` [${e.reason}]` : ''}\n${e.text.trim()}\n${e.url}\n`;
}

function writeReportFile(report) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(__dirname, `doom_scroll_report_${stamp}.txt`);
  const lines = [];

  lines.push(`=== CAUGHT (${report.caught.length}) - passed freshness + Ollama, queued ===\n`);
  report.caught.forEach((e, i) => lines.push(`${i + 1}. ${fmtEntry(e)}`));

  lines.push(`\n=== REJECTED BY OLLAMA (${report.rejected.length}) - fresh enough, but judged not newsworthy ===\n`);
  report.rejected.forEach((e, i) => lines.push(`${i + 1}. ${fmtEntry(e)}`));

  lines.push(`\n=== NEWSWORTHY BUT STALE (${report.staleButNewsworthy.length}) - real news per Ollama, too old for the early-alert queue - worth the daily pipeline's broader research, not urgent ===\n`);
  report.staleButNewsworthy.forEach((e, i) => lines.push(`${i + 1}. ${fmtEntry(e)}`));

  fs.writeFileSync(outPath, lines.join('\n'));
  log(`Report written: ${outPath}`);
  console.log(`Report: ${outPath}`);
}

if (require.main === module) {
  const cyclesArg = parseInt(process.argv[2], 10);
  const cycles = Number.isFinite(cyclesArg) && cyclesArg > 0 ? cyclesArg : 15;

  runSession(cycles).catch((e) => {
    log(`FATAL: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = { scoreWithOllama, fetchPriceContext };
