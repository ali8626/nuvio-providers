// CineStream sources for Nuvio (port of CineStreamExtractors.kt, one source at a time)
// Done: Vidlink. Each source is a function (tmdbId, mediaType, season, episode) -> [streams].
// Needs the external decrypt service https://enc-dec.app (it receives the TMDB id and your IP).

var MULTI_DECRYPT = 'https://enc-dec.app/api';
var VIDLINK = 'https://vidlink.pro';
var UA = 'Mozilla/5.0 (Linux; Android 11; Mi 9T Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Mobile Safari/537.36 EdgA/95.0.1020.48';

// وضع التشخيص: عند الفشل يظهر سطر في قائمة السيرفرات يشرح السبب. اجعله false بعد أن يعمل.
var DEBUG = true;

function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

async function getJson(url, headers) {
  var r = await fetch(url, { headers: headers || { 'User-Agent': UA } });
  if (r.status === 429 || r.status === 503) {
    await sleep(1500);
    r = await fetch(url, { headers: headers || { 'User-Agent': UA } });
  }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + String(url).replace(/^https?:\/\//, '').slice(0, 50));
  return JSON.parse(await r.text());
}

function qualityName(key) {
  var k = String(key || '');
  if (k === '4k' || k === '2160') return '2160p';
  if (/^\d{3,4}$/.test(k)) return k + 'p';
  return 'Unknown';
}

// ===== Vidlink =====
async function vidlink(tmdbId, mediaType, season, episode) {
  var enc = (await getJson(MULTI_DECRYPT + '/enc-vidlink?text=' + tmdbId)).result;
  if (!enc) throw new Error('vidlink: no enc result');

  var headers = {
    'User-Agent': UA,
    'Connection': 'keep-alive',
    'Referer': VIDLINK + '/',
    'Origin': VIDLINK
  };
  var url = mediaType === 'tv'
    ? VIDLINK + '/api/b/tv/' + enc + '/' + season + '/' + episode
    : VIDLINK + '/api/b/movie/' + enc;

  var res = await getJson(url, headers);
  var qualities = res && res.stream && res.stream.qualities;
  if (!qualities) return [];

  var out = [];
  Object.keys(qualities).forEach(function (key) {
    var q = qualities[key];
    if (!q || !q.url) return;
    // ترويسات افتراضية + ما يرسله الخادم (الخادم يغلب)
    var h = { 'User-Agent': UA, 'Referer': 'https://filmboom.top/', 'Origin': 'https://filmboom.top' };
    var sh = q.headers || {};
    Object.keys(sh).forEach(function (k) {
      Object.keys(h).forEach(function (e) { if (e.toLowerCase() === k.toLowerCase()) delete h[e]; });
      h[k] = sh[k];
    });
    var host = (/^https?:\/\/([^\/]+)/i.exec(q.url) || [])[1] || '?';
    out.push({
      name: 'VidLink',
      title: 'VidLink ' + qualityName(key) + ' • ' + host + (q.type ? ' • ' + q.type : ''),
      url: q.url,
      quality: qualityName(key),
      headers: h,
      provider: 'cinestream'
    });
  });
  return out;
}

// أضف المصادر الجديدة هنا
var SOURCES = [
  { name: 'Vidlink', fn: vidlink }
];

function debugStream(msg) {
  return [{ name: 'CineStream DEBUG', title: msg, url: 'https://example.com/debug.mp4', quality: 'Unknown', headers: {}, provider: 'cinestream' }];
}

var CACHE = {};
var CACHE_MS = 10 * 60 * 1000;

async function getStreams(tmdbId, mediaType, season, episode) {
  var key = [tmdbId, mediaType, season, episode].join('|');
  var hit = CACHE[key];
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  var v = await fetchStreams(tmdbId, mediaType, season, episode);
  // لا نخزّن نتائج الفشل/التشخيص
  if (v.length && v[0].name !== 'CineStream DEBUG') CACHE[key] = { t: Date.now(), v: v };
  return v;
}

async function fetchStreams(tmdbId, mediaType, season, episode) {
  var errors = [];
  var results = await Promise.all(SOURCES.map(function (s) {
    return s.fn(tmdbId, mediaType, season, episode).catch(function (e) {
      errors.push(s.name + ': ' + (e && e.message ? e.message : e));
      return [];
    });
  }));
  var out = results.reduce(function (acc, r) { return acc.concat(r); }, []);
  if (!out.length && DEBUG) return debugStream(errors.length ? errors.join(' | ') : 'no sources returned streams');
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
