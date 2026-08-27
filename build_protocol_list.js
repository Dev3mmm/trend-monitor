// One-off builder: top-N coins by market cap, filtered to those listed on at least one
// major exchange, with homepage URLs for the next step (blog RSS discovery).
// Run standalone: node build_protocol_list.js
// Rate-limited to CoinGecko's free tier (confirmed via live testing: ~1 call/8s is safe,
// faster triggers 429s).

const fs = require('fs');

const MAJOR_EXCHANGES = ['binance', 'gdax', 'kraken', 'okex', 'bybit_spot', 'kucoin'];
const TOP_N = 400;
const DELAY_MS = 8000;
const MAX_PAGES_PER_EXCHANGE = 15;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function collectListedCoinIds() {
  const listed = new Set();
  for (const exchangeId of MAJOR_EXCHANGES) {
    let page = 1;
    let gotAny = false;
    while (page <= MAX_PAGES_PER_EXCHANGE) {
      try {
        const data = await fetchJson(`https://api.coingecko.com/api/v3/exchanges/${exchangeId}/tickers?page=${page}`);
        const tickers = data.tickers || [];
        if (!tickers.length) break;
        for (const t of tickers) {
          if (t.coin_id) listed.add(t.coin_id);
        }
        gotAny = true;
        console.log(`${exchangeId} page ${page}: ${tickers.length} tickers, running total ${listed.size} unique coins`);
        page++;
      } catch (e) {
        console.log(`${exchangeId} page ${page} FAILED: ${e.message}`);
        break;
      }
      await sleep(DELAY_MS);
    }
    if (!gotAny) console.log(`WARNING: ${exchangeId} returned nothing`);
  }
  return listed;
}

async function main() {
  const mc1 = JSON.parse(fs.readFileSync('mc_p1.json', 'utf8'));
  const mc2 = JSON.parse(fs.readFileSync('mc_p2.json', 'utf8'));
  const topByMcap = [...mc1, ...mc2].slice(0, TOP_N);
  console.log(`Loaded ${topByMcap.length} coins by market cap rank.`);

  const listedIds = await collectListedCoinIds();
  console.log(`\nCollected ${listedIds.size} unique coin IDs listed on a major exchange.`);

  const filtered = topByMcap.filter((c) => listedIds.has(c.id));
  console.log(`\n${filtered.length} of ${topByMcap.length} top-market-cap coins are confirmed listed on a major exchange.`);

  fs.writeFileSync('protocol_candidates.json', JSON.stringify(filtered.map((c) => ({
    id: c.id,
    symbol: c.symbol,
    name: c.name,
    market_cap_rank: c.market_cap_rank,
  })), null, 2));
  console.log('Written to protocol_candidates.json');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
