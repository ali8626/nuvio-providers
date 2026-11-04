// HDhub4u provider for Nuvio (port of invokeHdhub4u from CineStreamExtractors.kt)
// Status: search (pingora), page parsing, redirect decoding, HubCloud/V-Cloud and GDFlix extractors ported (untested in Nuvio).
// Not ported yet: Hubdrive, fastdlserver, Gofile and other hosts (shown in the DEBUG line when they are the only ones found).

var TMDB_API_KEY = ''; // اختياري: إن تركته فارغًا نستخدم aiometadata
var FALLBACK_BASE = 'https://new7.hdhub4u.cl';
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

async function getBase() {
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

async function resolveHubCloud(url) {
  var base = baseOf(url);
  var source = /hubcloud/i.test(url) ? 'hubcloud' : 'vcloud';
  var latest = await latestBase(base, source);
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
  if (!link) return [];
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
  } catch (e) {}
  return [];
}

// ===== HDhub4u =====
function absUrl(base, u) {
  if (/^https?:\/\//i.test(u)) return u;
  return base + (u.charAt(0) === '/' ? '' : '/') + u;
}

function rot13(str) {
  return String(str).replace(/[a-zA-Z]/g, function (c) {
    var b = c <= 'Z' ? 65 : 97;
    return String.fromCharCode((c.charCodeAt(0) - b + 13) % 26 + b);
  });
}

function b64encode(str) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  str = String(str);
  var out = '';
  for (var i = 0; i < str.length; i += 3) {
    var a = str.charCodeAt(i), b = str.charCodeAt(i + 1), c = str.charCodeAt(i + 2);
    var n = (a << 16) | ((isNaN(b) ? 0 : b) << 8) | (isNaN(c) ? 0 : c);
    out += chars.charAt((n >> 18) & 63) + chars.charAt((n >> 12) & 63) +
      (isNaN(b) ? '=' : chars.charAt((n >> 6) & 63)) +
      (isNaN(c) ? '=' : chars.charAt(n & 63));
  }
  return out;
}

// getRedirectLinks من Utils.kt: روابط وسيطة (greenmountmotors / hubcdn)
async function getRedirectLinks(url) {
  try {
    var doc = await getText(url);
    var re = /s\('o','([A-Za-z0-9+\/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
    var parts = [];
    var m;
    while ((m = re.exec(doc))) parts.push(m[1] || m[2]);
    var combined = parts.join('');
    if (!combined) return '';
    var obj = JSON.parse(b64decode(rot13(b64decode(b64decode(combined)))));
    var encodedUrl = b64decode(obj.o || '').trim();
    var data = b64encode(obj.data || '').trim();
    var wp = String(obj.blog_url || '').trim();
    var direct = '';
    if (wp && data) {
      try { direct = strip(await getText(wp + '?re=' + data)).trim(); } catch (e) {}
    }
    return encodedUrl || direct;
  } catch (e) { return ''; }
}

async function searchPosts(base, query) {
  var url = SEARCH_API + '?q=' + encodeURIComponent(query) +
    '&query_by=' + encodeURIComponent('post_title,category,stars,director,imdb_id') +
    '&query_by_weights=' + encodeURIComponent('4,2,2,2,4') +
    '&sort_by=' + encodeURIComponent('sort_by_date:desc') +
    '&limit=15&highlight_fields=none&use_cache=true&page=1';
  var r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': base + '/' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' search.pingora.fyi');
  var j = JSON.parse(await r.text());
  return (j.hits || []).map(function (h) { return h.document; }).filter(function (d) { return d && d.permalink; });
}

function pageUrl(base, permalink) {
  var path = String(permalink).replace(/^https?:\/\/[^\/]+/i, '').replace(/^\//, '');
  return base + '/' + path;
}

var BAD_LINK = /whatsapp\.com|telegram|catimages/i;

// a[data-wpel-link=external]
function extLinks(html) {
  var out = [];
  var re = /<a\b([^>]*)>/gi;
  var m;
  while ((m = re.exec(html))) {
    if (!/data-wpel-link\s*=\s*["']external["']/i.test(m[1])) continue;
    var h = /href\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (h && !BAD_LINK.test(h[1])) out.push(h[1].replace(/&amp;/g, '&'));
  }
  return out;
}

function movieLinks(html) {
  var blocks = [];
  var re = /<div[^>]*class=["'][^"']*\bmod\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  var m;
  while ((m = re.exec(html))) blocks.push(m[1]);
  return extLinks(blocks.length ? blocks.join('\n') : html);
}

function pageTitle(html) {
  var h = /<h[12][^>]*class=["'][^"']*(?:page-title|kno-ecr-pt)[^"']*["'][^>]*>([\s\S]*?)<\/h[12]>/i.exec(html);
  var t = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return strip((h ? h[1] : '') + ' ' + (t ? t[1] : ''));
}

function episodeLinks(html, ep) {
  var epRe = new RegExp('\\bEPiSODE\\s*0*' + ep + '\\b', 'i');
  var anyEp = /\bEPiSODE\s*\d+\b/i;
  var blockRe = /<(h3|h4|h5|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  var m, found = null, headerEnd = 0;
  while ((m = blockRe.exec(html))) {
    if (epRe.test(strip(m[2]))) { found = m[0]; headerEnd = blockRe.lastIndex; break; }
  }
  if (!found) return [];
  var rest = html.substring(headerEnd);
  var cut = rest.length;
  var hr = rest.search(/<hr\b/i);
  if (hr >= 0) cut = hr;
  var br = /<(h3|h4|h5|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  var b;
  while ((b = br.exec(rest))) {
    if (b.index >= cut) break;
    if (anyEp.test(strip(b[2]))) { cut = b.index; break; }
  }
  return extLinks(found + rest.substring(0, cut));
}

function hostOf(u) {
  var m = /^https?:\/\/([^\/]+)/i.exec(u);
  return m ? m[1] : '?';
}

// وضع التشخيص: عند الفشل يظهر سطر في قائمة السيرفرات يشرح السبب. اجعله false بعد أن يعمل المزوّد.
var DEBUG = true;

function debugStream(msg) {
  return [{ name: 'HDhub4u DEBUG', title: msg, url: 'https://example.com/debug.mp4', quality: 'Unknown', headers: {}, provider: 'hdhub4u' }];
}

async function getStreams(tmdbId, mediaType, season, episode) {
  var step = 'start';
  function fail(m) { return DEBUG ? debugStream(m) : []; }
  try {
    step = 'base';
    var base = await getBase();
    step = 'meta (tmdb ' + tmdbId + ')';
    var meta = await getMeta(tmdbId, mediaType);
    if (!meta || !meta.title) return fail('no title from metadata');
    step = 'search "' + meta.title + '"';
    var hits = await searchPosts(base, meta.imdbId || meta.title);
    if (!hits.length && meta.imdbId) hits = await searchPosts(base, meta.title);
    var nt = norm(meta.title);
    var cands = hits.filter(function (d) {
      return (meta.imdbId && d.imdb_id === meta.imdbId) || norm(d.post_title).indexOf(nt) !== -1;
    });
    if (!cands.length) return fail('no match "' + meta.title + '" ' + (meta.year || '') + ' @ ' + base + ' (hits=' + hits.length + ')');

    var isTv = mediaType === 'tv';
    if (!isTv && meta.year) {
      var withYear = cands.filter(function (d) { return String(d.post_title).indexOf(meta.year) !== -1; });
      if (withYear.length) cands = withYear;
    }
    cands = cands.slice(0, isTv ? 6 : 2);

    step = 'pages';
    var s = Number(season), e = Number(episode);
    var seasonRe = new RegExp('(?:Season\\s*0*|S0*)' + s + '\\b', 'i');
    var links = [];
    await Promise.all(cands.map(async function (d) {
      try {
        var html = await getText(pageUrl(base, d.permalink));
        if (!isTv) {
          movieLinks(html).forEach(function (u) { links.push(u); });
        } else if (seasonRe.test(pageTitle(html))) {
          episodeLinks(html, e).forEach(function (u) { links.push(u); });
        }
      } catch (err) {}
    }));

    var seen = {};
    links = links.filter(function (u) {
      if (seen[u]) return false;
      seen[u] = true;
      return true;
    });
    if (!links.length) return fail('page found but no download links (candidates=' + cands.length + ')');

    step = 'resolve ' + links.length + ' links';
    var hosts = {};
    var results = await Promise.all(links.map(async function (u) {
      var target = u;
      if (/greenmountmotors|hubcdn/i.test(u)) target = await getRedirectLinks(u);
      if (!target) return [];
      var h = hostOf(target);
      hosts[h] = (hosts[h] || 0) + 1;
      var res = await resolveLink(target);
      return res.map(function (r) {
        return {
          name: 'HDhub4u',
          title: meta.title + (r.server ? ' • ' + r.server : '') + (r.size ? ' • ' + r.size : '') + (r.label ? ' • ' + r.label : ''),
          url: r.url,
          quality: r.quality || 'Unknown',
          headers: r.headers || {},
          provider: 'hdhub4u'
        };
      });
    }));

    var out = results.reduce(function (acc, r) { return acc.concat(r); }, []);
    if (!out.length) {
      var hs = Object.keys(hosts).map(function (k) { return k + ' x' + hosts[k]; }).join(', ');
      return fail('found ' + links.length + ' links, none playable. hosts: ' + (hs || 'none'));
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
