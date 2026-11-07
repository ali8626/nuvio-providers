// advisory.js (no TMDB key needed) - Nuvio provider: content guide (scene info) shown as source entries.
// Best-effort scraping: sites change often, so every step is wrapped in try/catch.

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
  // No API key: read title/year from the public TMDB page, then find the IMDb id.
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const html = await get('https://www.themoviedb.org/' + type + '/' + tmdbId + '?language=en-US');
  const t = html.match(/<title>([^<]*)<\/title>/i);
  if (!t) throw new Error('TMDB page title not found');
  const raw = t[1]
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  // e.g. "Obsession (2026) — The Movie Database (TMDB)"
  const mm = raw.match(/^(.*?)\s*\((?:TV Series\s*)?(\d{4})\)/);
  const title = (mm ? mm[1] : raw.split(/\s[\u2014\u2013-]\s/)[0]).trim();
  const year = mm ? mm[2] : '';

  const q = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/ +/g, '_');
  let imdbId = null;
  if (q) {
    const j = JSON.parse(await get('https://v2.sg.media-imdb.com/suggestion/' + q[0] + '/' + q + '.json'));
    const list = (j.d || []).filter(x => x.id && x.id.indexOf('tt') === 0);
    const hit = list.find(x => year && String(x.y) === year) || list[0];
    if (hit) imdbId = hit.id;
  }
  return { imdbId, title, year };
}

// IMDb Parents Guide (best-effort). Throws a descriptive error when nothing is found.
async function fromImdb(imdbId) {
  const url = 'https://www.imdb.com/title/' + imdbId + '/parentalguide';
  const html = await get(url);
  let items = [];

  // 1) embedded JSON (plainText strings after the NUDITY category)
  const i = html.indexOf('"NUDITY"');
  if (i >= 0) {
    const chunk = html.slice(i, i + 8000);
    const re = /"plainText":"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(chunk)) !== null && items.length < 4) {
      const t = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
      if (t.length > 20) items.push(t.length > 160 ? t.slice(0, 157) + '...' : t);
    }
  }

  // 2) fallback: plain text between "Sex & Nudity" and "Violence & Gore"
  let sev = '';
  if (!items.length) {
    const text = stripTags(html);
    const k = text.search(/Sex\s*&\s*Nudity/i);
    if (k >= 0) {
      let part = text.slice(k + 12, k + 2500);
      const e = part.search(/Violence\s*&\s*Gore/i);
      if (e >= 0) part = part.slice(0, e);
      part = part.trim();
      const sv = part.match(/^(None|Mild|Moderate|Severe)\b/i);
      if (sv) sev = sv[1];
      if (part.length > 20) items.push(part.length > 300 ? part.slice(0, 297) + '...' : part);
    }
  }

  if (!items.length) {
    throw new Error('page ' + html.length + ' chars, nudity marker ' + (i >= 0 ? 'yes' : 'no') +
      ', text marker ' + (/Sex\s*&amp;\s*Nudity|Sex\s*&\s*Nudity/i.test(html) ? 'yes' : 'no'));
  }
  const times = findTimes(items.join(' '));
  return { source: 'IMDb', url, rating: sev || '', text: items.join(' | '), times };
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
  const tried = [];
  for (const slug of slugs) {
    const url = 'https://kids-in-mind.com/' + slug[0] + '/' + slug + '.htm';
    try {
      const text = stripTags(await get(url));
      const m = text.match(/SEX\s*\/\s*NUDITY\s*(\d+)\s*(.*?)(?:VIOLENCE\s*\/\s*GORE|$)/i);
      if (!m) { tried.push(slug + ':nomatch'); continue; }
      const desc = m[2].length > 220 ? m[2].slice(0, 217) + '...' : m[2];
      return { source: 'Kids-In-Mind', url, rating: m[1] + '/10', text: desc, times: findTimes(m[2]) };
    } catch (e) { tried.push(slug + ':' + e.message.replace(/ https?:\S+/, '')); }
  }
  throw new Error(tried.join(', '));
}

function debugEntry(msg) {
  return [{
    name: '⚠️ Content Guide - DEBUG',
    title: msg,
    url: 'https://www.imdb.com/',
    quality: 'Info',
    headers: {}
  }];
}

async function getStreams(tmdbId, mediaType, season, episode) {
  let step = 'start';
  try {
    step = 'tmdb-page';
    const info = await tmdbInfo(tmdbId, mediaType);
    if (!info.imdbId) return debugEntry('No IMDb id found for: ' + info.title + ' ' + info.year);

    step = 'sources';
    const jobs = [fromImdb(info.imdbId).catch(e => ({ err: 'IMDb: ' + e.message }))];
    if (info.title && mediaType !== 'tv') {
      jobs.push(fromKidsInMind(info.title).catch(e => ({ err: 'KIM: ' + e.message })));
    }
    const all = await Promise.all(jobs);
    const results = all.filter(r => r && !r.err);
    const errors = all.filter(r => r && r.err).map(r => r.err);

    if (!results.length) {
      return debugEntry('Nothing found for ' + info.title + ' (' + info.imdbId + ') ' + errors.join(' ; '));
    }

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
    console.log('[advisory] ' + step + ': ' + e.message);
    return debugEntry('Failed at ' + step + ': ' + e.message);
  }
}

module.exports = { getStreams };
