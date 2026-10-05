// Plain-HTTP reader for the X "Following" (chronological) home timeline - no browser, so it
// fits in Render's free 512MB and isn't hit by the x.com/home page wall that blocks datacenter
// browsers. Replays the exact GraphQL request the web app makes (captured into
// x_api_template.json by x_api_capture.js) using the cookies from x_state.json.
// If X rotates the query id, calls start returning 400/404 - re-run `node x_api_capture.js`
// locally once and commit the refreshed x_api_template.json.
const fs = require('fs');
const path = require('path');

const TEMPLATE_FILE = path.join(__dirname, 'x_api_template.json');
const X_STATE_FILE = path.join(__dirname, 'x_state.json');

function buildAuth() {
  const st = JSON.parse(fs.readFileSync(X_STATE_FILE, 'utf8'));
  const ck = st.cookies.filter((c) => /(^|\.)(x|twitter)\.com$/.test(c.domain.replace(/^\./, '')) || /x\.com|twitter\.com/.test(c.domain));
  const ct0 = ck.find((c) => c.name === 'ct0');
  if (!ct0 || !ck.find((c) => c.name === 'auth_token')) throw new Error('x_state.json has no auth_token/ct0 cookie - re-login needed');
  return { cookie: ck.map((c) => `${c.name}=${c.value}`).join('; '), ct0: ct0.value };
}

// Oldest created_at across the tweet and anything it retweets/quotes, so a fresh wrapper
// around old news does not read as fresh (same rule as the browser scraper).
function originTime(legacy, result) {
  const times = [new Date(legacy.created_at).getTime()];
  const rt = legacy.retweeted_status_result?.result;
  const rtl = rt?.tweet?.legacy || rt?.legacy;
  if (rtl) times.push(new Date(rtl.created_at).getTime());
  const q = result.quoted_status_result?.result || result.tweet?.quoted_status_result?.result;
  const ql = q?.tweet?.legacy || q?.legacy;
  if (ql) times.push(new Date(ql.created_at).getTime());
  return Math.min(...times.filter((n) => !Number.isNaN(n)));
}

async function fetchHomeLatest(opts = {}) {
  const tpl = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
  const { cookie, ct0 } = buildAuth();
  const headers = { ...tpl.headers, cookie, 'x-csrf-token': ct0 };
  const body = { variables: { ...tpl.variables, seenTweetIds: [], count: opts.count || 40 }, features: tpl.features };
  if (tpl.fieldToggles) body.fieldToggles = tpl.fieldToggles;
  const res = await fetch(tpl.url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`X API HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  const j = JSON.parse(text);
  const adds = (j.data?.home?.home_timeline_urt?.instructions || []).find((i) => i.type === 'TimelineAddEntries');
  if (!adds) throw new Error('X API returned no TimelineAddEntries (shape changed or account walled)');
  const now = Date.now();
  const out = [];
  for (const e of adds.entries) {
    if (e.content?.itemContent?.promotedMetadata) continue; // ads (Starlink etc.)
    const r = e.content?.itemContent?.tweet_results?.result;
    if (!r) continue;
    const tw = r.tweet || r;
    const legacy = tw.legacy;
    const user = tw.core?.user_results?.result;
    if (!legacy || legacy.created_at === undefined) continue;
    const handle = user?.core?.screen_name || user?.legacy?.screen_name || 'unknown';
    const name = user?.core?.name || user?.legacy?.name || handle;
    const rt = legacy.retweeted_status_result?.result;
    const rtl = rt?.tweet?.legacy || rt?.legacy;
    const fullText = (rtl ? rtl.full_text : legacy.full_text) || '';
    const origin = originTime(legacy, tw);
    const mediaList = (rtl?.extended_entities?.media || legacy.extended_entities?.media || []);
    const images = mediaList.filter((m) => m.type === 'photo').map((m) => m.media_url_https).filter(Boolean).slice(0, 4);
    let video = null;
    const vm = mediaList.find((m) => m.type === 'video' || m.type === 'animated_gif');
    if (vm) {
      const mp4 = (vm.video_info?.variants || []).filter((v) => v.content_type === 'video/mp4').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      // best quality that stays small enough for Square; GIFs are a single mp4 with no bitrate
      const pick = mp4.find((v) => (v.bitrate || 0) <= 2200000) || mp4[mp4.length - 1];
      if (pick) video = { url: pick.url, duration: Math.max(1, Math.round((vm.video_info?.duration_millis || 3000) / 1000)), gif: vm.type === 'animated_gif', thumb: vm.media_url_https };
    }
    out.push({
      images,
      video,
      id: legacy.id_str || tw.rest_id,
      text: fullText.replace(/https:\/\/t\.co\/\w+/g, '').trim(),
      author: name,
      url: `https://x.com/${handle}/status/${legacy.id_str || tw.rest_id}`,
      originAgeMinutes: Math.round((now - origin) / 60000),
      originTimestamp: new Date(origin).toISOString(),
    });
  }
  return out.filter((t) => t.id && t.text);
}

module.exports = { fetchHomeLatest };

if (require.main === module) {
  fetchHomeLatest().then((a) => {
    console.log(`${a.length} tweets`);
    a.slice(0, 6).forEach((t) => console.log(`${t.originAgeMinutes}m ${t.author}: ${t.text.slice(0, 80).replace(/\n/g, ' ')}`));
  }).catch((e) => { console.error('FAIL', e.message); process.exit(1); });
}
