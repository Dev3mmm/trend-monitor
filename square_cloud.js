// Cloud Binance Square lane. Runs inside the GitHub Actions sweep (PC on or off).
// Reads fresh 'caught' X items from dashboard_activity_log.json, drops duplicate stories,
// paces posts (one per SQUARE_MIN_GAP_MS), AI-paraphrases each tweet with attribution,
// sends the finished post to Telegram, and posts it to Binance Square with the tweet's images.
// State lives in square_state.json (committed by the workflow, so it survives between runs).
// Key comes from env BINANCE_SQUARE_OPENAPI_KEY (GitHub secret). Without it: Telegram preview only.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ACTIVITY_FILE = path.join(__dirname, 'dashboard_activity_log.json');
const STATE_FILE = path.join(__dirname, 'square_state.json');
const CONFIG_FILE = path.join(__dirname, 'config.local.json');
const SKILL_DIR = path.join(__dirname, 'square-post');
const TMP_DIR = path.join(__dirname, 'square_tmp');

const MIN_GAP_MS = 25 * 60 * 1000;
const MAX_POSTS_PER_DAY = 12;
const MAX_ITEM_AGE_MS = 3 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5:3b';
const STOP = new Set('the a an and or of to in on for with at by from as is are was were be been this that it its has have had will just now new says said after over into about than more amid their his her they you your our not but'.split(' '));

const config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
const KEY = (process.env.BINANCE_SQUARE_OPENAPI_KEY || '').trim();
const DRY = process.env.SQUARE_DRY_RUN === '1' || config.squareDryRun === true;

function log(m) { console.log(`[square] ${m}`); }
function load(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function saveAtomic(f, o) { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f); }

async function telegram(text) {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: String(config.telegramChatId), text: text.slice(0, 4000) }),
    });
  } catch (e) { log(`telegram failed: ${e.message}`); }
}

async function ollama(prompt) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.3 } }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  return ((await res.json()).response || '').trim();
}

const words = (t) => new Set(t.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9$%.\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a, b) => { let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i || 1); };
const anchors = (t) => new Set((t.match(/\$[A-Za-z]{2,10}\b|\d[\d,.]*[kmbKMB%]?/g) || []).map((s) => s.toLowerCase()));

async function isDuplicate(text, others) {
  const w = words(text), an = anchors(text);
  for (const o of others) {
    const j = jaccard(w, words(o.text));
    let shared = 0; const oan = anchors(o.text); for (const x of an) if (oan.has(x)) shared++;
    if (j >= 0.5 || (shared >= 2 && j >= 0.3)) return true;
    if (j >= 0.22 || shared >= 1) {
      try {
        const out = await ollama(`Do these two crypto news tweets report the SAME underlying event (same project/entity and same development), even if worded differently?\n\nA: """${text.slice(0, 400)}"""\n\nB: """${o.text.slice(0, 400)}"""\n\nReply with exactly one word: SAME or DIFFERENT.`);
        if (/^SAME/i.test(out)) return true;
      } catch { /* model down: treat as different */ }
    }
  }
  return false;
}

async function paraphrase(text) {
  let out = await ollama(`Rewrite this crypto news tweet as a short news post of 2 to 3 sentences in your own words, for a news feed.
Rules: keep every name, number, amount and date exactly as given; add no facts that are not in the tweet; neutral news tone; no emojis, no hashtags, no em dashes, no calls to buy or sell; do not mention the tweet or the account; output only the rewritten text.

Tweet: """${text}"""`);
  out = out.replace(/^["'\s]+|["'\s]+$/g, '').replace(/[—–]/g, '-');
  const src = new Set((text.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '')));
  const bad = (out.match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '')).filter((n) => !src.has(n));
  if (bad.length) throw new Error(`paraphrase added numbers not in source: ${bad.join(', ')}`);
  if (out.length < 60 || out.length > 700) throw new Error(`paraphrase length ${out.length} out of range`);
  return out;
}

async function download(url, name) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  const f = path.join(TMP_DIR, name + (ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg'));
  fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  return f;
}

function postToSquare(text, images) {
  const script = images.length ? 'post-image.mjs' : 'post-text.mjs';
  const args = [path.join('scripts', script), '--text', text];
  if (images.length) args.push('--images', images.slice(0, 4).join(','));
  const r = spawnSync(process.execPath, args, { cwd: SKILL_DIR, env: { ...process.env, BINANCE_SQUARE_OPENAPI_KEY: KEY }, encoding: 'utf8', timeout: 180000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.status !== 0) return { ok: false, error: out.trim().slice(-300).replace(KEY, '***') };
  return { ok: true, id: (out.match(/ID:\s*(\S+)/) || [])[1], link: (out.match(/Link:\s*(\S+)/) || [])[1] };
}

(async () => {
  const state = load(STATE_FILE, { seen: [], queue: [], posted: [], lastPostAt: 0 });
  const now = Date.now();
  const activity = load(ACTIVITY_FILE, []);

  // 1. enqueue newly caught, still-fresh items (dedupe against queue + recent posts)
  const seen = new Set(state.seen);
  state.posted = state.posted.filter((p) => now - p.at < DEDUPE_WINDOW_MS);
  let queued = 0, dups = 0;
  for (const it of activity.filter((a) => a.status === 'caught' && !seen.has(a.id))) {
    seen.add(it.id);
    const origin = new Date(it.originTimestamp || it.ts).getTime();
    if (now - origin > MAX_ITEM_AGE_MS) continue;
    if (await isDuplicate(it.text, [...state.queue, ...state.posted])) { dups++; continue; }
    state.queue.push({ text: it.text, url: it.url, images: (it.images || []).slice(0, 4), enqueuedAt: now });
    queued++;
  }
  state.seen = Array.from(seen).slice(-2000);
  state.queue = state.queue.filter((q) => now - q.enqueuedAt < MAX_ITEM_AGE_MS);
  log(`new queued: ${queued}, duplicates dropped: ${dups}, waiting in queue: ${state.queue.length}`);

  // 2. post at most one item this run, respecting the gap and daily cap
  const today = new Date().toISOString().slice(0, 10);
  const postedToday = state.posted.filter((p) => p.status === 'posted' && new Date(p.at).toISOString().slice(0, 10) === today).length;
  if (state.queue.length && now - state.lastPostAt >= MIN_GAP_MS && postedToday < MAX_POSTS_PER_DAY) {
    const item = state.queue.shift();
    const handle = (item.url.match(/x\.com\/([^/]+)\/status/) || [])[1] || 'source';
    let text;
    try { text = `${await paraphrase(item.text)}\n\nSource: @${handle} ${item.url}`; }
    catch (e) {
      state.posted.push({ text: item.text, at: now, status: 'skipped', reason: e.message });
      log(`skipped @${handle}: ${e.message}`);
      saveAtomic(STATE_FILE, state); return;
    }
    const imgs = [];
    for (const [i, u] of (item.images || []).entries()) { try { imgs.push(await download(u, `sq_${now}_${i}`)); } catch { /* post without it */ } }

    if (DRY || !KEY) {
      await telegram(`SQUARE PREVIEW (not posted: ${DRY ? 'dry run' : 'no key'}; ${imgs.length} img)\n\n${text}`);
      state.posted.push({ text: item.text, at: now, status: 'dryrun' });
    } else {
      const r = postToSquare(text, imgs);
      state.lastPostAt = now;
      state.posted.push({ text: item.text, at: now, status: r.ok ? 'posted' : 'failed', link: r.link, error: r.ok ? undefined : r.error });
      await telegram(r.ok ? `POSTED to Binance Square (${imgs.length} img)\n${r.link || r.id || ''}\n\n${text}` : `SQUARE POST FAILED: ${r.error}\n\n${text}`);
      log(r.ok ? `posted @${handle}` : `FAILED @${handle}: ${r.error}`);
    }
  }
  saveAtomic(STATE_FILE, state);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
})().catch((e) => { console.error('[square] ERROR', e.message); process.exit(0); }); // never fail the sweep over this lane
