const fs = require('fs');
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const listed = new Set();
  let page = 1;
  const MAX_PAGES = 15;
  const DELAY_MS = 20000;
  while (page <= MAX_PAGES) {
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/exchanges/binance/tickers?page=${page}`);
      if (!res.ok) {
        console.log(`page ${page}: HTTP ${res.status}`);
        if (res.status === 429) { await sleep(30000); continue; } // extra backoff on rate limit, retry same page
        break;
      }
      const data = await res.json();
      const tickers = data.tickers || [];
      if (!tickers.length) break;
      for (const t of tickers) if (t.coin_id) listed.add(t.coin_id);
      console.log(`page ${page}: ${tickers.length} tickers, total ${listed.size}`);
      page++;
    } catch (e) {
      console.log(`page ${page} error: ${e.message}`);
      break;
    }
    await sleep(DELAY_MS);
  }
  fs.writeFileSync('listed_coin_ids_binance.json', JSON.stringify([...listed], null, 2));
  console.log(`Done. ${listed.size} coins.`);
}
main();
