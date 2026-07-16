'use strict';

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns').promises;
const { chromium } = require('playwright');
const extractPage = require('./extract');

// CLOUD=1 — режим публичного облачного сервера: слушаем 0.0.0.0,
// включаем лимиты, SSRF-защиту и отключаем интерактивные сессии.
const CLOUD = process.env.CLOUD === '1' || process.env.CLOUD === 'true';
const PORT = Number(process.env.PORT || 4511);
const HOST = process.env.HOST || (CLOUD ? '0.0.0.0' : '127.0.0.1');
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 20); // импортов в час с одного IP (только CLOUD)
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 10);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 48 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 180000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const SLICE_HEIGHT = 4000; // лимит Figma на картинку — 4096px

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------- запуск браузера ----------

let headlessBrowserPromise = null;

async function launchBrowser(headless) {
  const attempts = [{ channel: 'chrome' }, { channel: 'msedge' }, {}];
  let lastErr = null;
  for (const extra of attempts) {
    try {
      const browser = await chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled'],
        ...extra,
      });
      console.log('[browser] запущен:', extra.channel || 'bundled chromium', headless ? '(headless)' : '(с окном)');
      return browser;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    'Could not launch a browser — install Google Chrome or run: npx playwright install chromium / ' +
      'Не удалось запустить браузер — установите Google Chrome или выполните: npx playwright install chromium\n' +
      (lastErr ? String(lastErr.message || lastErr) : '')
  );
}

function getHeadlessBrowser() {
  if (!headlessBrowserPromise) {
    headlessBrowserPromise = launchBrowser(true)
      .then((b) => {
        b.on('disconnected', () => {
          headlessBrowserPromise = null;
        });
        return b;
      })
      .catch((e) => {
        headlessBrowserPromise = null;
        throw e;
      });
  }
  return headlessBrowserPromise;
}

function clamp(v, min, max, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ---------- локализация ошибок (en по умолчанию, ru по параметру lang) ----------

const MSG = {
  'no-url': ['Missing url', 'Не указан url'],
  'open-fail': ['Could not open the page: ', 'Не удалось открыть страницу: '],
  'http-only': ['Only http/https links are allowed', 'Разрешены только http/https ссылки'],
  'blocked': ['This address is not reachable from the cloud server', 'Этот адрес недоступен на облачном сервере'],
  'no-host': ['Could not resolve host: ', 'Не удалось найти такой сайт: '],
  'rate': [
    'Rate limit: at most {n} imports per hour per address. Try later or self-host the server (see the plugin page).',
    'Лимит: не больше {n} импортов в час с одного адреса. Попробуйте позже или запустите свой сервер (инструкция на странице плагина).',
  ],
  'busy': ['The server is busy right now, try again in a minute', 'Сервер сейчас перегружен, попробуйте через минуту'],
  'timeout': ['Timeout: the operation took longer than {n} seconds', 'Таймаут: операция шла дольше {n} секунд'],
  'bad-json': ['Invalid JSON', 'Некорректный JSON'],
  'session-gone': [
    'Session not found — the browser window was closed. Open the browser again.',
    'Сессия не найдена — окно браузера было закрыто. Откройте браузер заново.',
  ],
  'tabs-closed': ['All tabs are closed. Open the browser again.', 'Все вкладки закрыты. Откройте браузер заново.'],
  'session-cloud': [
    'The behind-login mode works only with a local server: a cloud server cannot open a browser window on your computer. Start the local server (npm start) and set its address in Advanced.',
    'Режим «Сайт за логином» доступен только с локальным сервером: облачный сервер не может открыть окно браузера на вашем компьютере. Запустите локальный сервер (npm start) и укажите его адрес в настройках.',
  ],
};

function pickLang(params) {
  return params && params.lang === 'ru' ? 'ru' : 'en';
}

function T(key, lang, extra) {
  const pair = MSG[key] || [key, key];
  let s = lang === 'ru' ? pair[1] : pair[0];
  if (extra !== undefined) {
    s = s.indexOf('{n}') >= 0 ? s.replace('{n}', String(extra)) : s + extra;
  }
  return s;
}

// ---------- защита облачного режима ----------

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));
    return (
      low === '::1' || low === '::' ||
      low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80')
    );
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return true;
  return (
    p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254)
  );
}

function isBlockedHostname(host) {
  const h = String(host || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  return false;
}

async function assertPublicUrl(url, lang) {
  if (!CLOUD) return;
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(T('http-only', lang));
  if (isBlockedHostname(u.hostname)) throw new Error(T('blocked', lang));
  if (!net.isIP(u.hostname)) {
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(T('no-host', lang, u.hostname));
    for (const a of addrs) {
      if (isPrivateIp(a.address)) throw new Error(T('blocked', lang));
    }
  }
}

// лимит запросов на IP (только в облаке)
const rateMap = new Map();
function checkRate(ip, lang) {
  if (!CLOUD) return;
  const now = Date.now();
  let e = rateMap.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + 3600 * 1000 };
    rateMap.set(ip, e);
  }
  if (++e.count > RATE_LIMIT) {
    throw new Error(T('rate', lang, RATE_LIMIT));
  }
  if (rateMap.size > 10000) {
    for (const [k, v] of rateMap) if (now > v.resetAt) rateMap.delete(k);
  }
}

// ограничение параллельных снапшотов
let activeSlots = 0;
const slotWaiters = [];
async function withSlot(fn, lang) {
  if (activeSlots >= MAX_CONCURRENT && slotWaiters.length >= MAX_QUEUE) {
    throw new Error(T('busy', lang));
  }
  while (activeSlots >= MAX_CONCURRENT) {
    await new Promise((r) => slotWaiters.push(r));
  }
  activeSlots++;
  try {
    return await fn();
  } finally {
    activeSlots--;
    const w = slotWaiters.shift();
    if (w) w();
  }
}

// ---------- общий конвейер снятия страницы ----------

async function scrollAndSettle(page, maxHeight) {
  await page
    .evaluate(async (maxH) => {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const H = Math.min(document.documentElement.scrollHeight, maxH);
      for (let ypos = 0; ypos < H; ypos += 700) {
        window.scrollTo(0, ypos);
        await delay(90);
      }
      window.scrollTo(0, H);
      await delay(300);
      window.scrollTo(0, 0);
      await delay(300);
      const imgs = Array.from(document.images).slice(0, 300);
      await Promise.race([
        Promise.all(imgs.map((i) => (i.decode ? i.decode().catch(() => {}) : null))),
        delay(4000),
      ]);
    }, maxHeight)
    .catch(() => {});
  await page.waitForTimeout(400);
}

async function fetchImages(context, list) {
  const imageData = {};
  let total = 0;
  const queue = [...(list || [])];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      try {
        let buf = null;
        let mime = '';
        if (item.url.startsWith('data:')) {
          const dm = item.url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
          if (dm) {
            mime = dm[1] || 'text/plain';
            buf = dm[2] ? Buffer.from(dm[3], 'base64') : Buffer.from(decodeURIComponent(dm[3]), 'utf8');
          }
        } else {
          const resp = await context.request.get(item.url, { timeout: 20000, maxRedirects: 5 });
          if (resp.ok()) {
            buf = await resp.body();
            mime = (resp.headers()['content-type'] || '').split(';')[0].trim();
          }
        }
        if (buf && buf.length && buf.length <= MAX_IMAGE_BYTES && total + buf.length <= MAX_TOTAL_IMAGE_BYTES) {
          total += buf.length;
          imageData[item.id] = { b64: buf.toString('base64'), mime, url: item.url.slice(0, 500) };
        }
      } catch (e) {
        /* пропускаем битые картинки */
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { imageData, totalBytes: total };
}

async function takeScreenshotSlices(page, pageWidth, pageHeight) {
  const slices = [];
  for (let y = 0; y < pageHeight && slices.length < 12; y += SLICE_HEIGHT) {
    const h = Math.min(SLICE_HEIGHT, pageHeight - y);
    if (h < 4) break;
    try {
      const buf = await page.screenshot({
        fullPage: true, // clip за пределами вьюпорта работает только с fullPage
        clip: { x: 0, y, width: pageWidth, height: h },
        type: 'jpeg',
        quality: 80,
        timeout: 30000,
      });
      slices.push({ b64: buf.toString('base64'), mime: 'image/jpeg', y, h });
    } catch (e) {
      console.log('[screenshot] срез не снялся:', e.message || e);
      break;
    }
  }
  return slices;
}

async function capturePage(page, context, params) {
  const maxHeight = clamp(params.maxHeight, 2000, 40000, 20000);
  const maxNodes = clamp(params.maxNodes, 500, 12000, 6000);

  await scrollAndSettle(page, maxHeight);

  console.log('[capture] извлекаю слои…');
  const data = await page.evaluate(extractPage, { maxNodes, maxHeight });
  console.log(
    '[capture] слоёв:', data.nodeCount,
    'картинок:', data.images.length,
    data.truncated ? '(обрезано по лимиту)' : ''
  );

  const { imageData, totalBytes } = await fetchImages(context, data.images);
  console.log('[capture] картинок скачано:', Object.keys(imageData).length, '(' + Math.round(totalBytes / 1024) + ' KB)');
  delete data.images;

  if (params.screenshot) {
    console.log('[capture] снимаю скриншот-эталон…');
    data.screenshotSlices = await takeScreenshotSlices(page, data.pageWidth, data.pageHeight);
    console.log('[capture] срезов скриншота:', data.screenshotSlices.length);
  }

  return { ...data, imageData };
}

// ---------- обычный снапшот (headless) ----------

async function snapshot(params) {
  const lang = pickLang(params);
  let url = String(params.url || '').trim();
  if (!url) throw new Error(T('no-url', lang));
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const width = clamp(params.width, 320, 3000, 1440);
  const colorScheme = params.colorScheme === 'dark' ? 'dark' : 'light';

  await assertPublicUrl(url, lang);

  const browser = await getHeadlessBrowser();
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    userAgent: UA,
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    colorScheme,
    reducedMotion: 'reduce',
  });
  if (CLOUD) {
    // страница не должна ходить по внутренним адресам хостинга
    await context.route('**/*', (route) => {
      try {
        if (isBlockedHostname(new URL(route.request().url()).hostname)) return route.abort();
      } catch (e) {}
      return route.continue();
    });
  }
  const page = await context.newPage();

  try {
    console.log('[snapshot] открываю', url, 'width=' + width, 'theme=' + colorScheme);
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    } catch (e) {
      if (page.url() === 'about:blank') throw new Error(T('open-fail', lang, String((e && e.message) || e).split('\n')[0]));
      console.log('[snapshot] load не дождался, продолжаю с тем, что есть');
    }
    await page.waitForTimeout(1200);
    return await capturePage(page, context, params);
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------- интерактивные сессии (сайты за логином) ----------

const sessions = new Map(); // id -> { browser, context, page, timer }

function touchSession(s) {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => closeSession(s.id).catch(() => {}), SESSION_TTL_MS);
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  if (s.timer) clearTimeout(s.timer);
  await s.browser.close().catch(() => {});
  console.log('[session] закрыта:', id);
}

async function openSession(params) {
  let url = String(params.url || '').trim();
  if (!url) throw new Error(T('no-url', pickLang(params)));
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const width = clamp(params.width, 320, 3000, 1440);
  const headless = params._headless === true; // только для автотестов

  const browser = await launchBrowser(headless);
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    colorScheme: params.colorScheme === 'dark' ? 'dark' : 'light',
  });
  const page = await context.newPage();

  const id = crypto.randomBytes(8).toString('hex');
  const s = { id, browser, context, page, timer: null };
  sessions.set(id, s);
  touchSession(s);

  browser.on('disconnected', () => {
    const cur = sessions.get(id);
    if (cur) {
      if (cur.timer) clearTimeout(cur.timer);
      sessions.delete(id);
      console.log('[session] окно закрыто пользователем:', id);
    }
  });

  page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('[session] открыта:', id, url, 'width=' + width);
  return { sessionId: id, width };
}

async function captureSession(params) {
  const lang = pickLang(params);
  const s = sessions.get(String(params.sessionId || ''));
  if (!s) throw new Error(T('session-gone', lang));
  touchSession(s);
  if (s.page.isClosed()) {
    const pages = s.context.pages();
    if (!pages.length) throw new Error(T('tabs-closed', lang));
    s.page = pages[pages.length - 1];
  }
  console.log('[session] снимаю страницу:', s.page.url());
  return capturePage(s.page, s.context, params);
}

// ---------- HTTP ----------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req, res, handler) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1024 * 1024) req.destroy();
    else chunks.push(c);
  });
  req.on('end', async () => {
    let params;
    try {
      params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (e) {
      return sendJson(res, 400, { error: T('bad-json', 'en') });
    }
    try {
      const result = await Promise.race([
        handler(params, req),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(T('timeout', pickLang(params), SNAPSHOT_TIMEOUT_MS / 1000))), SNAPSHOT_TIMEOUT_MS)
        ),
      ]);
      sendJson(res, 200, result);
    } catch (e) {
      console.error('[http] ошибка:', (e && e.message) || e);
      sendJson(res, 500, { error: String((e && e.message) || e) });
    }
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'site-to-figma renderer',
      version: 3,
      port: PORT,
      cloud: CLOUD,
      capabilities: { sessions: !CLOUD, screenshot: true, autoLayout: true },
      sessions: sessions.size,
    });
  }

  if (req.method === 'POST' && req.url === '/snapshot') {
    return readBody(req, res, (p, r) => {
      const lang = pickLang(p);
      checkRate(clientIp(r), lang);
      return withSlot(() => snapshot(p), lang);
    });
  }

  if (req.method === 'POST' && (req.url === '/session/open' || req.url === '/session/capture')) {
    const handler = req.url === '/session/open' ? openSession : captureSession;
    return readBody(req, res, async (p, r) => {
      if (CLOUD) throw new Error(T('session-cloud', pickLang(p)));
      return handler(p, r);
    });
  }
  if (req.method === 'POST' && req.url === '/session/close') {
    return readBody(req, res, async (p) => {
      await closeSession(String(p.sessionId || ''));
      return { ok: true };
    });
  }

  sendJson(res, 404, { error: 'Не найдено' });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Site → Figma: сервер рендеринга запущен (v3' + (CLOUD ? ', облачный режим' : '') + ')');
  console.log('  http://' + (HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1') + ':' + PORT);
  console.log('');
  if (!CLOUD) console.log('  Оставьте это окно открытым и запустите плагин в Figma.');
  else console.log('  Лимиты: ' + RATE_LIMIT + ' импортов/час на IP, ' + MAX_CONCURRENT + ' параллельно.');
  console.log('');
});
