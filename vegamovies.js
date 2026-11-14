// VegaMovies provider for Nuvio (port of VegaMoviesSite from the justplay CloudStream plugin)
// Status: search, post parsing, nexdrive pages and the V-Cloud / HubCloud / FastDL / Filepress / GoFile / GPDL / VegaDrive resolvers ported (untested in Nuvio).
// Not ported: PlayNet.alive() link probing and the internal label builder.

var TMDB_API_KEY = ''; // اختياري: إن تركته فارغًا نستخدم aiometadata
var FALLBACK_BASE = '';
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

// ===== VegaMovies =====
var DOMAINS = ['https://vegamovies.lease', 'https://rogmovies.autos', 'https://rogmovies.im'];
var UA_V = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var NEXDRIVE = 'https://nexdrive.beer/';
var DEAD_HOSTS = /megaup|viking|vik1ng|telegram|t\.me/i;
var JUNK = /vglist|t\.me|telegram|imdb\.com|google\.com\/search|whatsapp|share|facebook|twitter|pinterest|report|hubcloud\.(foo|cx)|\/admin|login|signup|\bidm\b|\bida\b|category|\/tag\/|\/author\/|\/page\//i;
var BUTTON_HOSTS = /nexdrive|vcloud|vegadrive|fastdl|filebee|filepress|fpgo|gofile|hubcloud|pixeldrain|gpdl|\.r2\.dev|\.r2\.cloudflarestorage\.com|buzzserver|10gbps/i;
var QUALITY_RE = /\b(480p|720p|1080p|2160p|4K|60FPS)\b/i;
var _dbg = [];
var _pageCache = {};

function pause(ms) {
  return new Promise(function (res) {
    if (typeof setTimeout === 'function') setTimeout(res, ms); else res();
  });
}

function bh(referer, extra) {
  var h = { 'User-Agent': UA_V, 'Accept': 'text/html,application/json,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
  if (referer) h['Referer'] = referer;
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}

// يرجع { ok, status, text, url } ولا يرمي خطأ HTTP
async function hget(url, referer, extra) {
  var r = await fetch(url, { headers: bh(referer, extra) });
  var text = '';
  try { text = await r.text(); } catch (e) {}
  return { ok: r.ok, status: r.status, text: text, url: r.url || url, headers: r.headers };
}

async function hpostJson(url, body, referer, extra) {
  var h = bh(referer, extra);
  h['Content-Type'] = 'application/json';
  h['Accept'] = 'application/json';
  var r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
  var text = '';
  try { text = await r.text(); } catch (e) {}
  return { ok: r.ok, status: r.status, text: text };
}

function hostOf(u) {
  var m = /^https?:\/\/([^\/]+)/i.exec(u);
  return m ? m[1].toLowerCase() : '';
}

function baseOfUrl(u) {
  var m = /^(https?:\/\/[^\/]+)/i.exec(u);
  return m ? m[1] : '';
}

function absUrl(base, u) {
  if (/^https?:\/\//i.test(u)) return u;
  base = String(base).replace(/\/+$/, '');
  return base + (u.charAt(0) === '/' ? '' : '/') + u;
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64d(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
  var out = '';
  for (var i = 0; i < str.length; i += 4) {
    var a = B64.indexOf(str.charAt(i)), b = B64.indexOf(str.charAt(i + 1));
    var c = str.charAt(i + 2) ? B64.indexOf(str.charAt(i + 2)) : -1;
    var d = str.charAt(i + 3) ? B64.indexOf(str.charAt(i + 3)) : -1;
    var n = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    out += String.fromCharCode((n >> 16) & 255);
    if (c >= 0) out += String.fromCharCode((n >> 8) & 255);
    if (d >= 0) out += String.fromCharCode(n & 255);
  }
  return out;
}

function b64e(str) {
  str = String(str);
  var out = '';
  for (var i = 0; i < str.length; i += 3) {
    var a = str.charCodeAt(i), b = str.charCodeAt(i + 1), c = str.charCodeAt(i + 2);
    var n = (a << 16) | ((isNaN(b) ? 0 : b) << 8) | (isNaN(c) ? 0 : c);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) +
      (isNaN(b) ? '=' : B64.charAt((n >> 6) & 63)) + (isNaN(c) ? '=' : B64.charAt(n & 63));
  }
  return out;
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

// ---------- الروابط والعناوين ----------
function isServerLink(href) {
  if (DEAD_HOSTS.test(href)) return false;
  return /^https?:/i.test(href) && BUTTON_HOSTS.test(href);
}

// عناصر h1..h5 والروابط بالترتيب
function tokenize(html) {
  var toks = [];
  var re = /<(h[1-5])\b[^>]*>([\s\S]*?)<\/\1>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))) {
    if (m[1]) toks.push({ t: 'h', tag: m[1].toLowerCase(), text: strip(m[2]) });
    else {
      var h = /href\s*=\s*["']([^"']+)["']/i.exec(m[3]);
      if (h) toks.push({ t: 'a', href: h[1].replace(/&amp;/g, '&'), text: strip(m[4]) });
    }
  }
  return toks;
}

function pushButton(group, a) {
  if (!isServerLink(a.href) || JUNK.test(a.href) || !a.text) return;
  if (/batch|zip\b/i.test(a.text)) return;
  group.links.push({ label: a.text, href: a.href });
}

function parsePost(html) {
  var toks = tokenize(html);
  var seasons = [];
  var movieGroups = [];
  var isSeasonHead = function (t) { return t.t === 'h' && (t.tag === 'h1' || t.tag === 'h2') && /season\s*\d+|part\s*\d+/i.test(t.text); };

  function groupsFrom(start, stopAtH12) {
    var out = [];
    for (var i = start; i < toks.length; i++) {
      var t = toks[i];
      if (stopAtH12 && t.t === 'h' && (t.tag === 'h1' || t.tag === 'h2')) break;
      if (t.t === 'h' && /^h[345]$/.test(t.tag) && QUALITY_RE.test(t.text)) {
        var g = { label: t.text, links: [] };
        for (var j = i + 1; j < toks.length && !(toks[j].t === 'h'); j++) pushButton(g, toks[j]);
        if (g.links.length) out.push(g);
      }
    }
    return out;
  }

  toks.forEach(function (t, i) {
    if (!isSeasonHead(t)) return;
    var mm = /season\s*(\d+)/i.exec(t.text) || /part\s*(\d+)/i.exec(t.text);
    var block = { title: t.text, number: mm ? parseInt(mm[1], 10) : 1, groups: groupsFrom(i + 1, true) };
    if (block.groups.length) seasons.push(block);
  });
  if (!seasons.length) movieGroups = groupsFrom(0, false);
  if (!seasons.length && !movieGroups.length) return null;
  return { seasons: seasons, movieGroups: movieGroups };
}

// "Season 1-3" أو "S01" ... => مصفوفة مواسم أو null
function seasonsOf(title) {
  var m = /season\s*0*(\d+)(?:\s*(?:-|–|to|&|,)\s*(?:season\s*)?0*(\d+))?/i.exec(title);
  if (!m) m = /\bS0*(\d+)(?:\s*(?:-|–)\s*S?0*(\d+))?\b/.exec(title);
  if (!m) return null;
  var a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
  var out = [];
  for (var i = a; i <= Math.max(a, b); i++) out.push(i);
  return out;
}

function sameShow(postTitle, title) {
  var stripped = norm(postTitle);
  ['download', 'watch'].forEach(function (p) { if (stripped.indexOf(p) === 0) stripped = stripped.substring(p.length).trim(); });
  var base = norm(title);
  if (!base || stripped.indexOf(base) !== 0) return false;
  var rest = stripped.substring(base.length).trim();
  return !rest || /^(season|part|chapter|s\d|vol|volume|19\d\d|20\d\d)/.test(rest);
}

function pickPost(posts, meta, isTv, s) {
  var matched = posts.filter(function (p) { return sameShow(p.post_title, meta.title); });
  if (!matched.length) return null;
  if (isTv) {
    var withSeason = matched.filter(function (p) { var so = seasonsOf(p.post_title); return so && so.indexOf(s) !== -1; });
    if (withSeason.length) return withSeason[0];
    return matched.filter(function (p) { return !seasonsOf(p.post_title); })[0] || null;
  }
  var wy = matched.filter(function (p) { return meta.year && p.post_title.indexOf(meta.year) !== -1; });
  return wy[0] || matched[0];
}

async function searchPosts(domain, q) {
  var url = domain + '/ts-search.php?q=' + encodeURIComponent(q) + '&page=1';
  for (var i = 0; i < 3; i++) {
    try {
      var r = await hget(url, domain + '/');
      if (r.status === 200) {
        var j = JSON.parse(r.text);
        return (j.hits || []).map(function (h) { return h.document; })
          .filter(function (d) { return d && d.post_title && d.permalink; })
          .map(function (d) { return { post_title: d.post_title, permalink: d.permalink, domain: domain }; });
      }
      _dbg.push(hostOf(domain) + ': HTTP ' + r.status);
    } catch (e) {
      _dbg.push(hostOf(domain) + ': ' + (e && e.message ? e.message : e));
    }
    await pause(800);
  }
  return [];
}

// ---------- صفحة nexdrive ----------
async function fetchDrivePage(url) {
  if (_pageCache[url]) return _pageCache[url];
  var r = await hget(url, NEXDRIVE, { 'Cookie': 'xla=s4t' });
  if (!r.ok) { _dbg.push(hostOf(url) + ': HTTP ' + r.status); return null; }
  if (/file (is )?deleted|not found/i.test(r.text)) return null;
  var toks = tokenize(r.text);
  var servers = [];
  var seenS = {};
  toks.forEach(function (t) {
    if (t.t !== 'a' || !t.text || !isServerLink(t.href) || JUNK.test(t.href) || JUNK.test(t.text) || /batch|zip\b/i.test(t.text)) return;
    if (seenS[t.href]) return;
    seenS[t.href] = true;
    servers.push({ label: t.text, href: t.href });
  });
  var episodes = {};
  toks.forEach(function (t, i) {
    if (t.t !== 'h' || !/^h[345]$/.test(t.tag)) return;
    var m = /episodes?\s*:?\s*0*(\d{1,3})/i.exec(t.text);
    if (!m) return;
    var num = parseInt(m[1], 10);
    var links = [];
    for (var j = i + 1; j < toks.length && !(toks[j].t === 'h' && /^h[345]$/.test(toks[j].tag)); j++) {
      var a = toks[j];
      if (a.t === 'a' && a.text && isServerLink(a.href) && !JUNK.test(a.href) && !JUNK.test(a.text)) links.push({ label: a.text, href: a.href });
    }
    if (links.length && !episodes[num]) episodes[num] = links;
  });
  var page = { servers: servers, episodes: episodes };
  _pageCache[url] = page;
  return page;
}

// ---------- أسماء السيرفرات ----------
function serverNameOf(label, href) {
  var low = String(label).toLowerCase(), h = String(href).toLowerCase();
  if (/fslv2|fsl v2|fsl2/.test(low)) return 'FSLv2';
  if (low.indexOf('fsl') !== -1) return 'FSL';
  if (/pixelserver|pixel server|pixeldrain/.test(low)) return 'PixelDrain';
  if (low.indexOf('gofile') !== -1) return 'GoFile';
  if (low.indexOf('10gbps') !== -1) return '10Gbps';
  if (low.indexOf('buzzserver') !== -1) return 'BuzzServer';
  if (/instant download|instant dl/.test(low)) return 'Instant Download';
  if (/vegadrive|v-drive|skydrop/.test(low)) return 'V-Drive';
  if (/vcloud|v-cloud/.test(low)) return 'V-Cloud';
  if (/g-direct|gdirect|fastdl/.test(low)) return 'G-Direct';
  if (/filepress|filebee/.test(low)) return 'Filepress';
  if (h.indexOf('.r2.cloudflarestorage.com') !== -1) return 'FSLv2';
  if (h.indexOf('.r2.dev') !== -1) return 'FSL';
  if (h.indexOf('pixeldrain') !== -1) return 'PixelDrain';
  if (h.indexOf('gpdl') !== -1) return '10Gbps';
  return null;
}

function pixelApi(href) {
  var id = href.split('?')[0].split('#')[0].split('/').pop();
  return baseOfUrl(href) + '/api/file/' + id;
}

// ---------- المستخرجات ----------
var VC_TOKEN = /var\s+url\s*=\s*atob\s*\(\s*atob\s*\(\s*['"]([^'"]+)['"]/;
var PLAIN_URL = /var\s+url\s*=\s*['"]([^'"]+)['"]/;

function extractVcloudTarget(html) {
  var m = VC_TOKEN.exec(html);
  if (m) { try { return b64d(b64d(m[1].trim())); } catch (e) {} }
  var p = PLAIN_URL.exec(html);
  return p && /^http/i.test(p[1]) ? p[1] : '';
}

async function vcloudTarget(url) {
  var first = await hget(url, NEXDRIVE, { 'Cookie': 'xla=s4t' });
  if (!first.ok) throw new Error('HTTP ' + first.status + ' ' + hostOf(url));
  var target = extractVcloudTarget(first.text);
  if (/^http/i.test(target)) return { from: url, target: target };
  var hopM = /<div[^>]*class=["'][^"']*\bmain\b[^"']*["'][^>]*>[\s\S]*?<h4[^>]*>\s*<a[^>]*href=["']([^"']+)["']/i.exec(first.text);
  if (!hopM) return null;
  var hopUrl = /^http/i.test(hopM[1]) ? hopM[1] : baseOfUrl(url) + hopM[1];
  var hop = await hget(hopUrl, url, { 'Cookie': 'xla=s4t' });
  if (!hop.ok) throw new Error('HTTP ' + hop.status + ' ' + hostOf(hopUrl));
  target = extractVcloudTarget(hop.text);
  return /^http/i.test(target) ? { from: hopUrl, target: target } : null;
}

async function addServer(out, name, href) {
  if (name === '10Gbps') { var g = await gpdlDirect(href); if (g) out.push({ name: name, url: g }); }
  else if (name === 'GoFile') { var f = await gofileDirect(href); if (f) out.push({ name: name, url: f.url, headers: f.headers }); }
  else if (name === 'PixelDrain') out.push({ name: name, url: pixelApi(href) });
  else out.push({ name: name, url: href });
}

async function vcloudServers(url) {
  var t = await vcloudTarget(url);
  if (!t) { _dbg.push(hostOf(url) + ': no vcloud target'); return []; }
  var r = await hget(t.target, t.from, { 'Cookie': 'xla=s4t' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + hostOf(t.target));
  var out = [];
  var toks = tokenize2(r.text);
  for (var i = 0; i < toks.length; i++) {
    var a = toks[i];
    if (!/^https?:/i.test(a.href) || JUNK.test(a.href) || !a.text) continue;
    var name = serverNameOf(a.text, a.href);
    if (name) await addServer(out, name, a.href);
  }
  var px = /var\s+pxl\s*=\s*["']([^"']+)["']/.exec(r.text);
  if (px && /^http/i.test(px[1]) && px[1].indexOf('pixeldrain') !== -1) await addServer(out, 'PixelDrain', px[1]);
  return dedupe(out);
}

// كل الروابط (بدون عناوين h)
function tokenize2(html) {
  return tokenize(html).filter(function (t) { return t.t === 'a'; });
}

function dedupe(list) {
  var seen = {};
  return list.filter(function (s) { if (seen[s.url]) return false; seen[s.url] = true; return true; });
}

async function hubcloudServers(url) {
  var r = await hget(url, '');
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + hostOf(url));
  var hd = /<div[^>]*card-header[^>]*>([\s\S]*?)<\/div>/i.exec(r.text);
  if (hd && /\.(zip|rar|7z)\s*$/i.test(strip(hd[1]))) return [];
  var gen = '';
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi, m;
  while ((m = re.exec(r.text))) {
    if (/generate/i.test(strip(m[2])) && (/\bbtn\b/.test(m[1]) || /download/i.test(m[1]))) {
      var h = /href\s*=\s*["']([^"']+)["']/i.exec(m[1]);
      if (h) { gen = h[1]; break; }
    }
  }
  if (!gen) return [];
  var genUrl = /^http/i.test(gen) ? gen : baseOfUrl(r.url) + gen;
  var g = await hget(genUrl, r.url);
  if (!g.ok) throw new Error('HTTP ' + g.status + ' ' + hostOf(genUrl));
  var out = [];
  var toks = tokenize2(g.text);
  for (var i = 0; i < toks.length; i++) {
    var a = toks[i];
    if (!/^https?:/i.test(a.href) || JUNK.test(a.href) || !a.text) continue;
    var name = serverNameOf(a.text, a.href);
    if (name) await addServer(out, name, a.href);
  }
  return dedupe(out);
}

async function vegadriveSkydrop(url) {
  var page = await hget(url, NEXDRIVE);
  if (!page.ok) return null;
  var base = baseOfUrl(page.url);
  var token = url.split('/s/').pop().split('?')[0].split('#')[0];
  if (url.indexOf('/d/') !== -1) token = url.split('/d/').pop().split('/')[0].split('?')[0];
  if (!token || token === url) return null;
  for (var i = 0; i < 3; i++) {
    var r = await hget(base + '/download-link/' + token + '/skydrop', base + '/s/' + token);
    var parsed = null;
    try { parsed = JSON.parse(r.text); } catch (e) {}
    var link = parsed && parsed.download_url ? parsed.download_url : '';
    if (r.status === 200 && /^http/i.test(link)) return { name: 'V-Drive', url: link };
    if (r.status !== 202) return null;
    await pause(Math.min((parsed && parsed.retry_after_ms) || 2500, 3000));
  }
  return null;
}

async function fastdlDirect(url) {
  var r = await hget(url, '');
  var m = /var\s+reurl\s*=\s*"([^"]+)"/.exec(r.text) || /'(https:\/\/fastdl[^']*dl\.php\?link=[^']+)'/.exec(r.text);
  if (!m) return null;
  var reurl = m[1];
  var carrier = reurl;
  var w = /[?&]r=([A-Za-z0-9+\/=_-]+)/.exec(reurl);
  if (w) { try { carrier = b64d(w[1]); } catch (e) {} }
  var l = /link=(https?:\/\/[^&"']+)/.exec(carrier);
  if (!l) return null;
  var direct = safeDecode(l[1]);
  return /^http/i.test(direct) ? direct : null;
}

async function filepressTask(id, method, base) {
  var r = await hpostJson(base + '/api/file/downlaod/', { captchaValue: '', id: id, method: method }, base + '/', { 'Origin': base });
  if (!r.ok) return null;
  try { var p = JSON.parse(r.text); if (p.status && typeof p.data === 'string' && p.data) return p.data; } catch (e) {}
  return null;
}

async function filepressFinal(taskId, base) {
  var r = await hpostJson(base + '/api/file/downlaod2/', { captchaValue: null, id: taskId, method: 'indexDownlaod' }, base + '/', { 'Origin': base });
  if (!r.ok) return null;
  try {
    var p = JSON.parse(r.text);
    if (!p.status) return null;
    if (typeof p.data === 'string') return /^http/i.test(p.data) ? p.data : null;
    if (Array.isArray(p.data)) { for (var i = 0; i < p.data.length; i++) if (/^http/i.test(String(p.data[i]))) return p.data[i]; }
  } catch (e) {}
  return null;
}

async function resolveDotFlix(shareUrl) {
  var r = await hget(shareUrl, 'https://new3.dotflix.shop/');
  var code = /btoa\('([^']+)'\)/.exec(r.text);
  if (!code) return null;
  var obf = b64e(code[1]).split('').reverse().join('');
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789', rid = '';
  for (var i = 0; i < 13; i++) rid += chars.charAt(Math.floor(Math.random() * chars.length));
  var ts = String(Date.now());
  var p = await hpostJson('https://dotflix.fit/api/extract-download', { requestId: rid, timestamp: ts, data: obf },
    'https://new3.dotflix.shop/', { 'X-Request-ID': rid, 'X-Timestamp': ts, 'Origin': 'https://new3.dotflix.shop' });
  if (!p.ok) return null;
  try { var j = JSON.parse(p.text); if (j.success && /^http/i.test(j.downloadUrl || '')) return j.downloadUrl; } catch (e) {}
  return null;
}

async function filepressDirect(url) {
  var m = /\/file\/([a-f0-9]{16,40})/.exec(url);
  if (!m) return null;
  var base = 'https://filebee.xyz';
  var share = await filepressTask(m[1], 'dotFlixDownlaod', base);
  if (share && /^http/i.test(share)) { var d = await resolveDotFlix(share); if (d) return d; }
  var task = await filepressTask(m[1], 'indexDownlaod', base);
  if (task && /^[a-f0-9]{16,40}$/.test(task)) return filepressFinal(task, base);
  return null;
}

async function gofileDirect(url) {
  var code = url.split('#')[0].split('?')[0].split('/').pop();
  if (!code) return null;
  var api = 'https://api.gofile.io';
  var acc = await fetch(api + '/accounts', { method: 'POST', headers: bh('') });
  var token = JSON.parse(await acc.text()).data.token;
  var wt = null;
  try {
    var js = await hget(api + '/dist/js/global.js', '');
    var wm = /appdata\.wt\s*=\s*["']([^"']+)["']/.exec(js.text);
    wt = wm ? wm[1] : null;
  } catch (e) {}
  var c = await hget(api + '/contents/' + code + '?wt=' + (wt || token), '', { 'Authorization': 'Bearer ' + token });
  var data = JSON.parse(c.text).data;
  var children = data && data.children;
  if (!children) return null;
  var best = null, bestSize = -1;
  Object.keys(children).forEach(function (k) {
    var ch = children[k];
    if (!ch || /\.(zip|rar|7z)\s*$/i.test(ch.name || '')) return;
    if (!/^http/i.test(ch.link || '')) return;
    if ((ch.size || 0) > bestSize) { bestSize = ch.size || 0; best = ch.link; }
  });
  return best ? { url: best, headers: { 'Cookie': 'accountToken=' + token } } : null;
}

async function gpdlDirect(url) {
  var cur = url;
  try {
    for (var i = 0; i < 5; i++) {
      var r = await fetch(cur, { headers: bh(''), redirect: 'manual' });
      var loc = r.headers && r.headers.get ? r.headers.get('location') : '';
      if (!loc && r.url && r.url !== cur) { cur = r.url; break; }
      if (!loc || r.status < 301 || r.status > 308) break;
      cur = /^http/i.test(loc) ? loc : baseOfUrl(cur) + loc;
    }
  } catch (e) { return null; }
  var q = cur.indexOf('?') !== -1 ? cur.substring(cur.indexOf('?') + 1).split('&') : [];
  for (var k = 0; k < q.length; k++) {
    if (q[k].split('=')[0] !== 'link') continue;
    var v = q[k].substring(q[k].indexOf('=') + 1);
    var direct = v.indexOf('%') !== -1 ? safeDecode(v) : v;
    return /^http/i.test(direct) ? direct : null;
  }
  return null;
}

function directServer(href) {
  var h = href.toLowerCase();
  if (h.indexOf('.r2.cloudflarestorage.com') !== -1) return [{ name: 'FSLv2', url: href }];
  if (h.indexOf('.r2.dev') !== -1) return [{ name: 'FSL', url: href }];
  if (h.indexOf('pixeldrain') !== -1) return [{ name: 'PixelDrain', url: pixelApi(href) }];
  return [];
}

async function resolveHref(href) {
  if (!/^http/i.test(href) || DEAD_HOSTS.test(href)) return [];
  var host = hostOf(href);
  try {
    if (host.indexOf('vcloud') !== -1) return await vcloudServers(href);
    if (host.indexOf('vegadrive') !== -1) { var v = await vegadriveSkydrop(href); return v ? [v] : []; }
    if (host.indexOf('fastdl') !== -1) { var f = await fastdlDirect(href); return f ? [{ name: 'G-Direct', url: f }] : []; }
    if (/filebee|filepress|fpgo/.test(host)) { var fp = await filepressDirect(href); return fp ? [{ name: 'Filepress', url: fp }] : []; }
    if (host.indexOf('gofile') !== -1) { var gf = await gofileDirect(href); return gf ? [{ name: 'GoFile', url: gf.url, headers: gf.headers }] : []; }
    if (host.indexOf('gpdl') !== -1) { var gp = await gpdlDirect(href); return gp ? [{ name: '10Gbps', url: gp }] : []; }
    if (host.indexOf('hubcloud') !== -1) return await hubcloudServers(href);
    return directServer(href);
  } catch (e) {
    _dbg.push(host + ': ' + (e && e.message ? e.message : e));
    return [];
  }
}

function infoFrom(label) {
  return String(label).replace(/\bdownload\s+now\b|\bdownload\b/gi, '').replace(/\s+/g, ' ').trim();
}

// تنفيذ دفعات بتوازٍ محدود
async function pool(items, n, fn) {
  var idx = 0;
  async function worker() {
    while (idx < items.length) { var i = idx++; try { await fn(items[i]); } catch (e) {} }
  }
  var ws = [];
  for (var w = 0; w < Math.min(n, items.length); w++) ws.push(worker());
  await Promise.all(ws);
}

// وضع التشخيص: عند الفشل يظهر سطر في قائمة السيرفرات يشرح السبب. اجعله false بعد أن يعمل المزوّد.
var DEBUG = true;

function debugStream(msg) {
  return [{ name: 'VegaMovies DEBUG', title: msg, url: 'https://example.com/debug.mp4', quality: 'Unknown', headers: {}, provider: 'vegamovies' }];
}

async function getStreams(tmdbId, mediaType, season, episode) {
  var step = 'start';
  _dbg = [];
  _pageCache = {};
  function fail(m) { return DEBUG ? debugStream(m + (_dbg.length ? ' | ' + _dbg.slice(0, 3).join(' | ') : '')) : []; }
  try {
    step = 'meta (tmdb ' + tmdbId + ')';
    var meta = await getMeta(tmdbId, mediaType);
    if (!meta || !meta.title) return fail('no title from metadata');
    var isTv = mediaType === 'tv';
    var s = Number(season), e = Number(episode);

    step = 'search "' + meta.title + '"';
    var queries = isTv ? [meta.title, meta.title + ' season ' + s] : [meta.title + ' ' + (meta.year || ''), meta.title];
    var post = null;
    for (var qi = 0; qi < queries.length && !post; qi++) {
      var rounds = await Promise.all(DOMAINS.map(function (d) { return searchPosts(d, queries[qi]); }));
      var posts = rounds.reduce(function (a, r) { return a.concat(r); }, []);
      if (posts.length) post = pickPost(posts, meta, isTv, s);
    }
    if (!post) return fail('no match "' + meta.title + '" ' + (meta.year || ''));

    step = 'post page';
    var postUrl = absUrl(post.domain, post.permalink);
    var pr = await hget(postUrl, post.domain + '/');
    if (!pr.ok) return fail('post HTTP ' + pr.status + ' ' + hostOf(postUrl));
    var detail = parsePost(pr.text);
    if (!detail) return fail('post "' + post.post_title + '": no download groups');

    var groups = [];
    if (isTv) {
      detail.seasons.filter(function (b) { return b.number === s; }).forEach(function (b) { groups = groups.concat(b.groups); });
      if (!groups.length) {
        if (detail.seasons.length) detail.seasons.filter(function (b) { return !seasonsOf(b.title); }).forEach(function (b) { groups = groups.concat(b.groups); });
        else if ((seasonsOf(post.post_title) || []).indexOf(s) !== -1) groups = detail.movieGroups;
      }
    } else groups = detail.movieGroups;
    if (!groups.length) return fail('no groups for ' + (isTv ? 'season ' + s : 'movie') + ' in "' + post.post_title + '"');

    step = 'servers (' + groups.length + ' groups)';
    var claimed = {}, seenUrls = {}, out = [];
    var tasks = [];
    groups.forEach(function (g) { g.links.forEach(function (l) { tasks.push({ group: g, link: l }); }); });

    await pool(tasks, 6, async function (task) {
      var g = task.group;
      var tier = qualityOf(g.label);
      var info = infoFrom(g.label);
      var page = await fetchDrivePage(task.link.href);
      if (!page) return;
      var targets = isTv ? (page.episodes[e] || (Object.keys(page.episodes).length ? [] : page.servers)) : page.servers;
      for (var i = 0; i < targets.length; i++) {
        var servers = await resolveHref(targets[i].href);
        servers.forEach(function (sv) {
          if (seenUrls[sv.url]) return;
          seenUrls[sv.url] = true;
          var key = sv.name + '|' + tier;
          if (claimed[key]) return;
          claimed[key] = true;
          out.push({ name: 'VegaMovies', title: meta.title + ' • ' + sv.name + (info ? ' • ' + info : ''), url: sv.url, quality: tier, headers: sv.headers || {}, provider: 'vegamovies' });
        });
      }
    });

    if (!out.length) return fail('post "' + post.post_title + '" ok, ' + tasks.length + ' drive links, none playable');
    return out;
  } catch (err) {
    return fail('ERR at ' + step + ': ' + (err && err.message ? err.message : err));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
