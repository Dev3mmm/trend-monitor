// Fetches homepage URL for each protocol candidate via CoinGecko's per-coin endpoint
// (minimal fields only, to keep it light). Resumable: skips coins already in the output
// file, so a network blip mid-run doesn't lose earlier progress.

const fs = require('fs');
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Atomic write (temp file + rename) - a direct writeFileSync in the sibling
// discover_protocol_blogs.js got caught mid-write by a PC restart once, corrupting its
// whole progress file into garbage. Rename is atomic on the same filesystem, so a kill
// mid-write can only lose the LATEST item, never corrupt everything already saved.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const OUT_FILE = 'protocol_homepages.json';
const DELAY_MS = 9000;

async function main() {
  const candidates = JSON.parse(fs.readFileSync('protocol_candidates.json', 'utf8'));
  let results = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : [];
  const done = new Set(results.map((r) => r.id));

  for (const c of candidates) {
    if (done.has(c.id)) continue;
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${c.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`);
      if (!res.ok) {
        console.log(`${c.id}: HTTP ${res.status}`);
        if (res.status === 429) { await sleep(30000); continue; } // retry same coin after backoff
        results.push({ ...c, homepage: null, error: `HTTP ${res.status}` });
        writeJsonAtomic(OUT_FILE, results);
        await sleep(DELAY_MS);
        continue;
      }
      const data = await res.json();
      const homepage = (data.links && data.links.homepage && data.links.homepage.find((h) => h)) || null;
      results.push({ ...c, homepage });
      writeJsonAtomic(OUT_FILE, results);
      console.log(`${c.id}: ${homepage || '(none)'} [${results.length}/${candidates.length}]`);
    } catch (e) {
      console.log(`${c.id}: error ${e.message}`);
      results.push({ ...c, homepage: null, error: e.message });
      writeJsonAtomic(OUT_FILE, results);
    }
    await sleep(DELAY_MS);
  }
  console.log(`\nDone. ${results.length} of ${candidates.length} processed.`);
}
main();
