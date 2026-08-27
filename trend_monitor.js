// CryptoNewsLive Trend Monitor v2 - catches news BEFORE it trends.
//
// v1 (search-query sweep only) was rebuilt 2026-08-21 after a manual doom-scroll
// test proved two things the hard way:
//   1. Canned exact-phrase search queries miss most real headlines' actual
//      wording (the Binance/UAE story matched NONE of v1's 25 phrases).
//   2. A single X feed/account physically runs out of new material within
//      20-25 items in one sitting - it cannot carry the whole job alone.
// See project_trend_monitor.md in the memory folder for the full writeup.
//
// v2 design: multiple independent SOURCE LANES, each contributing a few
// candidates, summed together - instead of one clever technique trying to
// carry all of it:
//   - "wire" lane: fast-posting news accounts (Watcher.Guru, BSCN, Wu
//     Blockchain) read chronologically off their own profile timeline, not
//     search. Tight freshness window since they post "JUST IN" style often.
//   - "analyst" lane: named independent on-chain analysts/researchers
//     (e.g. @Rarma_, @PhyrexNi). These produced the best, most original
//     catches in testing - real forensic work, not wire reposts. Looser
//     freshness window since they post less often.
//   - "alert" lane: specialized security bots (CertiKAlert, PeckShieldAlert).
//     Hack/exploit-only by nature (confirmed one-sided in testing) - kept
//     deliberately small relative to the other lanes so the queue doesn't
//     skew negative, matching the daily pipeline's own pump/dump balance rule.
//   - "query" lane: the original exact-phrase X-search sweep, KEPT but
//     demoted to a backstop that runs less often - useful only for the rare
//     case a project's own account breaks something before any wire/analyst
//     has picked it up yet.
//
// FRESHNESS is measured from the ORIGIN report, not whichever post is found:
// every <time> element inside a candidate's <article> is read via its
// machine-readable `datetime` attribute (not the human "2h ago" text, which
// was proven unreliable - a 5-minute-old quote-tweet reacting to a 9-hour-old
// original doesn't make the story fresh). The OLDEST datetime found in the
// article is the origin time; that is what gets checked against the lane's
// maxAgeMinutes.
//
// Every fresh candidate still gets one cheap local-AI relevance/novelty pass
// (Ollama, small model) before reaching Telegram for approval. Approved ones
// get appended to trend_pending_queue.json, same as v1.
//
// Uses its OWN X login (x_state.json, captured by x_login.js) - deliberately
// NOT the Hopium Influencer posting profile.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const STATE_FILE = path.join(__dirname, 'trend_monitor_state.json');
const LOG_FILE = path.join(__dirname, 'trend_monitor.log');
const QUERIES_FILE = path.join(__dirname, 'queries.json');
const SOURCES_FILE = path.join(__dirname, 'sources.json');
const X_STATE_FILE = path.join(__dirname, 'x_state.json');
const QUEUE_FILE = 'C:\\Users\\Martin\\Documents\\trend_pending_queue.json';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // full lane sweep every 10 min (profile reads are cheap - no need for v1's 20 min)
const QUERY_LANE_EVERY_N_SWEEPS = 3; // the search-based backstop lane only runs every 3rd sweep (~30 min)
const TELEGRAM_POLL_MS = 30 * 1000;
const DELAY_BETWEEN_HITS_MS = [6000, 12000]; // randomized, be gentle with X, between every profile/query hit
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5:3b';
const MAX_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1000; // stop nagging about stale unanswered candidates after 24h

const CONFIG_FILE = path.join(__dirname, 'config.local.json');
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN, telegramChatId: process.env.TELEGRAM_CHAT_ID };
}
const config = loadConfig();
const TELEGRAM_BOT_TOKEN = config.telegramBotToken;
const TELEGRAM_CHAT_ID = config.telegramChatId;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Missing Telegram credentials. Create config.local.json (see config.example.json).');
  process.exit(1);
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { seenTweetIds: [], awaitingApproval: {}, nextCandidateId: 1, telegramUpdateOffset: 0, sweepCount: 0 };
  }
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.awaitingApproval) s.awaitingApproval = {};
    if (!s.nextCandidateId) s.nextCandidateId = 1;
    if (!s.telegramUpdateOffset) s.telegramUpdateOffset = 0;
    if (!s.sweepCount) s.sweepCount = 0;
    return s;
  } catch (e) {
    log(`WARN: state file unreadable (${e.message}), starting fresh`);
    return { seenTweetIds: [], awaitingApproval: {}, nextCandidateId: 1, telegramUpdateOffset: 0, sweepCount: 0 };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadSources() {
  // sources.json holds the wire/analyst/alert account lanes (see sources.example structure
  // in this same repo). queries.json remains separate - it is the "query" lane's own input.
  const s = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
  return s.lanes || [];
}

function loadQueries() {
  const q = JSON.parse(fs.readFileSync(QUERIES_FILE, 'utf8'));
  return q.queries || [];
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return { pending: [] };
  try {
    const q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (!Array.isArray(q.pending)) q.pending = [];
    return q;
  } catch (e) {
    return { pending: [] };
  }
}
function saveQueue(q) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    const data = await res.json();
    if (!data.ok) log(`ERROR: Telegram send failed: ${JSON.stringify(data)}`);
    return data.ok;
  } catch (e) {
    log(`ERROR: Telegram send threw: ${e.message}`);
    return false;
  }
}

async function getTelegramUpdates(offset) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return [];
    return data.result || [];
  } catch (e) {
    log(`ERROR: Telegram getUpdates threw: ${e.message}`);
    return [];
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomDelay([min, max]) { return min + Math.random() * (max - min); }

async function scoreWithOllama(tweetText) {
  const prompt = `You are a triage filter for a crypto news desk. A tweet either describes a CONCRETE, SPECIFIC, VERIFIABLE crypto event (a protocol going live, an exploit, a listing, a funding round, a partnership, an unlock, a governance vote, a regulatory development, a real on-chain/market data point) that looks worth a human's attention - or it is noise (generic hype, ads, giveaways, vague opinion, memes, a meme-coin shill, a prediction call with no real basis).

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

// Reads every <time datetime="..."> inside an article - the wrapper post's own
// time plus, for a quote-tweet, the quoted/original post's time nested inside.
// Origin time = the OLDEST of those, which is what freshness should be judged
// against (a fresh quote-tweet reacting to old news is still old news).
async function scrapeArticles(page, limit) {
  const raw = await page.$$eval('article', (articles, lim) =>
    articles.slice(0, lim).map((a) => {
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
    }), limit
  );
  const now = Date.now();
  return raw
    .filter((t) => t.text && t.href && t.times.length)
    .map((t) => {
      const id = extractTweetId(t.href);
      const timestamps = t.times.map((iso) => new Date(iso).getTime()).filter((n) => !Number.isNaN(n));
      const originTime = timestamps.length ? Math.min(...timestamps) : null;
      const postTime = timestamps.length ? timestamps[0] : null;
      return {
        ...t,
        id,
        url: `https://x.com${t.href}`,
        originAgeMinutes: originTime ? Math.round((now - originTime) / 60000) : null,
        postAgeMinutes: postTime ? Math.round((now - postTime) / 60000) : null,
      };
    })
    .filter((t) => t.id && t.originAgeMinutes !== null);
}

async function scrapeProfileLane(page, lane) {
  const url = `https://x.com/${lane.handle}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  try {
    await page.waitForSelector('article', { timeout: 8000 });
  } catch {
    return [];
  }
  const articles = await scrapeArticles(page, lane.limit || 8);
  return articles.filter((a) => a.originAgeMinutes <= lane.maxAgeMinutes);
}

async function scrapeQueryLane(page, query, maxAgeMinutes) {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  try {
    await page.waitForSelector('article', { timeout: 8000 });
  } catch {
    return [];
  }
  const articles = await scrapeArticles(page, 8);
  return articles.filter((a) => a.originAgeMinutes <= maxAgeMinutes);
}

async function processCandidate(t, state, laneLabel) {
  const seen = new Set(state.seenTweetIds);
  if (seen.has(t.id)) return false;
  seen.add(t.id);
  state.seenTweetIds = Array.from(seen).slice(-8000);

  const { newsworthy, reason } = await scoreWithOllama(t.text);
  if (!newsworthy) return false;

  const candidateId = state.nextCandidateId++;
  state.awaitingApproval[candidateId] = {
    text: t.text,
    url: t.url,
    author: t.author,
    lane: laneLabel,
    originAgeMinutes: t.originAgeMinutes,
    reason,
    flaggedAt: new Date().toISOString(),
  };

  const msg = [
    `TREND CANDIDATE #${candidateId} [${laneLabel}]`,
    `From: ${t.author}`,
    `Origin age: ~${t.originAgeMinutes} min`,
    `Why: ${reason}`,
    ``,
    t.text.slice(0, 300),
    ``,
    t.url,
    ``,
    `Reply with just "${candidateId}" to send this into the pipeline.`,
  ].join('\n');
  await sendTelegram(msg);
  log(`Flagged candidate #${candidateId} [${laneLabel}] from ${t.author} (origin age ~${t.originAgeMinutes}m)`);
  return true;
}

async function runSweep(browser, state) {
  const lanes = loadSources();
  const context = await browser.newContext({ storageState: fs.existsSync(X_STATE_FILE) ? X_STATE_FILE : undefined });
  const page = await context.newPage();
  let newCandidates = 0;

  const profileLanes = lanes.filter((l) => l.type === 'profile');
  for (const lane of profileLanes) {
    let articles = [];
    try {
      articles = await scrapeProfileLane(page, lane);
    } catch (e) {
      log(`WARN: profile lane "${lane.handle}" failed: ${e.message}`);
    }
    for (const t of articles) {
      const flagged = await processCandidate(t, state, `${lane.laneName || 'wire'}:${lane.handle}`);
      if (flagged) newCandidates++;
    }
    saveState(state);
    await sleep(randomDelay(DELAY_BETWEEN_HITS_MS));
  }

  // Query lane (backstop) only runs every Nth sweep - it's the least reliable/highest-noise
  // lane (proven in testing: exact phrases miss most real wording), kept only for the rare
  // case a project breaks its own news before any account in the other lanes reposts it.
  state.sweepCount = (state.sweepCount || 0) + 1;
  if (state.sweepCount % QUERY_LANE_EVERY_N_SWEEPS === 0) {
    const queryLane = lanes.find((l) => l.type === 'query') || { maxAgeMinutes: 60 };
    const queries = loadQueries();
    for (const query of queries) {
      let articles = [];
      try {
        articles = await scrapeQueryLane(page, query, queryLane.maxAgeMinutes);
      } catch (e) {
        log(`WARN: query lane "${query}" failed: ${e.message}`);
      }
      for (const t of articles) {
        const flagged = await processCandidate(t, state, 'query-backstop');
        if (flagged) newCandidates++;
      }
      saveState(state);
      await sleep(randomDelay(DELAY_BETWEEN_HITS_MS));
    }
  }

  await context.close();

  const now = Date.now();
  for (const [id, c] of Object.entries(state.awaitingApproval)) {
    if (now - new Date(c.flaggedAt).getTime() > MAX_CANDIDATE_AGE_MS) delete state.awaitingApproval[id];
  }
  saveState(state);

  log(`Sweep #${state.sweepCount} done: ${profileLanes.length} profile lane(s)${state.sweepCount % QUERY_LANE_EVERY_N_SWEEPS === 0 ? ' + query backstop' : ''}, ${newCandidates} new candidate(s) sent to Telegram.`);
}

async function checkApprovals(state) {
  const updates = await getTelegramUpdates(state.telegramUpdateOffset);
  if (updates.length === 0) return;

  for (const upd of updates) {
    state.telegramUpdateOffset = upd.update_id + 1;
    const text = upd.message && upd.message.text ? upd.message.text.trim() : '';
    const idMatch = text.match(/^\d+$/) ? text : (text.match(/^\s*(?:yes\s+)?(\d+)/i) || [])[1];
    if (!idMatch) continue;

    const candidate = state.awaitingApproval[idMatch];
    if (!candidate) continue;

    const queue = loadQueue();
    queue.pending.push({ ...candidate, candidateId: idMatch, approvedAt: new Date().toISOString() });
    saveQueue(queue);
    delete state.awaitingApproval[idMatch];
    log(`Candidate #${idMatch} approved by Martin, queued for pipeline (${queue.pending.length} pending).`);
    await sendTelegram(`Queued #${idMatch} for the pipeline.`);
  }
  saveState(state);
}

async function main() {
  log('Trend monitor v2 starting (multi-lane profile reads + query backstop + Ollama triage + Telegram approval).');
  if (!fs.existsSync(X_STATE_FILE)) {
    log('WARN: x_state.json not found. Run "npm run login" first to capture an X session.');
  }
  if (!fs.existsSync(SOURCES_FILE)) {
    log('FATAL: sources.json not found. Create it before running (see sources.example.json).');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const state = loadState();

  const sweepLoop = async () => {
    try {
      await runSweep(browser, state);
    } catch (e) {
      log(`ERROR in sweep: ${e.stack || e.message}`);
    }
    setTimeout(sweepLoop, SWEEP_INTERVAL_MS);
  };
  sweepLoop();

  setInterval(() => {
    checkApprovals(state).catch((e) => log(`ERROR checking approvals: ${e.stack || e.message}`));
  }, TELEGRAM_POLL_MS);
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
