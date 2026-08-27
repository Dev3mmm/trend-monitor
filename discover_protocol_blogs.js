// Tries common RSS/blog feed patterns against each protocol's homepage. Verified content
// only - a 200 status alone isn't enough (learned the hard way with regulator/exchange
// sources this project). Resumable: skips homepages already resolved (found or exhausted).
// Different rate-limit situation than the CoinGecko steps - these are ~234 different
// third-party hosts, not one API, so a short per-request timeout + small delay is enough,
// no need for the 8-25s CoinGecko-scale caution.

const fs = require('fs');

// Atomic write (temp file + rename) - a direct writeFileSync got caught mid-write by a PC
// restart once, corrupting the whole progress file into garbage and losing all discovery
// progress (the CoinGecko-sourced files survived fine since they're written less often).
// Rename is atomic on the same filesystem, so a kill mid-write can only lose the LATEST
// item, never corrupt everything already saved.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const OUT_FILE = 'protocol_blog_sources.json';
const REQUEST_TIMEOUT_MS = 5000;
const DELAY_MS = 1500;
const PATTERNS = [
  '/blog/feed',
  '/feed',
  '/rss.xml',
  '/blog/rss.xml',
  '/news/rss',
  '/blog/feed.xml',
  '/rss',
  '/feed.xml',
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function tryFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    // Real verification, not just status - must actually contain RSS/Atom item markup.
    if (/<rss[\s>]/i.test(text) || /<feed[\s>]/i.test(text) || /<item[\s>]/i.test(text) || /<entry[\s>]/i.test(text)) {
      return text;
    }
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function discoverForHomepage(homepage) {
  let base;
  try {
    base = new URL(homepage).origin;
  } catch {
    return null;
  }
  for (const pattern of PATTERNS) {
    const url = base + pattern;
    const content = await tryFetch(url);
    if (content) return url;
    await sleep(300); // small gap between pattern attempts on the same host
  }
  return null;
}

async function main() {
  const candidates = JSON.parse(fs.readFileSync('protocol_homepages.json', 'utf8')).filter((c) => c.homepage);
  let results = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : [];
  const done = new Set(results.map((r) => r.id));

  let foundCount = results.filter((r) => r.feedUrl).length;

  for (const c of candidates) {
    if (done.has(c.id)) continue;
    const feedUrl = await discoverForHomepage(c.homepage);
    results.push({ id: c.id, symbol: c.symbol, name: c.name, homepage: c.homepage, feedUrl });
    writeJsonAtomic(OUT_FILE, results);
    if (feedUrl) {
      foundCount++;
      console.log(`FOUND [${foundCount}] ${c.name}: ${feedUrl}`);
    } else {
      console.log(`none: ${c.name} (${c.homepage})`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nDone. ${results.length} of ${candidates.length} checked. ${results.filter((r) => r.feedUrl).length} real feeds found.`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
