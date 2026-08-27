// Generic RSS lane factory - used to create independent monitors (regulators, exchanges,
// protocol blogs, etc.) that each read their own sources file and write their own rolling
// log, sharing the same fetch/parse/freshness logic. Regulators and exchanges move crypto
// markets as much as project news does, so these are peer lanes to X/YouTube, not a subset.
// Plain RSS/XML parsing (regex-based) - no XML dependency needed for well-formed feeds.

const fs = require('fs');
const crypto = require('crypto');

const LATEST_MAX = 300;
// Regulator/exchange feeds post far less often than X, so this window is deliberately
// wider than the X agent's 120-minute gate - but some feeds (confirmed: Nigeria SEC)
// return their whole archive with no real freshness ordering, so a gate is still required
// or "Fresh" fills up with years-old items on every refresh.
const MAX_AGE_DAYS = 10;
const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'qwen2.5:3b';

// General financial regulators (SEC, CFTC, Fed, FCA, SEBI, BaFin, FINMA, OSC...) cover
// securities/banking/insurance broadly - most of what they publish has nothing to do with
// crypto (found live: SEBI's feed is mostly equity-market/insolvency notices). Exchange
// blogs (Kraken etc.) don't need this since everything they publish is inherently crypto-
// relevant already. Reuses the same triage pattern as doom_scroll_agent.js's Ollama check,
// just asking a narrower question (crypto/blockchain/Web3 relevance, not newsworthiness).
async function isCryptoRelevant(title, description) {
  const prompt = `Is the following news item specifically about cryptocurrency, blockchain, digital assets, stablecoins, tokenization, DeFi, or Web3 - or is it unrelated general financial/regulatory news (e.g. equities, banking, insurance, unrelated enforcement, unrelated consumer notices)?

Title: """${title}"""
Description: """${description}"""

Reply with EXACTLY one line: VERDICT: YES|NO`;
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // The model doesn't always include the "VERDICT:" prefix despite being asked to -
    // confirmed live (a clearly-crypto SEC item got replied to with bare "YES", which the
    // old strict /VERDICT:\s*YES/ regex missed, silently filtering out real crypto news).
    // Match either form; treat an explicit NO as authoritative over a stray "YES" substring.
    const text = (data.response || '').trim();
    if (/\bNO\b/i.test(text)) return false;
    return /\bYES\b/i.test(text);
  } catch {
    return true; // Ollama unavailable - fail open rather than silently dropping real items
  }
}

// Cheap heuristic to avoid calling Ollama on every single item (most sources are already
// English) - flags text as "likely non-English" if a large share of characters fall
// outside basic ASCII (catches CJK, Cyrillic, Arabic, etc.). Not perfect (won't catch
// e.g. French/German, which are mostly ASCII) but cheap and catches the common cases;
// false negatives just mean an occasional non-English item stays untranslated, not lost.
function looksNonEnglish(text) {
  if (!text) return false;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  return nonAscii / text.length > 0.15;
}

// Translates title+description to English via Ollama when the cheap heuristic flags the
// text as likely non-English. Keeps the original text too (never silently discard the
// source language, same "don't lose data" discipline as the freshness/relevance gates in
// this project) - the translated fields are what the dashboard displays, originalTitle/
// originalDescription are kept on the record for anyone who wants to check the source.
async function translateIfNeeded(title, description) {
  if (!looksNonEnglish(title) && !looksNonEnglish(description)) {
    return { title, description, translated: false };
  }
  const prompt = `Translate the following to English. If it is already in English, repeat it unchanged. Reply with EXACTLY this format, nothing else:
TITLE: <translated title>
DESCRIPTION: <translated description>

Title: """${title}"""
Description: """${description}"""`;
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = (data.response || '').trim();
    const titleMatch = text.match(/TITLE:\s*([\s\S]*?)(?:\nDESCRIPTION:|$)/i);
    const descMatch = text.match(/DESCRIPTION:\s*([\s\S]*)$/i);
    // The model sometimes echoes the prompt's own """ delimiters back into its answer -
    // confirmed live on translated Cardano forum posts (e.g. '"""Καλή μας Σεζόν!"""').
    const stripQuotes = (s) => s.trim().replace(/^"{1,3}/, '').replace(/"{1,3}$/, '').trim();
    return {
      title: (titleMatch ? stripQuotes(titleMatch[1]) : title) || title,
      description: (descMatch ? stripQuotes(descMatch[1]) : description) || description,
      translated: true,
    };
  } catch {
    return { title, description, translated: false }; // Ollama unavailable - keep original rather than drop the item
  }
}

function stripCdata(s) {
  if (!s) return '';
  const m = s.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return (m ? m[1] : s).trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Blog feeds often embed real HTML (<p>, <img>...) inside the description, unlike
// government feeds which are usually plain text - strip tags before decoding entities so
// the dashboard shows readable text, not raw markup.
function stripHtmlTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Government/corporate feeds use inconsistent pubDate formats, several of which JS's Date
// constructor can't parse directly - found by testing real feeds, not assumed:
// - Fed wraps pubDate in CDATA (Date() chokes on the wrapper itself)
// - FCA uses "Thursday, August 20, 2026 - 10:00" (day-name-comma-dash format)
// - SEBI uses "24 Aug, 2026 +0530" (day-first with a comma Date() doesn't expect)
// Strip CDATA first, try a direct parse, then fall back to extracting a
// "Month Day, Year" or "Day Month Year" pattern and reparsing that instead.
function parseFeedDate(raw) {
  const cleaned = stripCdata(raw).trim();
  if (!cleaned) return null;

  let d = new Date(cleaned);
  if (!Number.isNaN(d.getTime())) return d;

  const monthDayYear = cleaned.match(/([A-Z][a-z]+ \d{1,2},? \d{4})/);
  if (monthDayYear) {
    d = new Date(monthDayYear[1]);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const dayMonthYear = cleaned.match(/(\d{1,2} [A-Z][a-z]+,? \d{4})/);
  if (dayMonthYear) {
    d = new Date(dayMonthYear[1].replace(',', ''));
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

// Minimal RSS <item> parser via regex - sufficient for well-formed government/corporate
// feeds, avoids adding an XML dependency for this project.
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = decodeEntities(stripCdata((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || ''));
    const link = decodeEntities(stripCdata((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || ''));
    const pubDateRaw = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
    const description = stripHtmlTags(decodeEntities(stripCdata((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || ''))).slice(0, 400);
    const pubDate = parseFeedDate(pubDateRaw);
    if (title && link) {
      items.push({
        title,
        url: link,
        description,
        publishedAt: pubDate ? pubDate.toISOString() : null,
      });
    }
  }
  return items;
}

async function fetchSource(source) {
  const res = await fetch(source.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 10).map((it) => ({
    ...it,
    source: source.name,
    sourceType: source.type,
    sourceKind: source.kind || null, // e.g. 'blog' vs 'forum' - only meaningful for protocol sources so far
  }));
}

// Creates an independent monitor instance bound to its own sources/latest files - each
// call is a separate lane (regulators, exchanges, ...) with its own state, sharing only
// the fetch/parse code above.
function createRssMonitor({ sourcesFile, latestFile, idPrefix, filterCryptoRelevance = false }) {
  function loadSources() {
    if (!fs.existsSync(sourcesFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(sourcesFile, 'utf8')).sources || [];
    } catch {
      return [];
    }
  }

  function loadLatest() {
    if (!fs.existsSync(latestFile)) return [];
    try {
      const j = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }

  function saveLatest(items) {
    // Atomic write (temp file + rename) - a plain writeFileSync got caught mid-write by a
    // PC restart once elsewhere in this project and corrupted a whole progress file into
    // garbage. Rename is atomic on the same filesystem.
    const tmp = `${latestFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items.slice(-LATEST_MAX), null, 2));
    fs.renameSync(tmp, latestFile);
  }

  async function refreshAll() {
    const sources = loadSources();
    const existing = loadLatest();
    const seenUrls = new Set(existing.map((v) => v.url));
    const errors = [];
    let added = 0;

    for (const source of sources) {
      try {
        const items = await fetchSource(source);
        for (const it of items) {
          if (!it.publishedAt || seenUrls.has(it.url)) continue;
          const ageDays = (Date.now() - new Date(it.publishedAt).getTime()) / 86400000;
          if (ageDays > MAX_AGE_DAYS) continue; // stale - most likely an archive dump, not real news
          // A crypto-relevance rejection is kept, not discarded - the Ollama call is a
          // narrow, isolated judgment (no full article, no context) and has already been
          // caught wrong once (a real SEC crypto item briefly filtered out). Surface these
          // in a "Rejected" tab so a human can override rather than silently losing items.
          const relevant = filterCryptoRelevance ? await isCryptoRelevant(it.title, it.description) : true;
          const translation = await translateIfNeeded(it.title, it.description);
          seenUrls.add(it.url);
          existing.push({
            id: `${idPrefix}-${crypto.createHash('sha1').update(it.url).digest('hex').slice(0, 16)}`,
            ...it,
            title: translation.title,
            description: translation.description,
            translated: translation.translated,
            originalTitle: translation.translated ? it.title : undefined,
            originalDescription: translation.translated ? it.description : undefined,
            fetchedAt: new Date().toISOString(),
            userStatus: null,
            relevanceRejected: filterCryptoRelevance && !relevant,
          });
          added++;
        }
      } catch (e) {
        errors.push({ source: source.name, error: e.message });
      }
    }

    // Prune anything now past the freshness window, including items ingested under an
    // older (looser) MAX_AGE_DAYS in a previous run - no accumulation of stale items.
    const fresh = existing.filter((it) => (Date.now() - new Date(it.publishedAt).getTime()) / 86400000 <= MAX_AGE_DAYS);
    fresh.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
    saveLatest(fresh);
    return { added, errors, total: fresh.length };
  }

  function setUserStatus(id, userStatus) {
    const items = loadLatest();
    const item = items.find((v) => v.id === id);
    if (!item) throw new Error(`No item with id ${id}`);
    item.userStatus = userStatus;
    saveLatest(items);
    return item;
  }

  return { loadSources, loadLatest, refreshAll, setUserStatus };
}

module.exports = { createRssMonitor };
