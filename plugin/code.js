'use strict';

figma.showUI(__html__, { width: 420, height: 640, themeColors: true });

// ---------- шрифты ----------

let fontIndex = null; // Map<lowerFamily, { family, styles: Map<normStyle, actualStyle> }>
const fontCache = new Map();

const GENERIC_FAMILIES = {
  'sans-serif': 'Inter',
  'system-ui': 'Inter',
  '-apple-system': 'Inter',
  'blinkmacsystemfont': 'Inter',
  'ui-sans-serif': 'Inter',
  'serif': 'Georgia',
  'ui-serif': 'Georgia',
  'monospace': 'Roboto Mono',
  'ui-monospace': 'Roboto Mono',
  'cursive': 'Inter',
  'fantasy': 'Inter',
};

const WEIGHT_CANDIDATES = {
  100: ['thin', 'hairline', 'extralight', 'ultralight', 'light'],
  200: ['extralight', 'ultralight', 'thin', 'light'],
  300: ['light', 'extralight', 'thin', 'regular', 'normal'],
  400: ['regular', 'normal', 'book', 'roman', 'medium'],
  500: ['medium', 'regular', 'normal', 'semibold'],
  600: ['semibold', 'demibold', 'demi', 'medium', 'bold'],
  700: ['bold', 'semibold', 'medium', 'heavy'],
  800: ['extrabold', 'ultrabold', 'heavy', 'bold', 'black'],
  900: ['black', 'heavy', 'extrabold', 'ultrabold', 'bold'],
};

function normStyleName(s) {
  return String(s).toLowerCase().replace(/[\s_-]+/g, '');
}

async function ensureFontIndex() {
  if (fontIndex) return fontIndex;
  fontIndex = new Map();
  const fonts = await figma.listAvailableFontsAsync();
  for (const f of fonts) {
    const fam = f.fontName.family;
    const key = fam.toLowerCase();
    let entry = fontIndex.get(key);
    if (!entry) {
      entry = { family: fam, styles: new Map() };
      fontIndex.set(key, entry);
    }
    entry.styles.set(normStyleName(f.fontName.style), f.fontName.style);
  }
  return fontIndex;
}

function pickStyle(entry, weight, italic) {
  const wKey = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  const cands = WEIGHT_CANDIDATES[wKey] || ['regular'];
  const styles = entry.styles;
  if (italic) {
    for (const c of cands) {
      const key = c === 'regular' || c === 'normal' ? 'italic' : c + 'italic';
      if (styles.has(key)) return styles.get(key);
    }
    if (styles.has('italic')) return styles.get('italic');
  }
  for (const c of cands) {
    if (styles.has(c)) return styles.get(c);
  }
  if (styles.has('regular')) return styles.get('regular');
  const first = styles.values().next();
  return first.done ? null : first.value;
}

async function resolveFont(familyStack, weight, italic) {
  const key = familyStack + '|' + weight + '|' + italic;
  if (fontCache.has(key)) return fontCache.get(key);
  const promise = (async () => {
    const index = await ensureFontIndex();
    const tried = [];
    for (const raw of String(familyStack || '').split(',')) {
      const fam = raw.trim().replace(/^["']|["']$/g, '');
      if (!fam) continue;
      tried.push({ fam: GENERIC_FAMILIES[fam.toLowerCase()] || fam, requested: true });
    }
    for (const fam of ['Inter', 'Roboto', 'Helvetica Neue', 'Arial']) {
      tried.push({ fam, requested: false });
    }
    for (const t of tried) {
      const entry = index.get(t.fam.toLowerCase());
      if (!entry) continue;
      const style = pickStyle(entry, weight, italic);
      if (!style) continue;
      try {
        await figma.loadFontAsync({ family: entry.family, style });
        return { fontName: { family: entry.family, style }, requested: t.requested };
      } catch (e) {
        /* пробуем следующий */
      }
    }
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    return { fontName: { family: 'Inter', style: 'Regular' }, requested: false };
  })();
  fontCache.set(key, promise);
  return promise;
}

// ---------- заливки ----------

function linearGradientTransform(angleDeg) {
  const rad = (((angleDeg == null ? 180 : angleDeg) % 360) * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const ax = 0.5 - dx / 2;
  const ay = 0.5 - dy / 2;
  return [
    [dx, dy, -(ax * dx + ay * dy)],
    [-dy, dx, dy * ax - dx * ay],
  ];
}

function paintsFrom(fills, ctx) {
  const out = [];
  for (const fl of fills || []) {
    if (fl.type === 'solid' && fl.color) {
      out.push({
        type: 'SOLID',
        color: { r: fl.color.r, g: fl.color.g, b: fl.color.b },
        opacity: fl.color.a != null ? fl.color.a : 1,
      });
    } else if (fl.type === 'image') {
      const hash = ctx.hashByRef[fl.ref];
      if (hash) {
        out.push({
          type: 'IMAGE',
          imageHash: hash,
          scaleMode: fl.mode === 'TILE' ? 'TILE' : fl.mode === 'FIT' ? 'FIT' : 'FILL',
        });
      }
    } else if (fl.type === 'grad' && fl.stops && fl.stops.length >= 2) {
      const stops = fl.stops
        .map((s) => ({
          position: Math.max(0, Math.min(1, s.pos || 0)),
          color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a != null ? s.color.a : 1 },
        }))
        .sort((a, b) => a.position - b.position);
      if (fl.kind === 'radial') {
        out.push({ type: 'GRADIENT_RADIAL', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops });
      } else {
        out.push({ type: 'GRADIENT_LINEAR', gradientTransform: linearGradientTransform(fl.angle), gradientStops: stops });
      }
    }
  }
  return out;
}

// ---------- отмена и прогресс ----------

let cancelRequested = false;

function sleep0() {
  return new Promise((r) => setTimeout(r, 0));
}

async function tick(ctx) {
  if (cancelRequested) throw new Error('__cancelled__');
  ctx.count++;
  if (ctx.count % 120 === 0) {
    figma.ui.postMessage({ type: 'progress', done: ctx.count, total: ctx.total });
    await sleep0();
  }
}

// ---------- создание узлов ----------

function sanitizeChars(str) {
  let out = '';
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c >= 32 || c === 9 || c === 10 || c === 13) out += ch;
  }
  return out;
}

function isPUA(chars) {
  let has = false;
  for (const ch of chars) {
    const c = ch.codePointAt(0);
    if (c === 32) continue;
    if (c >= 0xe000 && c <= 0xf8ff) has = true;
    else return false;
  }
  return has;
}

async function makeText(n, parent, ax, ay, ctx) {
  const s = n.text || {};
  const chars = sanitizeChars(s.chars || '');
  if (!chars.trim()) return null;

  const resolved = await resolveFont(s.family, s.weight || 400, !!s.italic);
  if (!resolved.requested && isPUA(chars)) {
    // иконка из иконочного шрифта, которого нет — не рисуем «тофу»
    ctx.stats.iconSkipped++;
    return null;
  }

  const t = figma.createText();
  parent.appendChild(t);
  t.name = n.name || chars.slice(0, 24);
  t.fontName = resolved.fontName;
  try {
    t.characters = chars;
  } catch (e) {
    t.remove();
    return null;
  }
  t.fontSize = Math.max(s.size || 16, 1);
  if (s.lineHeight) t.lineHeight = { value: Math.max(s.lineHeight, 1), unit: 'PIXELS' };
  if (s.letterSpacing) t.letterSpacing = { value: s.letterSpacing, unit: 'PIXELS' };
  const c = s.color || { r: 0, g: 0, b: 0, a: 1 };
  t.fills = [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a != null ? c.a : 1 }];
  t.textAlignHorizontal = ['LEFT', 'RIGHT', 'CENTER', 'JUSTIFIED'].indexOf(s.align) >= 0 ? s.align : 'LEFT';
  if (s.transform === 'uppercase') t.textCase = 'UPPER';
  else if (s.transform === 'lowercase') t.textCase = 'LOWER';
  else if (s.transform === 'capitalize') t.textCase = 'TITLE';
  if (/underline/.test(s.decoration || '')) t.textDecoration = 'UNDERLINE';
  else if (/line-through/.test(s.decoration || '')) t.textDecoration = 'STRIKETHROUGH';

  t.x = n.x - ax;
  t.y = n.y - ay;
  try {
    t.resize(Math.max(n.w + 2, 4), Math.max(n.h, (s.size || 16) * 1.1));
    t.textAutoResize = 'NONE';
  } catch (e) {}
  await tick(ctx);
  return t;
}

async function makeSvg(n, parent, ax, ay, ctx) {
  let node = null;
  try {
    node = figma.createNodeFromSvg(n.svg);
  } catch (e) {
    ctx.stats.svgFailed++;
    return null;
  }
  parent.appendChild(node);
  node.name = n.name || 'svg';
  node.x = n.x - ax;
  node.y = n.y - ay;
  try {
    if (n.w > 0.5 && n.h > 0.5) node.resize(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
  } catch (e) {}
  if (n.opacity != null && n.opacity < 1) node.opacity = n.opacity;
  await tick(ctx);
  return node;
}

function applyAutoLayout(f, n, created, ctx) {
  const L = n.layout;
  try {
    f.layoutMode = L.mode === 'H' ? 'HORIZONTAL' : 'VERTICAL';
    f.primaryAxisSizingMode = 'FIXED';
    f.counterAxisSizingMode = 'FIXED';
    f.resizeWithoutConstraints(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
    f.paddingTop = Math.max(L.padT || 0, 0);
    f.paddingRight = Math.max(L.padR || 0, 0);
    f.paddingBottom = Math.max(L.padB || 0, 0);
    f.paddingLeft = Math.max(L.padL || 0, 0);
    f.itemSpacing = L.justify === 'SPACE_BETWEEN' ? 0 : Math.max(L.gap || 0, 0);
    f.primaryAxisAlignItems = ['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN'].indexOf(L.justify) >= 0 ? L.justify : 'MIN';
    let align = ['MIN', 'MAX', 'CENTER', 'BASELINE'].indexOf(L.align) >= 0 ? L.align : 'MIN';
    if (align === 'BASELINE' && L.mode !== 'H') align = 'MIN';
    f.counterAxisAlignItems = align;
    if (L.wrap) {
      f.layoutWrap = 'WRAP';
      f.counterAxisSpacing = Math.max(L.gapCross || L.gap || 0, 0);
    }

    const containerCross = L.mode === 'H' ? n.h - (L.padT + L.padB) : n.w - (L.padL + L.padR);
    for (const pair of created) {
      const kid = pair[0];
      const node = pair[1];
      if (kid.abs) {
        try {
          node.layoutPositioning = 'ABSOLUTE';
          node.x = kid.x - n.x;
          node.y = kid.y - n.y;
        } catch (e) {}
      } else {
        if (kid.grow) {
          try { node.layoutGrow = 1; } catch (e) {}
        }
        const crossSize = L.mode === 'H' ? kid.h : kid.w;
        if ((kid.stretchSelf || L.stretchDefault) && Math.abs(crossSize - containerCross) <= 2) {
          try { node.layoutAlign = 'STRETCH'; } catch (e) {}
        }
      }
    }
    ctx.stats.autoLayout++;
  } catch (e) {
    /* остаёмся на абсолютных координатах */
  }
}

async function makeEl(n, parent, ax, ay, ctx) {
  const f = figma.createFrame();
  parent.appendChild(f);
  f.name = n.name || 'frame';
  f.x = n.x - ax;
  f.y = n.y - ay;
  try {
    f.resizeWithoutConstraints(Math.max(n.w, 0.01), Math.max(n.h, 0.01));
  } catch (e) {}

  let paints = paintsFrom(n.fills, ctx);
  if (!paints.length && n.placeholder) {
    paints = [{ type: 'SOLID', color: { r: 0.88, g: 0.88, b: 0.9 } }];
  }
  f.fills = paints;
  f.clipsContent = !!n.clip;

  const rad = n.radius || [0, 0, 0, 0];
  try {
    if (rad[0] || rad[1] || rad[2] || rad[3]) {
      f.topLeftRadius = rad[0];
      f.topRightRadius = rad[1];
      f.bottomRightRadius = rad[2];
      f.bottomLeftRadius = rad[3];
    }
  } catch (e) {}

  if (n.stroke) {
    const sc = n.stroke.color;
    f.strokes = [{ type: 'SOLID', color: { r: sc.r, g: sc.g, b: sc.b }, opacity: sc.a != null ? sc.a : 1 }];
    f.strokeAlign = 'INSIDE';
    const sides = [n.stroke.top, n.stroke.right, n.stroke.bottom, n.stroke.left];
    const uniform = sides.every((v) => v === sides[0]);
    try {
      if (uniform) {
        f.strokeWeight = sides[0];
      } else {
        f.strokeTopWeight = n.stroke.top;
        f.strokeRightWeight = n.stroke.right;
        f.strokeBottomWeight = n.stroke.bottom;
        f.strokeLeftWeight = n.stroke.left;
      }
      if (n.stroke.dash) f.dashPattern = n.stroke.dash;
    } catch (e) {}
  }

  if (n.shadows && n.shadows.length) {
    const effects = [];
    for (const sh of n.shadows) {
      effects.push({
        type: sh.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: { r: sh.color.r, g: sh.color.g, b: sh.color.b, a: sh.color.a != null ? sh.color.a : 0.25 },
        offset: { x: sh.x, y: sh.y },
        radius: Math.max(sh.blur, 0),
        spread: sh.spread || 0,
        visible: true,
        blendMode: 'NORMAL',
      });
    }
    try {
      f.effects = effects;
    } catch (e) {}
  }

  if (n.opacity != null && n.opacity < 1) f.opacity = n.opacity;

  await tick(ctx);

  const created = [];
  for (const kid of n.children || []) {
    const node = await createAny(kid, f, n.x, n.y, ctx);
    if (node) created.push([kid, node]);
  }

  if (ctx.autoLayout && n.layout && created.some((p) => !p[0].abs)) {
    applyAutoLayout(f, n, created, ctx);
  }
  return f;
}

async function createAny(n, parent, ax, ay, ctx) {
  try {
    if (n.t === 'text') return await makeText(n, parent, ax, ay, ctx);
    if (n.t === 'svg') return await makeSvg(n, parent, ax, ay, ctx);
    return await makeEl(n, parent, ax, ay, ctx);
  } catch (e) {
    if (String(e && e.message) === '__cancelled__') throw e;
    ctx.stats.failed++;
    return null;
  }
}

function countNodes(n) {
  let c = 1;
  for (const k of n.children || []) c += countNodes(k);
  return c;
}

// ---------- стили цветов и текста ----------

function toHexByte(v) {
  const s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
  return s.length === 1 ? '0' + s : s;
}

function colorToHex(c) {
  return '#' + toHexByte(c.r) + toHexByte(c.g) + toHexByte(c.b);
}

async function createSiteStyles(data, hostname, stats, folders) {
  const colors = new Map();
  const texts = new Map();
  (function walkN(n) {
    for (const f of n.fills || []) {
      if (f.type === 'solid' && f.color && f.color.a > 0.98) {
        const hex = colorToHex(f.color);
        const e = colors.get(hex) || { color: f.color, count: 0 };
        e.count++;
        colors.set(hex, e);
      }
    }
    if (n.t === 'text' && n.text) {
      const s = n.text;
      if (s.color && s.color.a > 0.5) {
        const hex = colorToHex(s.color);
        const e = colors.get(hex) || { color: s.color, count: 0 };
        e.count++;
        colors.set(hex, e);
      }
      const key = s.family.split(',')[0] + '|' + Math.round(s.size) + '|' + s.weight + '|' + (s.italic ? 1 : 0);
      const e = texts.get(key) || {
        family: s.family, size: Math.round(s.size), weight: s.weight,
        italic: !!s.italic, lineHeight: s.lineHeight, count: 0,
      };
      e.count++;
      texts.set(key, e);
    }
    for (const k of n.children || []) walkN(k);
  })(data.root);

  const topColors = [...colors.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 16);
  for (const pair of topColors) {
    try {
      const st = figma.createPaintStyle();
      st.name = hostname + '/' + folders.colors + '/' + pair[0].toUpperCase();
      const c = pair[1].color;
      st.paints = [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } }];
      stats.styles++;
    } catch (e) {}
  }

  const topTexts = [...texts.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  for (const info of topTexts) {
    try {
      const resolved = await resolveFont(info.family, info.weight, info.italic);
      const ts = figma.createTextStyle();
      const famShort = String(info.family).split(',')[0].replace(/["']/g, '').trim() || 'Font';
      ts.name = hostname + '/' + folders.text + '/' + famShort + ' ' + info.size + ' · ' + info.weight + (info.italic ? ' Italic' : '');
      ts.fontName = resolved.fontName;
      ts.fontSize = info.size;
      if (info.lineHeight) ts.lineHeight = { value: info.lineHeight, unit: 'PIXELS' };
      stats.styles++;
    } catch (e) {}
  }
}

// ---------- скриншот-эталон ----------

function buildScreenshotFrame(slices, W, H, label, stats, name) {
  const fr = figma.createFrame();
  figma.currentPage.appendChild(fr);
  fr.name = (name || 'Screenshot') + ' · ' + label;
  try {
    fr.resizeWithoutConstraints(Math.max(W, 1), Math.max(H, 1));
  } catch (e) {}
  fr.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  fr.clipsContent = true;
  for (const sl of slices) {
    try {
      const img = figma.createImage(figma.base64Decode(sl.b64));
      const rect = figma.createRectangle();
      fr.appendChild(rect);
      rect.name = 'slice ' + sl.y;
      rect.x = 0;
      rect.y = sl.y;
      rect.resize(Math.max(W, 1), Math.max(sl.h, 1));
      rect.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
    } catch (e) {
      stats.imagesSkipped++;
    }
  }
  fr.locked = true;
  return fr;
}

// ---------- сборка ----------

const NOTIFY = {
  en: {
    done: (n, al) => 'Imported: ' + n + ' layers' + (al ? ', Auto Layout: ' + al + ' frames' : ''),
    cancelled: 'Import canceled',
  },
  ru: {
    done: (n, al) => 'Импортировано: ' + n + ' слоёв' + (al ? ', Auto Layout: ' + al + ' фреймов' : ''),
    cancelled: 'Импорт отменён',
  },
};

const STYLE_FOLDERS = {
  en: { colors: 'Colors', text: 'Text' },
  ru: { colors: 'Цвета', text: 'Текст' },
};

// Раскладка пакета: варианты одной страницы идут вправо, новая страница — новой строкой.
const batchState = { id: null, startX: 0, nextX: 0, y: 0, rowMaxH: 0, frames: [] };

async function build(data, opts) {
  const stats = { images: 0, imagesSkipped: 0, svgFailed: 0, iconSkipped: 0, failed: 0, autoLayout: 0, styles: 0 };
  const hashByRef = {};

  figma.ui.postMessage({ type: 'status', key: 'upload-images' });
  let imgCount = 0;
  for (const key of Object.keys(data.imageData || {})) {
    if (cancelRequested) throw new Error('__cancelled__');
    const img = data.imageData[key];
    try {
      const bytes = figma.base64Decode(img.b64);
      hashByRef[key] = figma.createImage(bytes).hash;
      stats.images++;
    } catch (e) {
      stats.imagesSkipped++;
    }
    if (++imgCount % 10 === 0) await sleep0();
  }

  const ctx = {
    hashByRef,
    stats,
    count: 0,
    total: countNodes(data.root),
    autoLayout: opts.autoLayout !== false,
  };

  if (opts.batchId !== batchState.id) {
    batchState.id = opts.batchId;
    batchState.startX = Math.round(figma.viewport.center.x - data.pageWidth / 2);
    batchState.nextX = batchState.startX;
    batchState.y = Math.round(figma.viewport.center.y - Math.min(data.pageHeight, 2000) / 2);
    batchState.rowMaxH = 0;
    batchState.frames = [];
  } else if (opts.newRow) {
    // следующая страница — под предыдущей, с отступом
    batchState.y += batchState.rowMaxH + 400;
    batchState.nextX = batchState.startX;
    batchState.rowMaxH = 0;
  }

  let rootFrame = null;
  try {
    rootFrame = await makeEl(data.root, figma.currentPage, data.root.x, data.root.y, ctx);
    rootFrame.name = opts.label || (data.title || 'page');
    rootFrame.x = batchState.nextX;
    rootFrame.y = batchState.y;
    batchState.nextX += data.pageWidth + 160;
    batchState.rowMaxH = Math.max(batchState.rowMaxH, rootFrame.height);
    batchState.frames.push(rootFrame);

    if (opts.screenshot && data.screenshotSlices && data.screenshotSlices.length) {
      const shot = buildScreenshotFrame(data.screenshotSlices, data.pageWidth, data.pageHeight, opts.label || '', stats, opts.screenshotName);
      shot.x = batchState.nextX;
      shot.y = batchState.y;
      batchState.nextX += data.pageWidth + 160;
      batchState.rowMaxH = Math.max(batchState.rowMaxH, shot.height);
      batchState.frames.push(shot);
    }

    if (opts.makeStyles) {
      figma.ui.postMessage({ type: 'status', key: 'make-styles' });
      let hostname = 'site';
      try {
        hostname = String(data.url || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '') || 'site';
      } catch (e) {}
      await createSiteStyles(data, hostname, stats, STYLE_FOLDERS[opts.lang === 'ru' ? 'ru' : 'en']);
    }
  } catch (e) {
    if (String(e && e.message) === '__cancelled__' && rootFrame) {
      try { rootFrame.remove(); } catch (e2) {}
    }
    throw e;
  }

  figma.viewport.scrollAndZoomIntoView(batchState.frames);
  figma.currentPage.selection = batchState.frames.slice();

  return {
    created: ctx.count,
    images: stats.images,
    imagesSkipped: stats.imagesSkipped,
    svgFailed: stats.svgFailed,
    iconSkipped: stats.iconSkipped,
    autoLayout: stats.autoLayout,
    styles: stats.styles,
  };
}

// ---------- сообщения ----------

figma.ui.onmessage = async (msg) => {
  if (!msg) return;

  if (msg.type === 'ui-ready') {
    let settings = null;
    let history = [];
    try {
      settings = await figma.clientStorage.getAsync('settings');
      history = (await figma.clientStorage.getAsync('history')) || [];
    } catch (e) {}
    figma.ui.postMessage({ type: 'init', settings: settings || null, history });
    return;
  }

  if (msg.type === 'save-settings') {
    try { await figma.clientStorage.setAsync('settings', msg.settings); } catch (e) {}
    return;
  }

  if (msg.type === 'save-history') {
    try { await figma.clientStorage.setAsync('history', msg.history); } catch (e) {}
    return;
  }

  if (msg.type === 'cancel') {
    cancelRequested = true;
    return;
  }

  if (msg.type === 'build') {
    cancelRequested = false;
    const say = NOTIFY[(msg.opts && msg.opts.lang) === 'ru' ? 'ru' : 'en'];
    try {
      const res = await build(msg.payload, msg.opts || {});
      figma.ui.postMessage({ type: 'done', result: res });
      figma.notify(say.done(res.created, res.autoLayout));
    } catch (e) {
      if (String(e && e.message) === '__cancelled__') {
        figma.ui.postMessage({ type: 'cancelled' });
        figma.notify(say.cancelled);
      } else {
        figma.ui.postMessage({ type: 'error', text: String((e && e.message) || e) });
      }
    }
  }
};
