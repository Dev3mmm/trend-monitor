// YouTube lane for the dashboard - Data API based (YouTube's public RSS feeds are
// broken platform-wide as of 2026, confirmed via direct testing against a known-good
// channel ID before switching to this approach). Uses playlistItems.list against each
// channel's "uploads" playlist (1 quota unit/call) rather than search.list (100 units)
// since this just needs "latest videos", not a text search.

const fs = require('fs');
const path = require('path');

const CHANNELS_FILE = path.join(__dirname, 'youtube_channels.json');
const LATEST_FILE = path.join(__dirname, 'youtube_latest_log.json');
const CONFIG_FILE = path.join(__dirname, 'config.local.json');
const LATEST_MAX = 300;
const MAX_AGE_DAYS = 10; // same freshness bar as the RSS lanes - no accumulating old videos

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return {};
}

function apiKey() {
  const key = loadConfig().youtubeApiKey || process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('No youtubeApiKey in config.local.json or YOUTUBE_API_KEY env var');
  return key;
}

function loadChannels() {
  if (!fs.existsSync(CHANNELS_FILE)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    return j.channels || [];
  } catch {
    return [];
  }
}

function saveChannels(channels, extra = {}) {
  const existing = fs.existsSync(CHANNELS_FILE) ? JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')) : {};
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify({ ...existing, ...extra, channels }, null, 2));
}

function loadLatest() {
  if (!fs.existsSync(LATEST_FILE)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function saveLatest(items) {
  fs.writeFileSync(LATEST_FILE, JSON.stringify(items.slice(-LATEST_MAX), null, 2));
}

async function fetchChannelUploads(channel) {
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${channel.uploadsPlaylistId}&maxResults=5&key=${apiKey()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API ${res.status} for ${channel.name}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.items || []).map((it) => ({
    channel: channel.name,
    videoId: it.snippet.resourceId ? it.snippet.resourceId.videoId : null,
    title: it.snippet.title,
    publishedAt: it.snippet.publishedAt,
    thumbnail: it.snippet.thumbnails && it.snippet.thumbnails.default ? it.snippet.thumbnails.default.url : null,
  })).filter((v) => v.videoId);
}

// Fetches latest uploads for every tracked channel and merges new ones into the rolling
// log, deduped by videoId. Returns { added, errors }.
async function refreshAll() {
  const channels = loadChannels();
  const existing = loadLatest();
  const seenIds = new Set(existing.map((v) => v.videoId));
  const errors = [];
  let added = 0;

  for (const channel of channels) {
    try {
      const videos = await fetchChannelUploads(channel);
      for (const v of videos) {
        if (seenIds.has(v.videoId)) continue;
        const ageDays = (Date.now() - new Date(v.publishedAt).getTime()) / 86400000;
        if (ageDays > MAX_AGE_DAYS) continue;
        seenIds.add(v.videoId);
        existing.push({ id: `yt-${v.videoId}`, ...v, url: `https://www.youtube.com/watch?v=${v.videoId}`, fetchedAt: new Date().toISOString(), userStatus: null });
        added++;
      }
    } catch (e) {
      errors.push({ channel: channel.name, error: e.message });
    }
  }

  // Prune anything now past the freshness window - no accumulating old videos across runs.
  const fresh = existing.filter((v) => (Date.now() - new Date(v.publishedAt).getTime()) / 86400000 <= MAX_AGE_DAYS);
  fresh.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  saveLatest(fresh);
  return { added, errors, total: fresh.length };
}

// Resolves a free-text query (name or handle) to a real channel via search.list, then
// fetches its uploads playlist ID via channels.list, and appends it to youtube_channels.json
// if not already tracked. Used by the dashboard's "Add channel" box.
async function resolveAndAddChannel(query) {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=channel&maxResults=1&key=${apiKey()}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`search.list failed: HTTP ${searchRes.status}`);
  const searchData = await searchRes.json();
  const match = (searchData.items || [])[0];
  if (!match) throw new Error(`No YouTube channel found for "${query}"`);
  const channelId = match.snippet.channelId;

  const channels = loadChannels();
  if (channels.some((c) => c.channelId === channelId)) {
    return { alreadyTracked: true, name: match.snippet.title, channelId };
  }

  const detailUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&id=${channelId}&key=${apiKey()}`;
  const detailRes = await fetch(detailUrl);
  const detailData = await detailRes.json();
  const detail = (detailData.items || [])[0];
  if (!detail) throw new Error(`Could not fetch channel details for ${channelId}`);

  const entry = {
    name: detail.snippet.title,
    channelId,
    uploadsPlaylistId: detail.contentDetails.relatedPlaylists.uploads,
  };
  channels.push(entry);
  saveChannels(channels);
  return { alreadyTracked: false, name: entry.name, channelId, subscribers: detail.statistics.subscriberCount };
}

function setVideoUserStatus(id, userStatus) {
  const items = loadLatest();
  const item = items.find((v) => v.id === id);
  if (!item) throw new Error(`No video with id ${id}`);
  item.userStatus = userStatus;
  saveLatest(items);
  return item;
}

function deleteChannel(channelId) {
  const channels = loadChannels();
  const remaining = channels.filter((c) => c.channelId !== channelId);
  if (remaining.length === channels.length) throw new Error(`No channel with id ${channelId}`);
  saveChannels(remaining);
  return remaining;
}

module.exports = { loadChannels, loadLatest, refreshAll, resolveAndAddChannel, setVideoUserStatus, deleteChannel };

if (require.main === module) {
  refreshAll().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
