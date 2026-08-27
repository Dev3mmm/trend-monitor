// Retry pass for exchanges that got rate-limited in the first run - merges into the
// existing listed-coin-id set rather than starting over. Longer delay (the 8s used in
// the first pass wasn't safe - only 1 of 6 exchanges completed before 429s).

const fs = require('fs');

const RETRY_EXCHANGES = ['binance', 'kraken', 'okex', 'bybit_spot', 'kucoin'];
const DELAY_MS = 25000;
const MAX_PAGES_PER_EXCHANGE = 15;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  // Rebuild the gdax-only set from the first run's known-good coins by re-deriving from
  // protocol_candidates.json isn't right (that's already filtered) - instead just start a
  // fresh listed set for this retry pass and merge with gdax's known coins by re-fetching
  // gdax's remaining pages too, since we don't have its raw coin-id set saved.
  const listed = new Set();

  // Finish gdax (Coinbase) first - it got through 5 pages before failing on page 6.
  let page = 1;
  while (page <= MAX_PAGES_PER_EXCHANGE) {
    try {
      const data = await fetchJson(`https://api.coingecko.com/api/v3/exchanges/gdax/tickers?page=${page}`);
      const tickers = data.tickers || [];
      if (!tickers.length) break;
      for (const t of tickers) if (t.coin_id) listed.add(t.coin_id);
      console.log(`gdax page ${page}: ${tickers.length} tickers, running total ${listed.size}`);
      page++;
    } catch (e) {
      console.log(`gdax page ${page} FAILED: ${e.message}`);
      break;
    }
    await sleep(DELAY_MS);
  }

  for (const exchangeId of RETRY_EXCHANGES) {
    let p = 1;
    while (p <= MAX_PAGES_PER_EXCHANGE) {
      try {
        const data = await fetchJson(`https://api.coingecko.com/api/v3/exchanges/${exchangeId}/tickers?page=${p}`);
        const tickers = data.tickers || [];
        if (!tickers.length) break;
        for (const t of tickers) if (t.coin_id) listed.add(t.coin_id);
        console.log(`${exchangeId} page ${p}: ${tickers.length} tickers, running total ${listed.size}`);
        p++;
      } catch (e) {
        console.log(`${exchangeId} page ${p} FAILED: ${e.message}`);
        break;
      }
      await sleep(DELAY_MS);
    }
  }

  fs.writeFileSync('listed_coin_ids_retry.json', JSON.stringify([...listed], null, 2));
  console.log(`\nRetry pass collected ${listed.size} unique coin IDs. Written to listed_coin_ids_retry.json`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
