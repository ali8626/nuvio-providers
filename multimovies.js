// Multimovies provider for Nuvio (port of MultimoviesProvider.kt: site pages + watchConfig servers)
// Status: search, episode lookup and watchConfig parsing ported; servers are resolved generically (direct .m3u8 or an .m3u8 inside the server page).
// Server hosts that need their own resolver (modiplay, iqsmartgames, vidrift, vidout, vidsync, bingr, filmu, vidbolt...) are listed in the DEBUG line.

var TMDB_API_KEY = ''; // اختياري: إن تركته فارغًا نستخدم aiometadata
var FALLBACK_BASE = 'https://new11.hdhub4u.cl';
var DOMAINS_URL = 'https://cdn.jsdelivr.net/gh/phisher98/TVVVV@main/domains.json';
var SEARCH_API = 'https://search.pingora.fyi/collections/post/documents/search';
var URLS_JSON = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
var UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

async function getText(url) {
  var r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + String(url).replace(/^https?:\/\//, '').slice(0, 60));
  return r.text();
}

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return strip(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function qualityOf(text) {
  var m = /(\d{3,4})p/i.exec(text || '');
  return m ? m[1] + 'p' : 'Unknown';
}

var _urls = null;
async function getUrlsMap() {
  if (_urls) return _urls;
  try { _urls = JSON.parse(await getText(URLS_JSON)); } catch (e) { _urls = {}; }
  return _urls;
}

// النطاق الحالي: قائمة نطاقات phisher98 أولًا، ثم urls.json، ثم الافتراضي
async function getBase() {
  try {
    var d = JSON.parse(await getText(DOMAINS_URL));
    if (d && d.HDHUB4u) return String(d.HDHUB4u).replace(/\/$/, '');
  } catch (e) {}
  var m = await getUrlsMap();
  if (m.hdhub4u) return String(m.hdhub4u).replace(/\/$/, '');
  return FALLBACK_BASE;
}

// بدون مفتاح TMDB: نستخدم نفس خدمة aiometadata التي تستخدمها الإضافة الأصلية
// (غير مجرَّبة: تفترض أنها تقبل المعرّف بصيغة tmdb:ID)
var AIOMETA = 'https://aiometadata.elfhosted.com/stremio/9197a4a9-2f5b-4911-845e-8704c520bdf7/meta';

async function getMeta(tmdbId, mediaType) {
  var kind = mediaType === 'tv' ? 'tv' : 'movie';
  if (TMDB_API_KEY) {
    var url = 'https://api.themoviedb.org/3/' + kind + '/' + tmdbId +
      '?api_key=' + TMDB_API_KEY + '&append_to_response=external_ids';
    var j = JSON.parse(await getText(url));
    var date = j.release_date || j.first_air_date || '';
    return {
      title: j.title || j.name || '',
      year: date.slice(0, 4),
      imdbId: (j.external_ids && j.external_ids.imdb_id) || j.imdb_id || ''
    };
  }
  // بدون مفتاح: نقرأ العنوان والسنة من صفحة TMDB العامة
  try {
    var html = await getText('https://www.themoviedb.org/' + kind + '/' + tmdbId + '?language=en-US');
    var t = /<title>\s*([^<]*?)\s*\((?:TV Series\s*)?(\d{4})/i.exec(html);
    if (t) return { title: strip(t[1]), year: t[2], imdbId: '' };
  } catch (e) {}
  // احتياطي أخير (غير مؤكد العمل)
  var stremioType = kind === 'tv' ? 'series' : 'movie';
  var res = JSON.parse(await getText(AIOMETA + '/' + stremioType + '/tmdb:' + tmdbId + '.json'));
  var m = res.meta || {};
  return {
    title: m.name || '',
    year: String(m.year || m.releaseInfo || '').slice(0, 4),
    imdbId: m.imdb_id || (/^tt\d+/.test(m.id || '') ? m.id : '')
  };
}

// ===== Multimovies =====
var SITES = ['https://m1.multimovies.courses', 'https://multimovies.garden'];
// نفس User-Agent الذي يستخدمه الكود الأصلي (MMNet.UA)
var UA_M = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
var _dbg = [];

function pause(ms) {
  return new Promise(function (res) {
    if (typeof setTimeout === 'function') setTimeout(res, ms); else res();
  });
}

async function mmGet(url, referer) {
  var opts = { headers: { 'User-Agent': UA_M, 'Accept-Language': 'en-US,en;q=0.9', 'Referer': referer || '' } };
  var r = await fetch(url, opts);
  if (r.status === 429) {
    // تقييد معدل الطلبات: نعيد المحاولة مرة واحدة بعد مهلة قصيرة
    await pause(1500);
    r = await fetch(url, opts);
  }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + String(url).replace(/^https?:\/\//, '').slice(0, 45));
  return r.text();
}

function absUrl(base, u) {
  if (/^https?:\/\//i.test(u)) return u;
  base = String(base).replace(/\/+$/, '');
  return base + (u.charAt(0) === '/' ? '' : '/') + u;
}

function hostOf(u) {
  var m = /^https?:\/\/([^\/]+)/i.exec(u);
  return m ? m[1] : '?';
}

// أول موقع حيّ (الصفحة الرئيسية فيها poster-card)
async function pickSite() {
  for (var i = 0; i < SITES.length; i++) {
    try {
      var html = await mmGet(SITES[i] + '/', '');
      if (html.indexOf('poster-card') !== -1) return SITES[i];
      _dbg.push(hostOf(SITES[i]) + ': no poster-card');
    } catch (e) {
      _dbg.push(hostOf(SITES[i]) + ': ' + (e && e.message ? e.message : e));
    }
  }
  return '';
}

function decodeAttr(v) {
  return String(v).replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// بطاقات النتائج: data-save-title='{"url":..., "title":..., "type":..., "year":...}'
function parseCards(html) {
  var out = [];
  var seen = {};
  var re = /data-save-title=(?:"([^"]*)"|'([^']*)')/g;
  var m;
  while ((m = re.exec(html))) {
    try {
      var d = JSON.parse(decodeAttr(m[1] !== undefined ? m[1] : m[2]));
      if (d && d.url && d.title && !seen[d.url]) {
        seen[d.url] = true;
        out.push(d);
      }
    } catch (e) {}
  }
  return out;
}

// const watchConfig = { ... } مع مراعاة النصوص والأقواس
function extractBraced(html, marker) {
  var start = html.indexOf(marker);
  if (start < 0) return '';
  var b = html.indexOf('{', start);
  if (b < 0) return '';
  var depth = 0, inStr = false, esc = false;
  for (var i = b; i < html.length; i++) {
    var ch = html.charAt(i);
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.substring(b, i + 1);
    }
  }
  return '';
}

function parseServers(html) {
  try {
    var root = JSON.parse(extractBraced(html, 'const watchConfig = '));
    return (root.initialServers || []).filter(function (s) { return s && s.url; });
  } catch (e) {
    _dbg.push('watchConfig: ' + (e && e.message ? e.message : e));
    return [];
  }
}

// رابط حلقة معينة من صفحة المسلسل
function findEpisode(html, s, e, site) {
  var idx = html.search(new RegExp('id=["\']ep-item-' + s + '-' + e + '["\']'));
  if (idx < 0) return '';
  var seg = html.substr(idx, 4000);
  var re = /<a\b([^>]*)>/gi;
  var m;
  while ((m = re.exec(seg))) {
    if (m[1].indexOf('cinejoy-ep-thumb-link') === -1) continue;
    var h = /href\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (h) return absUrl(site, h[1].replace(/&amp;/g, '&'));
  }
  return '';
}

async function episodeUrl(site, seriesUrl, s, e) {
  var base = seriesUrl.split('?')[0];
  var first = await mmGet(base + '?season=' + s, site + '/');
  var link = findEpisode(first, s, e, site);
  if (link) return link;
  var sel = /<select[^>]*episode-range-select[^>]*>([\s\S]*?)<\/select>/i.exec(first);
  var ranges = [];
  if (sel) {
    var re = /<option([^>]*)>/gi;
    var m;
    while ((m = re.exec(sel[1]))) {
      if (/selected/i.test(m[1])) continue;
      var v = /value\s*=\s*["'](\d+)["']/i.exec(m[1]);
      if (v) ranges.push(v[1]);
    }
  }
  for (var i = 0; i < ranges.length; i++) {
    try {
      var html = await mmGet(base + '?season=' + s + '&ep_range=' + ranges[i], site + '/');
      link = findEpisode(html, s, e, site);
      if (link) return link;
    } catch (err) {}
  }
  return '';
}

function deEsc(u) {
  return String(u).replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\/g, '');
}

// حلّ عام للسيرفر: رابط m3u8 مباشر، أو m3u8 داخل صفحة السيرفر
async function resolveServer(server, tmdbId, site) {
  var url = String(server.url).replace('{tmdbId}', tmdbId);
  var name = server.name || hostOf(url);
  var host0 = hostOf(url);
  if (/iqsmartgames\.com/i.test(host0)) return resolveIqsmart(url, name, site);
  if (/filesforever\.link/i.test(host0)) return resolveFilesforever(url, name, site);
  if (/\.m3u8(\?|$)/i.test(url)) {
    return [{ name: 'Multimovies', title: name, url: url, quality: 'Auto', headers: { 'Referer': site + '/' }, provider: 'multimovies' }];
  }
  var html = await mmGet(url, site + '/');
  var out = [];
  var seen = {};
  var re = /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/g;
  var m;
  while ((m = re.exec(html))) {
    var u = deEsc(m[0]);
    if (seen[u]) continue;
    seen[u] = true;
    out.push({
      name: 'Multimovies',
      title: name,
      url: u,
      quality: 'Auto',
      headers: { 'Referer': url, 'Origin': (/^(https?:\/\/[^\/]+)/i.exec(url) || [])[1] || '' },
      provider: 'multimovies'
    });
  }
  return out;
}

// ===== GD mirror (iqsmartgames.com / filesforever.link): ملفات ثم مرايا ثم صفحات بها JS مضغوط =====
var IQ_API = 'https://streams.iqsmartgames.com';
var IQ_PLAYER = 'https://pro.iqsmartgames.com';
var XVID_HOSTS = ['hanerix.com', 'morencius.com', 'vibuxer.com', 'n1mwq.org', 'minochinos.com'];
// مرايا تحتاج مستخرجات لم نحصل على كودها بعد
var CINEVERSE_HOSTS = ['multimovies.rpmhub.site', 'multimovies.embedseek.xyz', 'multimovies.p2pplay.pro', 'server1.uns.bio'];

function b64urlDecode(str) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  str = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
  var out = '';
  for (var i = 0; i < str.length; i += 4) {
    var a = chars.indexOf(str.charAt(i));
    var b = chars.indexOf(str.charAt(i + 1));
    var c = str.charAt(i + 2) ? chars.indexOf(str.charAt(i + 2)) : -1;
    var d = str.charAt(i + 3) ? chars.indexOf(str.charAt(i + 3)) : -1;
    var n = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    out += String.fromCharCode((n >> 16) & 255);
    if (c >= 0) out += String.fromCharCode((n >> 8) & 255);
    if (d >= 0) out += String.fromCharCode(n & 255);
  }
  return out;
}

// فك JS المضغوط بطريقة p,a,c,k,e,d
function unpackPacked(html) {
  var m = /\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/.exec(html);
  if (!m) return null;
  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  var a = parseInt(m[2], 10), c = parseInt(m[3], 10), k = m[4].split('|');
  function base(n) {
    return (n < a ? '' : base(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  }
  var d = {};
  while (c--) d[base(c)] = k[c] || base(c);
  return p.replace(/\b\w+\b/g, function (w) { return d[w] !== undefined ? d[w] : w; });
}

function shortLabel(filename) {
  var cleaned = String(filename || '')
    .replace(/[._]+/g, ' ')
    .replace(/\b(multi|ddp[\d.]*|atmos|h[ .]?265|hevc|x265|x264|avc|esub|hindi|web[ .-]?dl|webrip|hdrip|hdtc|hc)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  return cleaned.length > 26 ? cleaned.substring(0, 26).trim() + '...' : cleaned;
}

function iqVar(html, name) {
  var m = new RegExp('let\\s+' + name + '\\s*=\\s*"([^"]*)"').exec(html);
  return m ? m[1] : '';
}

async function iqFiles(embedUrl, site) {
  var html = await mmGet(embedUrl, site + '/');
  var finalId = iqVar(html, 'FinalID'), idType = iqVar(html, 'idType'), key = iqVar(html, 'myKey');
  if (!finalId || !key) return [];
  var season = iqVar(html, 'season'), ep = iqVar(html, 'epname');
  var path = (season && ep)
    ? IQ_API + '/myseriesapi?' + idType + '=' + encodeURIComponent(finalId) + '&season=' + season + '&epname=' + encodeURIComponent(ep) + '&key=' + key
    : IQ_API + '/mymovieapi?' + idType + '=' + encodeURIComponent(finalId) + '&key=' + key;
  var body = JSON.parse(await mmGet(path, IQ_API + '/'));
  return (body.data || []).filter(function (x) { return x && x.fileslug; }).map(function (x) {
    return { slug: x.fileslug, name: x.filename || '', size: x.fsize || '' };
  });
}

async function iqMirrors(slug) {
  var form = 'sid=' + encodeURIComponent(slug) + '&UserFavSite=' +
    '&currentDomain=' + encodeURIComponent('["streams.iqsmartgames.com","pro.iqsmartgames.com"]');
  var r = await fetch(IQ_PLAYER + '/embedhelper2.php', {
    method: 'POST',
    headers: { 'User-Agent': UA_M, 'Referer': IQ_PLAYER + '/', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' embedhelper2');
  var root = JSON.parse(await r.text());
  var sources = root.sources || {};
  var codes = JSON.parse(b64urlDecode(root.mresult || ''));
  var out = [];
  Object.keys(codes).forEach(function (key) {
    var src = sources[key];
    var code = codes[key];
    if (src && src.siteUrl && code) out.push({ siteUrl: src.siteUrl, name: src.friendlyName || key, code: code });
  });
  return out;
}

// مرايا بصفحات JS مضغوط: نفك الضغط ونستخرج روابط m3u8
async function resolveXvid(pageUrl, label) {
  var origin = (/^(https?:\/\/[^\/]+)/i.exec(pageUrl) || [])[1] || '';
  var html = await mmGet(pageUrl, IQ_PLAYER + '/');
  var unpacked = unpackPacked(html);
  if (!unpacked) return [];
  var abs = [], rel = [];
  var re = /"(?:hls\d|file|mp4)"\s*:\s*"([^"]+)"/g;
  var m;
  while ((m = re.exec(unpacked))) {
    var u = deEsc(m[1]);
    if (!u) continue;
    if (/^http/i.test(u)) abs.push(u); else rel.push(absUrl(origin, u));
  }
  var re2 = /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/g;
  while ((m = re2.exec(unpacked))) abs.push(deEsc(m[0]));
  var seen = {};
  return abs.concat(rel).filter(function (u) {
    if (!/^http/i.test(u) || seen[u]) return false;
    seen[u] = true;
    return true;
  }).map(function (u) {
    return { name: 'Multimovies', title: label, url: u, quality: 'Auto', headers: { 'Referer': origin + '/' }, provider: 'multimovies' };
  });
}

async function resolveMirrorPage(pageUrl, label) {
  var host = hostOf(pageUrl);
  var out = [];
  var seen = {};
  var re = /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/g;
  var html = await mmGet(pageUrl, '');
  var m;
  while ((m = re.exec(html))) {
    var u = deEsc(m[0]);
    if (seen[u]) continue;
    seen[u] = true;
    out.push({ name: 'Multimovies', title: label, url: u, quality: 'Auto', headers: {}, provider: 'multimovies' });
  }
  return out;
}

async function dispatchMirror(mirror, label) {
  var pageUrl = absUrl(mirror.siteUrl, mirror.code);
  var host = hostOf(pageUrl);
  if (CINEVERSE_HOSTS.indexOf(host) !== -1 || host === 'bysetayico.com') {
    _dbg.push('mirror ' + host + ' needs its own resolver');
    return [];
  }
  if (XVID_HOSTS.indexOf(host) !== -1) return resolveXvid(pageUrl, label);
  return resolveMirrorPage(pageUrl, label);
}

async function resolveIqsmart(embedUrl, name, site) {
  var files = await iqFiles(embedUrl, site);
  var out = [];
  for (var i = 0; i < Math.min(files.length, 6); i++) {
    var mirrors = [];
    try { mirrors = await iqMirrors(files[i].slug); } catch (e) { _dbg.push('iqsmart mirrors: ' + (e && e.message ? e.message : e)); }
    var label = name + ' ' + (shortLabel(files[i].name) || ('File ' + (i + 1))) + (files[i].size ? ' [' + files[i].size + ']' : '');
    var res = await Promise.all(mirrors.map(function (mr) {
      return dispatchMirror(mr, label).catch(function () { return []; });
    }));
    res.forEach(function (r) { out = out.concat(r); });
  }
  return out;
}

async function resolveFilesforever(embedUrl, name, site) {
  var code = embedUrl.replace(/\/+$/, '').split('/').pop();
  if (!code) return [];
  var sid = code;
  try {
    var page = await mmGet(embedUrl, site + '/');
    var m = /id="gdmrfid"\s+value="([^"]+)"/.exec(page) || /let\s+FinalID\s*=\s*"([^"]+)"/.exec(page);
    if (m) sid = m[1];
  } catch (e) {}
  var mirrors = await iqMirrors(sid);
  var res = await Promise.all(mirrors.map(function (mr) {
    return dispatchMirror(mr, name + ' ' + sid).catch(function () { return []; });
  }));
  return res.reduce(function (acc, r) { return acc.concat(r); }, []);
}

// وضع التشخيص: عند الفشل يظهر سطر في قائمة السيرفرات يشرح السبب. اجعله false بعد أن يعمل المزوّد.
var DEBUG = true;

function debugStream(msg) {
  return [{ name: 'Multimovies DEBUG', title: msg, url: 'https://example.com/debug.mp4', quality: 'Unknown', headers: {}, provider: 'multimovies' }];
}

async function getStreams(tmdbId, mediaType, season, episode) {
  var step = 'start';
  _dbg = [];
  function fail(m) { return DEBUG ? debugStream(m) : []; }
  try {
    step = 'site';
    var site = await pickSite();
    if (!site) return fail('no live Multimovies site [' + _dbg.join('; ') + ']');

    step = 'meta (tmdb ' + tmdbId + ')';
    var meta = await getMeta(tmdbId, mediaType);
    if (!meta || !meta.title) return fail('no title from metadata');
    var isTv = mediaType === 'tv';
    var s = Number(season), e = Number(episode);

    step = 'search "' + meta.title + '"';
    var cards = parseCards(await mmGet(site + '/search?q=' + encodeURIComponent(meta.title), site + '/'));
    var nt = norm(meta.title);
    var cands = cards.filter(function (d) {
      var tvCard = d.type === 'tv' || /\/series\//.test(d.url);
      return tvCard === isTv && norm(d.title).indexOf(nt) !== -1;
    });
    if (meta.year) {
      var wy = cands.filter(function (d) { return String(d.year) === String(meta.year); });
      if (wy.length) cands = wy;
    }
    if (!cands.length) return fail('no match "' + meta.title + '" ' + (meta.year || '') + ' @ ' + hostOf(site) + ' (cards=' + cards.length + ')');
    var pageUrl = absUrl(site, cands[0].url);

    step = 'watch page';
    if (isTv) {
      pageUrl = await episodeUrl(site, pageUrl, s, e);
      if (!pageUrl) return fail('episode S' + s + 'E' + e + ' not found for "' + cands[0].title + '"');
    }
    var servers = parseServers(await mmGet(pageUrl, site + '/'));
    if (!servers.length) return fail('no servers in watch page ' + (_dbg.length ? '[' + _dbg.join('; ') + ']' : ''));

    step = 'resolve ' + servers.length + ' servers';
    var results = await Promise.all(servers.map(async function (sv) {
      try {
        return await resolveServer(sv, tmdbId, site);
      } catch (err) {
        _dbg.push(hostOf(sv.url) + ': ' + (err && err.message ? err.message : err));
        return [];
      }
    }));
    var out = results.reduce(function (acc, r) { return acc.concat(r); }, []);
    // سطر تشخيص إضافي: السيرفرات التي لم تُنتج رابطًا (حتى لو نجح بعضها)
    var missing = [];
    servers.forEach(function (sv, i) {
      if (!results[i].length) missing.push((sv.name || '?') + ' (' + hostOf(sv.url) + ')');
    });
    if (out.length && DEBUG && missing.length) {
      out.push(debugStream('unresolved ' + missing.length + '/' + servers.length + ': ' + missing.join(', ') + (_dbg.length ? ' | ' + _dbg.slice(0, 2).join(' | ') : ''))[0]);
    }
    if (!out.length) {
      var hosts = {};
      servers.forEach(function (sv) { var h = hostOf(sv.url); hosts[h] = (hosts[h] || 0) + 1; });
      var hs = Object.keys(hosts).map(function (k) { return k + ' x' + hosts[k]; }).join(', ');
      return fail('found ' + servers.length + ' servers, none playable. hosts: ' + hs);
    }
    return out;
  } catch (err2) {
    return fail('ERR at ' + step + ': ' + (err2 && err2.message ? err2.message : err2));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
