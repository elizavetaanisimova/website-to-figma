'use strict';

// Поиск страниц сайта: сначала карта сайта (robots.txt → sitemap.xml),
// если её нет — обход внутренних ссылок настоящим браузером.

const zlib = require('zlib');
const { request } = require('playwright');

const MAX_PAGES_HARD = 500;       // потолок на отдаваемый список
const MAX_SITEMAP_FILES = 15;     // сколько файлов карты разбираем (у больших сайтов их десятки)
const MAX_SITEMAP_BYTES = 12 * 1024 * 1024;
const CRAWL_MAX_DEPTH = 2;        // 0 — стартовая, 1 — из меню, 2 — со страниц второго уровня
const CRAWL_MAX_VISITS = 40;      // сколько страниц реально открываем при обходе
const CRAWL_DEADLINE_MS = 100000; // общий бюджет обхода: запрос целиком живёт 180 с
const TITLE_MAX_PAGES = 250;      // выше этого числа заголовки не тянем — долго
const TITLE_CONCURRENCY = 12;

const SITEMAP_GUESSES = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/wp-sitemap.xml',
  '/sitemap/sitemap.xml',
  '/sitemap1.xml',
];

// расширения, которые точно не страницы
const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|flac|pdf|zip|rar|7z|tar|gz|bz2|dmg|exe|msi|pkg|docx?|xlsx?|pptx?|csv|rss|atom|json|xml|txt|css|js|mjs|woff2?|ttf|otf|eot)$/i;

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function rootDomain(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

// Один ли это сайт. includeSubdomains: blog.site.com считать своим для site.com
function sameSite(a, b, includeSubdomains) {
  const ha = rootDomain(a);
  const hb = rootDomain(b);
  if (ha === hb) return true;
  if (!includeSubdomains) return false;
  return ha.endsWith('.' + hb) || hb.endsWith('.' + ha);
}

// Приводим адрес к каноническому виду, чтобы /about, /about/ и /about#top не дублировались
function normalizeUrl(raw, base) {
  let u;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  // мусорные метки рекламных кампаний — это те же страницы
  const junk = [];
  u.searchParams.forEach((_, k) => {
    if (/^(utm_|yclid|gclid|fbclid|_ga|mc_eid|ref)/i.test(k)) junk.push(k);
  });
  for (const k of junk) u.searchParams.delete(k);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  if (SKIP_EXT.test(u.pathname)) return null;
  return u.toString();
}

// Человеческое имя страницы, когда заголовка нет
function labelFromUrl(url) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    if (path === '/' || path === '') return 'Главная / Home';
    const last = path.split('/').filter(Boolean).pop() || path;
    return last.replace(/[-_]+/g, ' ').replace(/\.(html?|php|aspx?)$/i, '').trim() || path;
  } catch (e) {
    return url;
  }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname) + (u.search || '');
  } catch (e) {
    return url;
  }
}

// ---------- сеть ----------

async function getBody(ctx, url, maxBytes) {
  try {
    const resp = await ctx.get(url, { timeout: 15000, maxRedirects: 5, failOnStatusCode: false });
    if (!resp.ok()) return null;
    let buf = await resp.body();
    if (buf.length > (maxBytes || MAX_SITEMAP_BYTES)) buf = buf.slice(0, maxBytes || MAX_SITEMAP_BYTES);
    // .xml.gz отдаётся сырым гзипом — Content-Encoding его не покрывает
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try { buf = zlib.gunzipSync(buf); } catch (e) { return null; }
    }
    return buf.toString('utf8');
  } catch (e) {
    return null;
  }
}

// ---------- карта сайта ----------

function extractLocs(xml) {
  const out = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const v = decodeEntities(m[1]);
    if (v) out.push(v);
  }
  return out;
}

async function sitemapUrls(ctx, origin, log) {
  const found = [];          // сюда собираем адреса страниц
  const seenFiles = new Set();
  const queue = [];

  // 1. robots.txt подсказывает, где лежит карта
  const robots = await getBody(ctx, origin + '/robots.txt', 512 * 1024);
  if (robots) {
    const re = /^\s*sitemap:\s*(\S+)/gim;
    let m;
    while ((m = re.exec(robots))) queue.push(m[1].trim());
    if (queue.length) log('карта сайта из robots.txt: ' + queue.length);
  }

  // 2. стандартные места
  if (!queue.length) {
    for (const guess of SITEMAP_GUESSES) queue.push(origin + guess);
  }

  let filesRead = 0;
  while (queue.length && filesRead < MAX_SITEMAP_FILES && found.length < MAX_PAGES_HARD) {
    const fileUrl = queue.shift();
    if (!fileUrl || seenFiles.has(fileUrl)) continue;
    seenFiles.add(fileUrl);

    const xml = await getBody(ctx, fileUrl);
    if (!xml || xml.indexOf('<loc>') < 0) continue;
    filesRead++;

    const locs = extractLocs(xml);
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    if (isIndex) {
      // вложенные карты — в очередь
      for (const loc of locs) queue.push(loc);
      log('индекс карты: ' + fileUrl + ' → ' + locs.length + ' файлов');
    } else {
      for (const loc of locs) found.push(loc);
      log('карта: ' + fileUrl + ' → ' + locs.length + ' адресов');
    }
  }

  return found;
}

// ---------- обход ссылок ----------

async function crawlUrls(browser, startUrl, host, includeSubdomains, maxPages, log) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const found = new Map(); // url -> подпись из текста ссылки
  const deadline = Date.now() + CRAWL_DEADLINE_MS;
  try {
    const page = await context.newPage();
    let queue = [{ url: startUrl, depth: 0 }];
    const visited = new Set();
    let visits = 0;

    while (queue.length && visits < CRAWL_MAX_VISITS && found.size < maxPages) {
      if (Date.now() > deadline) {
        log('бюджет обхода исчерпан — отдаю, что успел: ' + found.size);
        break;
      }
      const item = queue.shift();
      if (!item || visited.has(item.url)) continue;
      visited.add(item.url);
      visits++;

      try {
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(600);
      } catch (e) {
        continue;
      }

      const links = await page
        .evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .slice(0, 800)
            .map((a) => ({ href: a.href, text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) }))
        )
        .catch(() => []);

      for (const link of links) {
        const norm = normalizeUrl(link.href, item.url);
        if (!norm) continue;
        let h;
        try { h = new URL(norm).hostname; } catch (e) { continue; }
        if (!sameSite(h, host, includeSubdomains)) continue;

        if (!found.has(norm)) {
          found.set(norm, link.text || '');
          if (found.size >= maxPages) break;
        }
        if (item.depth + 1 <= CRAWL_MAX_DEPTH && !visited.has(norm)) {
          queue.push({ url: norm, depth: item.depth + 1 });
        }
      }
      log('обход: ' + item.url + ' → всего найдено ' + found.size);
    }
  } finally {
    await context.close().catch(() => {});
  }
  return found;
}

// ---------- заголовки страниц ----------

async function fetchTitles(ctx, pages) {
  const queue = pages.slice();
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      if (!p) break;
      try {
        const resp = await ctx.get(p.url, { timeout: 8000, maxRedirects: 5, failOnStatusCode: false });
        if (!resp.ok()) continue;
        const type = (resp.headers()['content-type'] || '').toLowerCase();
        if (type && type.indexOf('html') < 0) continue;
        const buf = await resp.body();
        const head = buf.slice(0, 60 * 1024).toString('utf8');
        const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (m) {
          const title = decodeEntities(stripHtml(m[1])).slice(0, 120);
          if (title) p.title = title;
        }
      } catch (e) {
        /* заголовок не критичен */
      }
    }
  };
  await Promise.all(Array.from({ length: TITLE_CONCURRENCY }, worker));
}

// ---------- главное ----------

/**
 * helpers: { UA, clamp, assertPublicUrl, getHeadlessBrowser, lang, T, CLOUD }
 */
async function discoverPages(params, helpers) {
  const { UA, clamp, assertPublicUrl, getHeadlessBrowser, lang, T, CLOUD } = helpers;

  let url = String(params.url || '').trim();
  if (!url) throw new Error(T('no-url', lang));
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  await assertPublicUrl(url, lang);

  const start = normalizeUrl(url);
  if (!start) throw new Error(T('http-only', lang));

  const maxPages = clamp(params.maxPages, 10, MAX_PAGES_HARD, 200);
  const includeSubdomains = params.includeSubdomains === true;
  const wantTitles = params.titles !== false;

  const u = new URL(start);
  const origin = u.origin;
  const host = u.hostname;

  const log = (m) => console.log('[discover]', m);
  log('ищу страницы: ' + start);

  const ctx = await request.newContext({
    userAgent: UA,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Accept-Language': 'ru,en;q=0.8' },
  });

  let source = 'sitemap';
  const labels = new Map();
  let raw = [];

  try {
    raw = await sitemapUrls(ctx, origin, log);

    // карты нет или она подозрительно пустая — идём по ссылкам
    if (raw.length < 2) {
      log('карта сайта не нашлась — обхожу ссылки');
      source = 'crawl';
      const browser = await getHeadlessBrowser();
      const crawled = await crawlUrls(browser, start, host, includeSubdomains, maxPages, log);
      raw = Array.from(crawled.keys());
      for (const [k, v] of crawled) labels.set(k, v);
    }

    // нормализация + дедуп + отсев чужих доменов
    const seen = new Set();
    let pages = [];
    for (const item of raw) {
      const norm = normalizeUrl(item, origin);
      if (!norm || seen.has(norm)) continue;
      let h;
      try { h = new URL(norm).hostname; } catch (e) { continue; }
      if (!sameSite(h, host, includeSubdomains)) continue;
      seen.add(norm);
      pages.push({ url: norm, path: pathOf(norm), title: labels.get(norm) || '' });
    }

    // стартовая страница всегда первая и всегда в списке
    if (!seen.has(start)) {
      pages.unshift({ url: start, path: pathOf(start), title: '' });
    } else {
      pages = [pages.find((p) => p.url === start)].concat(pages.filter((p) => p.url !== start));
    }

    // короткие пути выше — обычно это разделы верхнего уровня
    const first = pages.shift();
    pages.sort((a, b) => {
      const da = a.path.split('/').length;
      const db = b.path.split('/').length;
      if (da !== db) return da - db;
      return a.path.localeCompare(b.path);
    });
    pages.unshift(first);

    const total = pages.length;
    const truncated = total > maxPages;
    if (truncated) pages = pages.slice(0, maxPages);

    if (wantTitles && pages.length <= TITLE_MAX_PAGES) {
      log('тяну заголовки: ' + pages.length);
      await fetchTitles(ctx, pages);
    }

    for (const p of pages) {
      if (!p.title) p.title = labelFromUrl(p.url);
    }

    log('итого страниц: ' + pages.length + (truncated ? ' (обрезано из ' + total + ')' : '') + ', источник: ' + source);
    return { pages, source, total, truncated, cloud: CLOUD };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

module.exports = { discoverPages, normalizeUrl, labelFromUrl };
