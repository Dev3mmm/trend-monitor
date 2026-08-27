// Runs all RSS lanes (regulators/exchanges/protocols) in one command - used by the
// GitHub Actions sweep and available for manual use too.
const { createRssMonitor } = require('./rss_monitor');

const LANES = [
  { name: 'regulators', sourcesFile: 'regulator_sources.json', latestFile: 'regulator_latest_log.json', idPrefix: 'reg', filterCryptoRelevance: true },
  { name: 'exchanges', sourcesFile: 'exchange_sources.json', latestFile: 'exchange_latest_log.json', idPrefix: 'exch' },
  { name: 'protocols', sourcesFile: 'protocol_sources.json', latestFile: 'protocol_latest_log.json', idPrefix: 'proto' },
];

async function main() {
  for (const lane of LANES) {
    const monitor = createRssMonitor(lane);
    try {
      const result = await monitor.refreshAll();
      console.log(`${lane.name}:`, JSON.stringify(result));
    } catch (e) {
      console.error(`${lane.name} FAILED:`, e.message);
    }
  }
}

main();
