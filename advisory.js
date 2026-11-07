// advisory.js - Nuvio provider: content guide (scene info) shown as source entries.
// Best-effort scraping: sites change often, so every step is wrapped in try/catch.

const TMDB_API_KEY = 'PUT_YOUR_TMDB_KEY_HERE'; // copy the key from your working providers
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.text();
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// timestamps like 12:30, 1:05:10, or "at 40 minutes"
function findTimes(text) {
  const out = [];
  const re = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b|\b(?:at|around|about)\s+(\d{1,3})\s*(?:min|minutes)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1] || m[2] + ' min');
  return Array.from(new Set(out));
}

async function tmdbInfo(tmdbId, mediaType) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const base = 'https://api.themoviedb.org/3/' + type + '/' + tmdbId;
  const [ext, det] = await Promise.all([
    get(base + '/external_ids?api_key=' + TMDB_API_KEY).then(JSON.parse),
    get(base + '?api_key=' + TMDB_API_KEY).then(JSON.parse)
  ]);
  const title = det.title || det.name || '';
  const date = det.release_date || det.first_air_date || '';
  return { imdbId: ext.imdb_id, title, year: date.slice(0, 4) };
}

// IMDb Parents Guide (best-effort: reads the nudity block of the page)
async function fromImdb(imdbId) {
  const url = 'https://www.imdb.com/title/' + imdbId + '/parentalguide';
  const html = await get(url);
  const i = html.indexOf('"NUDITY"');
  if (i < 0) return null;
  const chunk = html.slice(i, i + 8000);
  const items = [];
  const re = /"plainText":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(chunk)) !== null && items.length < 4) {
    let t = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
    if (t.length > 20) items.push(t.length > 160 ? t.slice(0, 157) + '...' : t);
  }
  if (!items.length) return null;
  const times = findTimes(items.join(' '));
  return { source: 'IMDb', url, text: items.join(' | '), times };
}

// Kids-In-Mind: URL pattern /<first letter>/<slug>.htm
async function fromKidsInMind(title) {
  const clean = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const noArticle = clean.replace(/^(the|a|an) /, '');
  const slugs = Array.from(new Set([
    noArticle.replace(/ /g, '-'),
    noArticle.replace(/ /g, ''),
    clean.replace(/ /g, '-')
  ]));
  for (const slug of slugs) {
    const url = 'https://kids-in-mind.com/' + slug[0] + '/' + slug + '.htm';
    try {
      const text = stripTags(await get(url));
      const m = text.match(/SEX\s*\/\s*NUDITY\s*(\d+)\s*(.*?)(?:VIOLENCE\s*\/\s*GORE|$)/i);
      if (!m) continue;
      const desc = m[2].length > 220 ? m[2].slice(0, 217) + '...' : m[2];
      return { source: 'Kids-In-Mind', url, rating: m[1] + '/10', text: desc, times: findTimes(m[2]) };
    } catch (e) { /* try next slug */ }
  }
  return null;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const info = await tmdbInfo(tmdbId, mediaType);
    const jobs = [];
    if (info.imdbId) jobs.push(fromImdb(info.imdbId).catch(() => null));
    if (info.title && mediaType !== 'tv') jobs.push(fromKidsInMind(info.title).catch(() => null));
    const results = (await Promise.all(jobs)).filter(Boolean);

    return results.map(r => {
      const when = r.times.length ? ' | Times: ' + r.times.join(', ') : ' | No exact times';
      const rate = r.rating ? ' [' + r.rating + ']' : '';
      return {
        name: '⚠️ Content Guide - ' + r.source + rate,
        title: r.text + when,
        url: r.url, // informational only, not a playable stream
        quality: 'Info',
        headers: {}
      };
    });
  } catch (e) {
    console.log('[advisory] ' + e.message);
    return [];
  }
}

module.exports = { getStreams };
