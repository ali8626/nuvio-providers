// VegaMovies provider for Nuvio (port of the CloudStream VegaMoviesProvider.kt)
// Status: search + page parsing + V-Cloud extraction ported (untested in Nuvio).
// Reuses the HubCloud/GDFlix extractors from the MoviesDrive port. Not ported: Gofile links.

var TMDB_API_KEY = ''; // اختياري: إن تركته فارغًا نستخدم aiometadata
var FALLBACK_BASE = 'https://vegamovies.mq';
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
  if (m.vegamovies) return String(m.vegamovies).replace(/\/$/, '');
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

// ===== VegaMovies: البحث وقراءة الصفحات =====
function absUrl(base, u) {
  if (/^https?:\/\//i.test(u)) return u;
  return base + (u.charAt(0) === '/' ? '' : '/') + u;
}

var _tried = [];

// نتائج البحث من صفحة HTML (شبكة الأفلام): a > img[alt]
function parseGrid(html) {
  var out = [];
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))) {
    var img = /<img\b[^>]*>/i.exec(m[2]);
    var href = /href=["']([^"']+)["']/i.exec(m[1]);
    if (!img || !href) continue;
    var alt = /alt=["']([^"']*)["']/i.exec(img[0]);
    if (!alt || !alt[1]) continue;
    out.push({ permalink: href[1].replace(/&amp;/g, '&'), post_title: strip(alt[1].replace(/^Download\s+/i, '')) });
  }
  return out;
}

async function searchHits(base, title) {
  var enc = encodeURIComponent(title);
  _tried = [];
  try {
    var res = JSON.parse(await getText(base + '/search.php?q=' + enc + '&page=1'));
    var h = (res.hits || []).map(function (x) { return x.document; }).filter(Boolean);
    if (h.length) return h;
    _tried.push('search.php: 0 hits');
  } catch (e) { _tried.push('search.php: ' + (e && e.message ? e.message : e)); }
  try {
    var g = parseGrid(await getText(base + '/?s=' + enc));
    if (g.length) return g;
    _tried.push('?s=: 0 results');
  } catch (e2) { _tried.push('?s=: ' + (e2 && e2.message ? e2.message : e2)); }
  return [];
}

async function findPage(base, meta) {
  var hits = await searchHits(base, meta.title);
  var nt = norm(meta.title);
  var cands = hits.filter(function (d) { return norm(d.post_title).indexOf(nt) !== -1; });
  var pick = null;
  if (meta.imdbId) pick = hits.filter(function (d) { return d.imdb_id === meta.imdbId; })[0];
  if (!pick && meta.year) {
    pick = cands.filter(function (d) { return String(d.post_title).indexOf(meta.year) !== -1; })[0];
  }
  if (!pick) pick = cands[0];
  if (!pick) return null;
  var url = absUrl(base, pick.permalink);
  return { url: url, html: await getText(url) };
}

// الأفلام: روابط الأزرار a:has(button.dwd-button)
function parseDwdButtons(html) {
  var out = [];
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))) {
    if (/dwd-button/.test(m[2])) {
      var h = /href=["']([^"']+)["']/i.exec(m[1]);
      if (h) out.push({ href: h[1].replace(/&amp;/g, '&'), text: strip(m[2]) });
    }
  }
  return out;
}

// المسلسلات: عناوين h3/h5 التي فيها الجودة، ومعها الروابط (من <p> التالية أو من العنوان)
function parseSeriesTags(html) {
  var out = [];
  var re = /<(h3|h5)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  var m;
  while ((m = re.exec(html))) {
    var text = strip(m[2]);
    if (!/(4K|[0-9]*0p)/i.test(text) || /zip/i.test(text)) continue;
    var sm = /(?:Season |S)(\d+)/.exec(m[0]);
    var after = html.substring(re.lastIndex);
    var pm = /^\s*<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(after);
    out.push({
      season: sm ? parseInt(sm[1], 10) : 0,
      text: text,
      links: pm ? anchors(pm[1]) : anchors(m[2])
    });
  }
  return out;
}

function pickUnilink(list) {
  var u = list.filter(function (a) { return /v-cloud|episode|download/i.test(a.text); })[0];
  if (!u) u = list.filter(function (a) { return /g-direct/i.test(a.text); })[0];
  return u ? u.href : '';
}

// صفحة الحلقات: روابط vcloud بالترتيب (الأولى = الحلقة 1)
function parseVcloudList(html) {
  var out = [];
  var re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  var m;
  while ((m = re.exec(html))) {
    anchors(m[1]).forEach(function (a) {
      if (/vcloud/i.test(a.href)) out.push(a.href);
    });
  }
  return out;
}

// وضع التشخيص: عند الفشل يظهر سطر في قائمة السيرفرات يشرح السبب. اجعله false بعد أن يعمل المزوّد.
var DEBUG = true;

function debugStream(msg) {
  return [{ name: 'VegaMovies DEBUG', title: msg, url: 'https://example.com/debug.mp4', quality: 'Unknown', headers: {}, provider: 'vegamovies' }];
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
    var page = await findPage(base, meta);
    if (!page) return fail('no match "' + meta.title + '" ' + (meta.year || '') + ' @ ' + base + ' [' + _tried.join('; ') + ']');
    step = 'links';

    var links = []; // { url, label }
    var jobs = [];

    if (mediaType === 'tv') {
      var s = Number(season), e = Number(episode);
      var all = parseSeriesTags(page.html);
      var tags = all.filter(function (t) { return t.season === s; });
      if (!tags.length && s === 1) tags = all.filter(function (t) { return t.season === 0; });
      tags.forEach(function (t) {
        jobs.push((async function () {
          var eurl = pickUnilink(t.links);
          if (!eurl) return;
          var list = parseVcloudList(await getText(absUrl(base, eurl)));
          if (list[e - 1]) links.push({ url: list[e - 1], label: t.text });
        })().catch(function () {}));
      });
    } else {
      parseDwdButtons(page.html).forEach(function (b) {
        jobs.push((async function () {
          var pg = await getText(absUrl(base, b.href));
          var vc = anchors(pg).filter(function (a) { return /v-cloud/i.test(a.text); })[0];
          if (vc && vc.href) links.push({ url: vc.href, label: b.text });
        })().catch(function () {}));
      });
    }
    await Promise.all(jobs);

    var seen = {};
    links = links.filter(function (l) {
      if (seen[l.url]) return false;
      seen[l.url] = true;
      return true;
    });
    if (!links.length) return fail('page found but no V-Cloud links ' + page.url);

    step = 'resolve ' + links.length + ' links';
    var results = await Promise.all(links.map(async function (l) {
      var res = await resolveLink(l.url);
      return res.map(function (r) {
        return {
          name: 'VegaMovies',
          title: meta.title + (r.server ? ' • ' + r.server : '') + (r.size ? ' • ' + r.size : '') + ' • ' + (r.label || l.label),
          url: r.url,
          quality: r.quality || qualityOf(l.label),
          headers: r.headers || {},
          provider: 'vegamovies'
        };
      });
    }));

    var out = results.reduce(function (acc, r) { return acc.concat(r); }, []);
    if (!out.length) return fail('found ' + links.length + ' links but extractors returned nothing');
    return out;
  } catch (e) {
    return fail('ERR at ' + step + ': ' + (e && e.message ? e.message : e));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
