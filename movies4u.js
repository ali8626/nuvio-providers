// Movies4u provider for Nuvio (port of invokeMovies4u from CineStreamExtractors.kt)
// Status: written for the CURRENT movies4u.td layout (post -> mdrive.cloud page -> HubCloud/GDFlix). Untested in Nuvio.
// The old CloudStream parser (div.downloads-btns-div) no longer matches this site.

var TMDB_API_KEY = ''; // اختياري: إن تركته فارغًا نستخدم aiometadata
// نطاق Movies4u: في urls.json صاحب الإضافة كتب google.com مكانه، فنستخدم النطاق الافتراضي أدناه.
// إن تغيّر النطاق اكتب الجديد هنا: 'https://example.com'
var BASE_OVERRIDE = '';
var FALLBACK_BASE = 'https://movies4u.td';
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

async function getBase() {
  if (BASE_OVERRIDE) return BASE_OVERRIDE.replace(/\/$/, '');
  var m = await getUrlsMap();
  var v = m.movies4u ? String(m.movies4u).replace(/\/$/, '') : '';
  if (v && !/google\./i.test(v)) return v;
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

// ===== المستخرجات: HubCloud / GDFlix =====

function baseOf(url) {
  var m = /^(https?:\/\/[^\/]+)/i.exec(url);
  return m ? m[1] : url;
}

async function latestBase(base, source) {
  try {
    if (!_urls) _urls = JSON.parse(await getText(URLS_JSON));
    if (_urls[source]) return String(_urls[source]).replace(/\/$/, '');
  } catch (e) {}
  return base;
}

function qFrom(str) {
  var m = /(\d{3,4})p/i.exec(str || '');
  if (m) return m[1] + 'p';
  var l = String(str || '').toLowerCase();
  if (l.indexOf('8k') !== -1) return '4320p';
  if (l.indexOf('4k') !== -1) return '2160p';
  if (l.indexOf('2k') !== -1) return '1440p';
  return 'Unknown';
}

function b64decode(s) {
  if (typeof atob === 'function') return atob(s);
  var c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '', bits = 0, val = 0;
  s = String(s).replace(/=+$/, '');
  for (var i = 0; i < s.length; i++) {
    val = (val << 6) | c.indexOf(s.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((val >> bits) & 255);
      val = val & ((1 << bits) - 1);
    }
  }
  return out;
}

function anchors(html) {
  var out = [];
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))) {
    var h = /href=["']([^"']*)["']/i.exec(m[1]);
    var c = /class=["']([^"']*)["']/i.exec(m[1]);
    out.push({ href: h ? h[1].replace(/&amp;/g, '&') : '', cls: c ? c[1] : '', text: strip(m[2]) });
  }
  return out;
}

function pixelFinal(link) {
  if (/download/i.test(link)) return link;
  return baseOf(link) + '/api/file/' + link.substring(link.lastIndexOf('/') + 1) + '?download';
}

// HEAD مع متابعة التحويلات، ونأخذ الرابط النهائي
async function finalUrl(url) {
  try {
    var r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    return r.url || url;
  } catch (e) {
    return null;
  }
}

var _dbg = [];

// نجرّب الرابط كما هو أولًا، ثم النطاق الأحدث من urls.json إن اختلف
async function resolveHubCloud(url) {
  var first = await resolveHubCloudOnce(url, false);
  if (first.length) return first;
  var source = /hubcloud/i.test(url) ? 'hubcloud' : 'vcloud';
  var base = baseOf(url);
  var latest = await latestBase(base, source);
  if (latest && latest !== base) return resolveHubCloudOnce(url, true);
  return first;
}

async function resolveHubCloudOnce(url, useLatest) {
  var base = baseOf(url);
  var source = /hubcloud/i.test(url) ? 'hubcloud' : 'vcloud';
  var latest = useLatest ? await latestBase(base, source) : base;
  var newUrl = url;
  if (base !== latest) { newUrl = url.replace(base, latest); base = latest; }

  var html = await getText(newUrl);
  var link = '';
  if (newUrl.indexOf('/video/') !== -1) {
    var vm = /<div[^>]*class=["'][^"']*\bvd\b[^"']*["'][^>]*>[\s\S]*?<center>[\s\S]*?<a[^>]*href=["']([^"']+)["']/i.exec(html);
    link = vm ? vm[1] : '';
  } else if (/vcloud/i.test(newUrl)) {
    var dm = /var\s+url\s*=\s*atob\s*\(\s*atob\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/.exec(html);
    link = dm ? b64decode(b64decode(dm[1])) : '';
  } else {
    var um = /var url = '([^']*)'/.exec(html);
    link = um ? um[1] : '';
  }
  if (!link) { _dbg.push(hostOf(newUrl) + ': no download link in page'); return []; }
  if (link.indexOf('https://') !== 0) link = base + link;

  var doc = await getText(link);
  var hm = /<div[^>]*card-header[^>]*>([\s\S]*?)<\/div>/i.exec(doc);
  var header = hm ? strip(hm[1]) : '';
  var sm = /<i[^>]*id=["']size["'][^>]*>([\s\S]*?)<\/i>/i.exec(doc);
  var size = sm ? strip(sm[1]) : '';
  var quality = qFrom(header);

  var pm = /var\s+pxl\s*=\s*["']([^"']+)["']/.exec(doc);
  var pixel = pm ? pm[1] : '';

  var btns = [];
  var h2re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  var hh;
  while ((hh = h2re.exec(doc))) {
    anchors(hh[1]).forEach(function (a) {
      if (/\bbtn\b/.test(a.cls)) btns.push(a);
    });
  }

  function mk(u, server) {
    return { url: u, quality: quality, size: size, server: server || '', label: header, headers: {} };
  }

  var results = await Promise.all(btns.map(async function (b) {
    var l = b.href, t = b.text;
    try {
      if (t.indexOf('FSL Server') !== -1) return [mk(l, 'FSL Server')];
      if (t.indexOf('FSLv2') !== -1) return [mk(l, 'FSLv2 Server')];
      if (t.indexOf('Mega Server') !== -1) return [mk(l, 'Mega Server')];
      if (t.indexOf('Download File') !== -1) return [mk(l, '')];
      if (t.indexOf('BuzzServer') !== -1) {
        var r = await fetch(l + '/download', { headers: { 'User-Agent': UA, 'Referer': l } });
        var dl = r.headers.get('hx-redirect') || '';
        return dl ? [mk(baseOf(l) + dl, 'BuzzServer')] : [];
      }
      if (l.indexOf('pixeldra') !== -1) {
        return pixel ? [mk(pixelFinal(pixel), 'Pixeldrain')] : [];
      }
      if (t.indexOf('Server : 10Gbps') !== -1) {
        var f = await finalUrl(l);
        if (!f) return [];
        if (f.indexOf('link=') !== -1) f = f.substring(f.indexOf('link=') + 5);
        return [mk(f, 'Download')];
      }
      // Gofile: غير مدعوم حاليًا
    } catch (e) {}
    return [];
  }));
  return results.reduce(function (acc, r) { return acc.concat(r); }, []);
}

async function resolveGDFlix(url) {
  var base = baseOf(url);
  var latest = await latestBase(base, 'gdflix');
  var newUrl = url;
  if (base !== latest) { newUrl = url.replace(base, latest); base = latest; }

  var html = await getText(newUrl);
  var fileName = '', fileSize = '';
  var lre = /<li[^>]*list-group-item[^>]*>([\s\S]*?)<\/li>/gi;
  var lm;
  while ((lm = lre.exec(html))) {
    var tx = strip(lm[1]);
    if (!fileName && tx.indexOf('Name') !== -1 && tx.indexOf('Name : ') !== -1) fileName = tx.substring(tx.indexOf('Name : ') + 7);
    if (!fileSize && tx.indexOf('Size') !== -1 && tx.indexOf('Size : ') !== -1) fileSize = tx.substring(tx.indexOf('Size : ') + 7);
  }
  var quality = qFrom(fileName);

  function mk(u, server) {
    return { url: u, quality: quality, size: fileSize, server: server || '', label: fileName, headers: {} };
  }

  var results = await Promise.all(anchors(html).map(async function (a) {
    var t = a.text, l = a.href;
    if (!l) return [];
    try {
      if (t.indexOf('FSL V2') !== -1) return [mk(l, 'FSL V2')];
      if (t.indexOf('DIRECT DL') !== -1) return [mk(l, 'Direct')];
      if (t.indexOf('DIRECT SERVER') !== -1) return [mk(l, 'Direct')];
      if (t.indexOf('CLOUD DOWNLOAD [R2]') !== -1) return [mk(l, 'Cloud')];
      if (t.indexOf('GD Index') !== -1) {
        var out = [];
        for (var ty = 1; ty <= 2; ty++) {
          var pg = await getText(base + l + '?type=' + ty);
          anchors(pg).forEach(function (x) {
            if (/btn-success/.test(x.cls) && x.href) out.push(mk(x.href, 'CF'));
          });
        }
        return out;
      }
      if (t.indexOf('FAST CLOUD') !== -1) {
        var pg2 = await getText(base + l);
        var fm = /<div[^>]*card-body[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["']/i.exec(pg2);
        return fm ? [mk(fm[1], 'FAST CLOUD')] : [];
      }
      if (l.indexOf('pixeldra') !== -1) return [mk(pixelFinal(l), 'Pixeldrain')];
      if (t.indexOf('Instant DL') !== -1) {
        var loc = '';
        try {
          var r = await fetch(l, { headers: { 'User-Agent': UA }, redirect: 'manual' });
          loc = r.headers.get('location') || '';
        } catch (e) {}
        if (!loc) {
          var r2 = await fetch(l, { headers: { 'User-Agent': UA } });
          loc = r2.url || '';
        }
        var i = loc.indexOf('url=');
        var inst = i !== -1 ? loc.substring(i + 4) : '';
        return inst ? [mk(inst, 'Instant Download')] : [];
      }
      // GoFile: غير مدعوم حاليًا
    } catch (e) {}
    return [];
  }));
  return results.reduce(function (acc, r) { return acc.concat(r); }, []);
}

async function resolveLink(url) {
  try {
    if (/gdflix|gdlink/i.test(url)) return await resolveGDFlix(url);
    if (/hubcloud|vcloud/i.test(url)) return await resolveHubCloud(url);
  } catch (e) { _dbg.push(hostOf(url) + ': ' + (e && e.message ? e.message : e)); }
  return [];
}

// ===== Movies4u (movies4u.td) =====
var HOST_RE = /hubcloud|vcloud|gdflix|gdlink/i;
var UA_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

async function getPage(base, url) {
  var r = await fetch(url, { headers: { 'User-Agent': UA_DESKTOP, 'Referer': base + '/' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + String(url).replace(/^https?:\/\//, '').slice(0, 50));
  return r.text();
}

function absUrl(base, u) {
  if (/^https?:\/\//i.test(u)) return u;
  return base + (u.charAt(0) === '/' ? '' : '/') + u;
}

function hostOf(u) {
  var m = /^https?:\/\/([^\/]+)/i.exec(u);
  return m ? m[1] : '?';
}

function parseEpisodes(html) {
  var tokens = [];
  var re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>|>([^<]+)(?=<)/g;
  var m;
  while ((m = re.exec(html))) {
    if (m[1]) tokens.push({ link: m[1] });
    else tokens.push({ text: m[2] });
  }
  var hasMarkers = tokens.some(function (t) { return t.text && /Ep\s?\d{2}/.test(t.text); });
  var map = {};
  var ep = 1;
  var started = false;
  tokens.forEach(function (t) {
    if (t.text) {
      var em = /Ep\s?(\d{2})/.exec(t.text);
      if (em) { ep = parseInt(em[1], 10); started = true; }
    } else if (HOST_RE.test(t.link)) {
      if (hasMarkers && !started) return;
      (map[ep] = map[ep] || []).push(t.link);
      if (!hasMarkers) ep++;
    }
  });
  return map;
}

function parseHostLinks(html) {
  var out = [];
  var re = /<a\b[^>]*href=["']([^"']+)["']/gi;
  var m;
  while ((m = re.exec(html))) {
    if (HOST_RE.test(m[1])) out.push(m[1]);
  }
  return out;
}

// نتائج البحث: روابط داخل عناوين h1..h4
function parseResults(html, base) {
  var out = [];
  var seen = {};
  var re = /<h[1-4]\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))) {
    var h = /href\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (!h) continue;
    var href = absUrl(base, h[1].replace(/&amp;/g, '&'));
    if (hostOf(href) !== hostOf(base) || /\/(category|page|tag|author)\//i.test(href) || seen[href]) continue;
    seen[href] = true;
    out.push({ href: href, title: strip(m[2]) });
  }
  return out;
}

// الصفحة مقسمة إلى كتل: عنوان (h2..h6) + الروابط التي تليه
function parseBlocks(html) {
  var cur = { heading: '', anchors: [] };
  var blocks = [cur];
  var re = /<(h[2-6])\b[^>]*>([\s\S]*?)<\/\1>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      cur = { heading: strip(m[2]), anchors: [] };
      blocks.push(cur);
    } else {
      var h = /href\s*=\s*["']([^"']+)["']/i.exec(m[3]);
      if (h) cur.anchors.push({ href: h[1].replace(/&amp;/g, '&'), text: strip(m[4]) });
    }
  }
  return blocks;
}

var SKIP_HREF = /\.apk|facebook\.com|twitter\.com|linkedin\.com|t\.me\/|whatsapp|telegram|imdb\.com|youtube/i;

// هل عنوان المنشور يشمل الموسم المطلوب؟ مثل: Season 2 – 4
function seasonCovers(title, s) {
  var m = /Season\s*0*(\d+)(?:\s*[–\-]\s*0*(\d+))?/i.exec(title);
  if (m) {
    var a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    return s >= a && s <= b;
  }
  var m2 = /\bS0*(\d+)\b/.exec(title);
  if (m2) return parseInt(m2[1], 10) === s;
  return true;
}

// وضع التشخيص: عند الفشل يظهر سطر في قائمة السيرفرات يشرح السبب. اجعله false بعد أن يعمل المزوّد.
var DEBUG = true;

function debugStream(msg) {
  return [{ name: 'Movies4u DEBUG', title: msg, url: 'https://example.com/debug.mp4', quality: 'Unknown', headers: {}, provider: 'movies4u' }];
}

async function getStreams(tmdbId, mediaType, season, episode) {
  var step = 'start';
  _dbg = [];
  function fail(m) { return DEBUG ? debugStream(m) : []; }
  try {
    step = 'base';
    var base = await getBase();
    if (!base) return fail('Movies4u domain unknown: set BASE_OVERRIDE');
    step = 'meta (tmdb ' + tmdbId + ')';
    var meta = await getMeta(tmdbId, mediaType);
    if (!meta || !meta.title) return fail('no title from metadata');

    var isTv = mediaType === 'tv';
    var s = Number(season), e = Number(episode);
    step = 'search "' + meta.title + '"';
    var query = isTv ? meta.title : meta.title + ' ' + (meta.year || '');
    var results = parseResults(await getPage(base, base + '/?s=' + encodeURIComponent(query).replace(/%20/g, '+')), base);
    var nt = norm(meta.title);
    var cands = results.filter(function (r) { return norm(r.title).indexOf(nt) !== -1; });
    if (!isTv && meta.year) {
      var wy = cands.filter(function (r) { return r.title.indexOf(meta.year) !== -1; });
      if (wy.length) cands = wy;
    }
    if (isTv) cands = cands.filter(function (r) { return seasonCovers(r.title, s); });
    if (!cands.length) return fail('no match "' + meta.title + '" ' + (meta.year || '') + ' @ ' + base + ' (results=' + results.length + ')');
    cands = cands.slice(0, 3);

    step = 'pages';
    var jobs = []; // { url, label }
    var seasonRe = new RegExp('Season\\s*0*' + s + '\\b', 'i');
    await Promise.all(cands.map(async function (c) {
      try {
        var blocks = parseBlocks(await getPage(base, c.href));
        blocks.forEach(function (b) {
          b.anchors.forEach(function (a) {
            if (!a.href || SKIP_HREF.test(a.href) || hostOf(absUrl(base, a.href)) === hostOf(base)) return;
            if (!isTv) {
              if (/download|watch/i.test(a.text) && !/android|watch\s*online/i.test(a.text)) jobs.push({ url: a.href, label: b.heading });
            } else if (seasonRe.test(b.heading) && /single/i.test(b.heading) && /episodes?/i.test(a.text) && !/batch|zip/i.test(a.text)) {
              jobs.push({ url: a.href, label: b.heading });
            }
          });
        });
      } catch (err) {}
    }));

    var seen = {};
    jobs = jobs.filter(function (j) {
      if (seen[j.url]) return false;
      seen[j.url] = true;
      return true;
    });
    if (!jobs.length) return fail('post found but no download buttons (candidates=' + cands.length + ')');

    step = 'mdrive ' + jobs.length + ' pages';
    var links = []; // { url, label }
    await Promise.all(jobs.map(async function (j) {
      try {
        var html = await getPage(base, j.url);
        var found = isTv ? ((parseEpisodes(html)[e]) || []) : parseHostLinks(html);
        found.forEach(function (u) { links.push({ url: u, label: j.label }); });
      } catch (err) {}
    }));
    var seen2 = {};
    links = links.filter(function (l) {
      if (seen2[l.url]) return false;
      seen2[l.url] = true;
      return true;
    });
    if (!links.length) return fail('opened ' + jobs.length + ' download pages but found no HubCloud/GDFlix links (' + hostOf(jobs[0].url) + ')');

    step = 'resolve ' + links.length + ' links';
    var hosts = {};
    var res2 = await Promise.all(links.map(async function (l) {
      var h = hostOf(l.url);
      hosts[h] = (hosts[h] || 0) + 1;
      var res = await resolveLink(l.url);
      return res.map(function (r) {
        return {
          name: 'Movies4u',
          title: meta.title + (r.server ? ' • ' + r.server : '') + (r.size ? ' • ' + r.size : '') + ' • ' + (r.label || l.label),
          url: r.url,
          quality: r.quality || qualityOf(l.label),
          headers: r.headers || {},
          provider: 'movies4u'
        };
      });
    }));

    var out = res2.reduce(function (acc, r) { return acc.concat(r); }, []);
    if (!out.length) {
      var hs = Object.keys(hosts).map(function (k) { return k + ' x' + hosts[k]; }).join(', ');
      return fail('found ' + links.length + ' links, none playable. hosts: ' + (hs || 'none') + (_dbg.length ? ' | ' + _dbg.slice(0, 3).join(' | ') : ''));
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
