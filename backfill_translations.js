// One-off: applies translateIfNeeded to items already stored before the translation
// feature was added (dedup means a normal refreshAll won't reprocess them).
const fs = require('fs');

// Reuse the same heuristic/translation logic via a private re-require trick isn't clean
// since rss_monitor.js doesn't export these - duplicated here deliberately, small and
// self-contained, matches this project's existing one-off-script pattern.
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5:3b';

function looksNonEnglish(text) {
  if (!text) return false;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  return nonAscii / text.length > 0.15;
}

async function translateIfNeeded(title, description) {
  if (!looksNonEnglish(title) && !looksNonEnglish(description)) return { title, description, translated: false };
  const prompt = `Translate the following to English. If it is already in English, repeat it unchanged. Reply with EXACTLY this format, nothing else:
TITLE: <translated title>
DESCRIPTION: <translated description>

Title: """${title}"""
Description: """${description}"""`;
  try {
    const res = await fetch(OLLAMA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = (data.response || '').trim();
    const titleMatch = text.match(/TITLE:\s*([\s\S]*?)(?:\nDESCRIPTION:|$)/i);
    const descMatch = text.match(/DESCRIPTION:\s*([\s\S]*)$/i);
    const stripQuotes = (s) => s.trim().replace(/^"{1,3}/, '').replace(/"{1,3}$/, '').trim();
    return {
      title: (titleMatch ? stripQuotes(titleMatch[1]) : title) || title,
      description: (descMatch ? stripQuotes(descMatch[1]) : description) || description,
      translated: true,
    };
  } catch {
    return { title, description, translated: false };
  }
}

async function backfillFile(file) {
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = 0;
  for (const it of items) {
    if (it.translated !== undefined) continue; // already processed (translated true or false)
    const result = await translateIfNeeded(it.title, it.description);
    if (result.translated) {
      it.originalTitle = it.title;
      it.originalDescription = it.description;
      it.title = result.title;
      it.description = result.description;
      changed++;
      console.log(`${file}: translated "${it.originalTitle.slice(0, 50)}"`);
    }
    it.translated = result.translated;
  }
  fs.writeFileSync(file, JSON.stringify(items, null, 2));
  console.log(`${file}: ${changed} item(s) translated, ${items.length} total processed.`);
}

async function main() {
  for (const file of ['protocol_latest_log.json', 'regulator_latest_log.json', 'exchange_latest_log.json']) {
    if (fs.existsSync(file)) await backfillFile(file);
  }
}
main();
