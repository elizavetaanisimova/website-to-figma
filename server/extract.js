'use strict';

// ВАЖНО: эта функция сериализуется Playwright'ом и выполняется ВНУТРИ страницы
// (в контексте браузера). Она не должна ссылаться ни на что из Node.js.
module.exports = async function extractPage(opts) {
  const MAX_NODES = (opts && opts.maxNodes) || 6000;
  const MAX_HEIGHT = (opts && opts.maxHeight) || 20000;
  const MAX_TEXT = 4000;
  const MAX_DEPTH = 80;

  const doc = document;
  const pageWidth = Math.max(doc.documentElement.clientWidth, 1);
  const fullHeight = Math.max(
    doc.documentElement.scrollHeight,
    doc.body ? doc.body.scrollHeight : 0,
    doc.documentElement.clientHeight
  );
  const pageHeight = Math.min(fullHeight, MAX_HEIGHT);

  let nodeCount = 0;
  let truncated = false;

  const images = [];
  const imageIdByUrl = new Map();
  const usedFamilies = new Set(); // семейства, реально встреченные в тексте страницы

  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, TITLE: 1,
    HEAD: 1, BR: 1, WBR: 1, OPTION: 1, OPTGROUP: 1, DATALIST: 1, SOURCE: 1,
    TRACK: 1, MAP: 1, AREA: 1, DIALOG: 1,
  };

  const r2 = (v) => Math.round(v * 100) / 100;

  function refImage(url) {
    if (!url) return null;
    if (/^(about:|javascript:|blob:)/.test(url)) return null;
    if (imageIdByUrl.has(url)) return imageIdByUrl.get(url);
    const id = 'im' + imageIdByUrl.size;
    imageIdByUrl.set(url, id);
    images.push({ id, url });
    return id;
  }

  function parseColor(str) {
    if (!str || str === 'none' || str === 'transparent') return null;
    let m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
    if (m) {
      let a = m[4] === undefined ? 1 : (m[4].indexOf('%') >= 0 ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: Math.max(0, Math.min(a, 1)) };
    }
    m = str.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)/);
    if (m) {
      let a = m[4] === undefined ? 1 : (m[4].indexOf('%') >= 0 ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return { r: +m[1], g: +m[2], b: +m[3], a: Math.max(0, Math.min(a, 1)) };
    }
    m = str.match(/^#([0-9a-fA-F]{3,8})$/);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
      const n = parseInt(h.slice(0, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a };
    }
    return null;
  }

  function splitTopLevel(str, sep) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function parseGradient(str) {
    const m = str.match(/^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s);
    if (!m || m[2] === 'conic') return null;
    const kind = m[2];
    const parts = splitTopLevel(m[3], ',');
    if (!parts.length) return null;
    let angle = 180;
    let stopParts = parts;
    const first = parts[0];
    if (kind === 'linear') {
      const am = first.match(/^(-?[\d.]+)(deg|grad|rad|turn)$/);
      if (am) {
        const v = parseFloat(am[1]);
        angle = am[2] === 'deg' ? v : am[2] === 'rad' ? (v * 180) / Math.PI : am[2] === 'turn' ? v * 360 : v * 0.9;
        stopParts = parts.slice(1);
      } else if (/^to\s/.test(first)) {
        const key = first.replace(/^to\s+/, '').trim();
        const map = {
          top: 0, right: 90, bottom: 180, left: 270,
          'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135,
          'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315,
        };
        angle = map[key] != null ? map[key] : 180;
        stopParts = parts.slice(1);
      }
    } else if (!/rgb|#|color\(/.test(first)) {
      stopParts = parts.slice(1);
    }
    const stops = [];
    for (const p of stopParts) {
      const cm = p.match(/(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8})/);
      if (!cm) continue;
      const color = parseColor(cm[1]);
      if (!color) continue;
      const rest = p.replace(cm[1], '');
      const pm = rest.match(/(-?[\d.]+)%/);
      stops.push({ color, pos: pm ? parseFloat(pm[1]) / 100 : null });
    }
    if (stops.length < 2) return null;
    if (stops[0].pos == null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1;
    for (let i = 1; i < stops.length - 1; i++) {
      if (stops[i].pos == null) {
        let j = i;
        while (stops[j].pos == null) j++;
        const prev = stops[i - 1].pos;
        const next = stops[j].pos;
        const span = j - (i - 1);
        for (let k = i; k < j; k++) stops[k].pos = prev + ((next - prev) * (k - (i - 1))) / span;
      }
    }
    let last = 0;
    for (const s of stops) {
      s.pos = Math.max(0, Math.min(1, s.pos));
      if (s.pos < last) s.pos = last;
      last = s.pos;
    }
    return { kind, angle, stops };
  }

  function parseShadows(str) {
    if (!str || str === 'none') return [];
    return splitTopLevel(str, ',')
      .map((part) => {
        const inset = /\binset\b/.test(part);
        const cm = part.match(/(rgba?\([^)]*\)|color\([^)]*\))/);
        const color = parseColor(cm ? cm[1] : '') || { r: 0, g: 0, b: 0, a: 0 };
        const rest = cm ? part.replace(cm[1], '') : part;
        const nums = (rest.match(/-?[\d.]+px/g) || []).map(parseFloat);
        return { inset, x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, color };
      })
      .filter((s) => s.color.a > 0);
  }

  function firstUrl(str) {
    const um = str.match(/url\((['"]?)(.*?)\1\)/);
    return um && um[2] ? um[2] : null;
  }

  function backgroundFills(st) {
    const fills = [];
    const bc = parseColor(st.backgroundColor);
    if (bc && bc.a > 0) fills.push({ type: 'solid', color: bc });
    const bi = st.backgroundImage;
    if (bi && bi !== 'none') {
      // CSS рисует первый слой background-image СВЕРХУ, поэтому разворачиваем
      const layers = splitTopLevel(bi, ',').reverse();
      const size = (splitTopLevel(st.backgroundSize || '', ',')[0] || 'auto');
      const repeat = (splitTopLevel(st.backgroundRepeat || '', ',')[0] || 'repeat');
      for (const layer of layers) {
        if (/^(-webkit-)?image-set\(/.test(layer) || layer.startsWith('url(')) {
          const url = firstUrl(layer);
          const ref = refImage(url);
          if (ref) {
            let mode = 'FILL';
            if (size.indexOf('contain') >= 0) mode = 'FIT';
            else if (size.indexOf('cover') >= 0) mode = 'FILL';
            else if (repeat.indexOf('no-repeat') < 0 && repeat.indexOf('repeat') >= 0) mode = 'TILE';
            fills.push({ type: 'image', ref, mode });
          }
        } else if (layer.indexOf('gradient(') >= 0) {
          const g = parseGradient(layer);
          if (g) fills.push({ type: 'grad', kind: g.kind === 'radial' ? 'radial' : 'linear', angle: g.angle, stops: g.stops });
        }
      }
    }
    return fills;
  }

  function borderInfo(st) {
    const names = ['Top', 'Right', 'Bottom', 'Left'];
    const sides = names.map((s) => {
      const w = parseFloat(st['border' + s + 'Width']) || 0;
      const styl = st['border' + s + 'Style'];
      const c = parseColor(st['border' + s + 'Color']);
      const ok = styl && styl !== 'none' && styl !== 'hidden' && w > 0 && c && c.a > 0;
      return ok ? { w, c, styl } : null;
    });
    if (!sides.some(Boolean)) return null;
    const firstSide = sides.find(Boolean);
    return {
      color: firstSide.c,
      dash: firstSide.styl === 'dashed' ? [6, 6] : firstSide.styl === 'dotted' ? [2, 2] : null,
      top: sides[0] ? sides[0].w : 0,
      right: sides[1] ? sides[1].w : 0,
      bottom: sides[2] ? sides[2].w : 0,
      left: sides[3] ? sides[3].w : 0,
    };
  }

  function radii(st, w, h) {
    const one = (v) => {
      const n = parseFloat(v) || 0;
      return String(v).indexOf('%') >= 0 ? (n / 100) * Math.min(w, h) : n;
    };
    return [
      one(st.borderTopLeftRadius),
      one(st.borderTopRightRadius),
      one(st.borderBottomRightRadius),
      one(st.borderBottomLeftRadius),
    ];
  }

  function ziOf(st) {
    const z = parseInt(st.zIndex, 10);
    return st.position !== 'static' && !isNaN(z) ? z : 0;
  }

  function textStyleOf(st, chars) {
    let weight = parseInt(st.fontWeight, 10);
    if (isNaN(weight)) weight = /bold/i.test(st.fontWeight || '') ? 700 : 400;
    // Запоминаем семейства из стека — по ним потом отбираем реально нужные @font-face
    String(st.fontFamily || '').split(',').forEach((f) => {
      const n = f.trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (n) usedFamilies.add(n);
    });
    const alignMap = {
      left: 'LEFT', start: 'LEFT', right: 'RIGHT', end: 'RIGHT',
      center: 'CENTER', justify: 'JUSTIFIED', 'justify-all': 'JUSTIFIED',
    };
    return {
      chars: chars.slice(0, MAX_TEXT),
      family: st.fontFamily || '',
      size: parseFloat(st.fontSize) || 16,
      weight,
      italic: /italic|oblique/.test(st.fontStyle || ''),
      lineHeight: st.lineHeight && st.lineHeight !== 'normal' ? parseFloat(st.lineHeight) || null : null,
      letterSpacing: st.letterSpacing && st.letterSpacing !== 'normal' ? parseFloat(st.letterSpacing) || 0 : 0,
      align: alignMap[st.textAlign] || 'LEFT',
      color: parseColor(st.color) || { r: 0, g: 0, b: 0, a: 1 },
      transform: st.textTransform || 'none',
      decoration: st.textDecorationLine || 'none',
    };
  }

  function textKid(node, st) {
    let s = node.textContent || '';
    if (!/\S/.test(s)) return null;
    if (!/pre/.test(st.whiteSpace || '')) s = s.replace(/\s+/g, ' ').trim();
    else s = s.replace(/^\n+|\s+$/g, '');
    if (!s) return null;
    const style = textStyleOf(st, s);
    if (style.color.a === 0) return null;
    const range = doc.createRange();
    range.selectNodeContents(node);
    const tr = range.getBoundingClientRect();
    if (tr.width < 0.5 || tr.height < 0.5) return null;
    const x = tr.left + window.scrollX;
    const y = tr.top + window.scrollY;
    if (x + tr.width < -8 || y + tr.height < -8 || x > pageWidth + 8 || y > pageHeight + 8) return null;
    nodeCount++;
    return {
      t: 'text',
      name: s.slice(0, 24),
      x, y, w: tr.width, h: tr.height,
      zi: 0,
      text: style,
    };
  }

  function nodeName(el, tag) {
    let n = tag.toLowerCase();
    try {
      if (el.id) n += '#' + el.id;
      else if (el.classList && el.classList.length) n += '.' + el.classList[0];
    } catch (e) {}
    return n.slice(0, 48);
  }

  function serializeSvg(el, st, w, h) {
    try {
      const clone = el.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(Math.max(1, Math.round(w))));
      clone.setAttribute('height', String(Math.max(1, Math.round(h))));
      if (st.color) clone.setAttribute('color', st.color);
      const uses = clone.querySelectorAll('use');
      if (uses.length) {
        let defs = clone.querySelector('defs');
        for (const u of uses) {
          const href = u.getAttribute('href') || u.getAttribute('xlink:href');
          if (href && href[0] === '#') {
            const sel = href.replace(/([^\w#-])/g, '\\$1');
            const target = doc.querySelector(sel);
            if (target && !clone.querySelector(sel)) {
              if (!defs) {
                defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
                clone.insertBefore(defs, clone.firstChild);
              }
              defs.appendChild(target.cloneNode(true));
            }
          }
        }
      }
      const s = new XMLSerializer().serializeToString(clone);
      return s.length < 300000 ? s : null;
    } catch (e) {
      return null;
    }
  }

  function pseudoKids(el, x, y, w, h, hasKids) {
    const out = { fills: [], texts: [] };
    for (const which of ['::before', '::after']) {
      let ps;
      try { ps = getComputedStyle(el, which); } catch (e) { continue; }
      if (!ps || ps.display === 'none') continue;
      let content = ps.content || '';
      if (ps.backgroundImage && ps.backgroundImage !== 'none') {
        const url = firstUrl(ps.backgroundImage);
        const ref = refImage(url);
        if (ref) out.fills.push({ type: 'image', ref, mode: 'FIT' });
      }
      if (/^["']/.test(content)) {
        content = content.slice(1, -1);
        if (content && content.length <= 4 && !hasKids && w > 2 && h > 2) {
          const style = textStyleOf(ps, content);
          style.align = 'CENTER';
          if (style.color.a > 0) {
            nodeCount++;
            out.texts.push({ t: 'text', name: 'icon', x, y, w, h, zi: 0, text: style });
          }
        }
      }
    }
    return out;
  }

  // ---- Auto Layout: анализ flex-контейнера ----
  // Возвращает { layout, orderedKids } либо null, если раскладка ненадёжна.
  function computeFlexLayout(st, x, y, w, h, kids) {
    const dir = st.flexDirection || 'row';
    const horiz = dir.indexOf('row') === 0;
    const wrap = st.flexWrap === 'wrap' || st.flexWrap === 'wrap-reverse';
    const flow = kids.filter((k) => !k.abs);
    const absKids = kids.filter((k) => k.abs);
    if (flow.length < 2) return null;

    // Визуальный порядок = порядок элементов auto layout
    // (заодно корректно обрабатывает row-reverse и CSS order)
    const sortKey = horiz
      ? (k) => Math.round(k.y / 8) * 1e7 + k.x
      : (k) => Math.round(k.x / 8) * 1e7 + k.y;
    flow.sort((a, b) => sortKey(a) - sortKey(b));

    // Проверка: дети не перекрываются вдоль главной оси (иначе не рискуем)
    const gaps = [];
    if (!wrap) {
      let prevEnd = null;
      for (const k of flow) {
        const start = horiz ? k.x : k.y;
        const size = horiz ? k.w : k.h;
        if (prevEnd != null) {
          const g = start - prevEnd;
          if (g < -2) return null;
          gaps.push(g);
        }
        prevEnd = start + size;
      }
    }

    const jmap = {
      'flex-start': 'MIN', start: 'MIN', left: 'MIN', normal: 'MIN',
      'flex-end': 'MAX', end: 'MAX', right: 'MAX', center: 'CENTER',
      'space-between': 'SPACE_BETWEEN', 'space-around': 'SPACE_BETWEEN', 'space-evenly': 'SPACE_BETWEEN',
    };
    const amap = {
      stretch: 'MIN', normal: 'MIN', 'flex-start': 'MIN', start: 'MIN', 'self-start': 'MIN',
      'flex-end': 'MAX', end: 'MAX', 'self-end': 'MAX', center: 'CENTER', baseline: 'BASELINE',
    };
    let justify = jmap[st.justifyContent] || 'MIN';
    if (dir.indexOf('reverse') >= 0 && (justify === 'MIN' || justify === 'MAX')) {
      justify = justify === 'MIN' ? 'MAX' : 'MIN';
    }
    const align = amap[st.alignItems] || 'MIN';
    const stretchDefault = st.alignItems === 'stretch' || st.alignItems === 'normal';

    const bT = parseFloat(st.borderTopWidth) || 0;
    const bR = parseFloat(st.borderRightWidth) || 0;
    const bB = parseFloat(st.borderBottomWidth) || 0;
    const bL = parseFloat(st.borderLeftWidth) || 0;
    let padT = (parseFloat(st.paddingTop) || 0) + bT;
    let padR = (parseFloat(st.paddingRight) || 0) + bR;
    let padB = (parseFloat(st.paddingBottom) || 0) + bB;
    let padL = (parseFloat(st.paddingLeft) || 0) + bL;

    let gap = parseFloat(horiz ? st.columnGap : st.rowGap) || 0;
    const gapCross = parseFloat(horiz ? st.rowGap : st.columnGap) || 0;

    // Реальные промежутки точнее CSS gap (учитывают margin'ы детей)
    if (!wrap && gaps.length && justify !== 'SPACE_BETWEEN') {
      const sorted = gaps.slice().sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      if (sorted[0] >= med - 1.5 && sorted[sorted.length - 1] <= med + 1.5) {
        gap = Math.max(0, r2(med));
      }
    }
    // Реальный отступ по главной оси (учитывает margin первого/последнего)
    if (!wrap) {
      const firstK = flow[0];
      const lastK = flow[flow.length - 1];
      if (justify === 'MIN') {
        const m = horiz ? firstK.x - x : firstK.y - y;
        if (m >= 0 && m < (horiz ? w : h)) {
          if (horiz) padL = r2(m);
          else padT = r2(m);
        }
      } else if (justify === 'MAX') {
        const m = horiz ? x + w - (lastK.x + lastK.w) : y + h - (lastK.y + lastK.h);
        if (m >= 0 && m < (horiz ? w : h)) {
          if (horiz) padR = r2(m);
          else padB = r2(m);
        }
      }
    }

    return {
      layout: {
        mode: horiz ? 'H' : 'V',
        wrap,
        gap: r2(gap),
        gapCross: r2(gapCross),
        padT: r2(padT), padR: r2(padR), padB: r2(padB), padL: r2(padL),
        justify,
        align,
        stretchDefault,
      },
      orderedKids: flow.concat(absKids),
    };
  }

  function walk(el, depth, inFlex) {
    if (truncated || depth > MAX_DEPTH) return [];
    if (nodeCount > MAX_NODES) {
      truncated = true;
      return [];
    }
    const tag = (el.tagName || '').toUpperCase();
    if (SKIP_TAGS[tag]) return [];

    let st;
    try { st = getComputedStyle(el); } catch (e) { return []; }
    if (!st || st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return [];
    const op = parseFloat(st.opacity);
    if (op === 0) return [];

    const r = el.getBoundingClientRect();
    const x = r.left + window.scrollX;
    const y = r.top + window.scrollY;
    const w = r.width;
    const h = r.height;
    if (x + w < -8 || y + h < -8 || x > pageWidth + 8 || y > pageHeight + 8) return [];

    const pos = st.position;
    const abs = pos === 'absolute' || pos === 'fixed';

    if (tag === 'SVG') {
      const sv = serializeSvg(el, st, w, h);
      if (sv && w > 0.5 && h > 0.5) {
        nodeCount++;
        return [{
          t: 'svg', name: nodeName(el, tag), x, y, w, h,
          opacity: op, zi: ziOf(st), svg: sv,
          abs: abs || undefined,
        }];
      }
      return [];
    }

    const fills = backgroundFills(st);
    const stroke = borderInfo(st);
    const shadows = parseShadows(st.boxShadow);
    const rad = radii(st, w, h);
    const clip = /(hidden|clip|auto|scroll)/.test((st.overflowX || '') + ' ' + (st.overflowY || ''));
    const isFlex = /(inline-)?flex/.test(st.display || '');

    let leaf = false;
    let placeholder = false;

    if (tag === 'IMG') {
      leaf = true;
      const ref = refImage(el.currentSrc || el.src);
      if (ref) {
        const fit = st.objectFit || 'fill';
        fills.push({ type: 'image', ref, mode: fit === 'contain' || fit === 'scale-down' ? 'FIT' : 'FILL' });
      } else placeholder = true;
    } else if (tag === 'VIDEO') {
      leaf = true;
      const ref = el.poster ? refImage(el.poster) : null;
      if (ref) fills.push({ type: 'image', ref, mode: 'FILL' });
      else fills.push({ type: 'solid', color: { r: 0.08, g: 0.08, b: 0.1, a: 1 } });
    } else if (tag === 'CANVAS') {
      leaf = true;
      try {
        const dataUrl = el.toDataURL('image/png');
        const ref = refImage(dataUrl);
        if (ref) fills.push({ type: 'image', ref, mode: 'FILL' });
      } catch (e) {
        placeholder = true;
      }
    } else if (tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') {
      leaf = true;
      placeholder = true;
    }

    let kids = [];
    if (!leaf) {
      const sourceNodes = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
      for (const child of sourceNodes) {
        if (truncated) break;
        if (child.nodeType === 3) {
          const k = textKid(child, st);
          if (k) kids.push(k);
        } else if (child.nodeType === 1) {
          const ctag = (child.tagName || '').toUpperCase();
          if (ctag === 'SLOT' && child.assignedNodes) {
            let assigned = [];
            try { assigned = child.assignedNodes({ flatten: true }); } catch (e) {}
            if (!assigned.length) assigned = Array.from(child.childNodes);
            for (const an of assigned) {
              if (an.nodeType === 1) kids.push(...walk(an, depth + 1, isFlex));
              else if (an.nodeType === 3) {
                const k = textKid(an, st);
                if (k) kids.push(k);
              }
            }
          } else {
            kids.push(...walk(child, depth + 1, isFlex));
          }
        }
        if (nodeCount > MAX_NODES) {
          truncated = true;
          break;
        }
      }

      // синтетический текст для полей ввода
      if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && w > 8 && h > 8) {
        let val = '';
        if (tag === 'SELECT') {
          const o = el.selectedOptions && el.selectedOptions[0];
          val = o ? o.textContent : '';
        } else {
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (type !== 'password') val = el.value || el.getAttribute('placeholder') || '';
        }
        val = (val || '').replace(/\s+/g, ' ').trim();
        if (val && !kids.some((k) => k.t === 'text')) {
          const padL = (parseFloat(st.paddingLeft) || 0) + (parseFloat(st.borderLeftWidth) || 0);
          const size = parseFloat(st.fontSize) || 14;
          nodeCount++;
          kids.push({
            t: 'text', name: val.slice(0, 24),
            x: x + padL + 1, y: y + h / 2 - size * 0.72,
            w: Math.max(w - padL * 2, 12), h: size * 1.45,
            zi: 0, text: textStyleOf(st, val),
          });
        }
      }
    }

    // псевдоэлементы: фоновые картинки и одиночные символы-иконки
    const pk = pseudoKids(el, x, y, w, h, kids.length > 0 || leaf);
    for (const pf of pk.fills) fills.push(pf);
    for (const pt of pk.texts) kids.push(pt);

    // Auto Layout для flex-контейнеров
    let layout = null;
    if (!leaf && isFlex && kids.length >= 2 && w >= 0.5 && h >= 0.5) {
      const res = computeFlexLayout(st, x, y, w, h, kids);
      if (res) {
        layout = res.layout;
        kids = res.orderedKids;
      }
    }
    if (!layout) {
      kids.sort((a, b) => (a.zi || 0) - (b.zi || 0));
    }

    const visible = fills.length > 0 || !!stroke || shadows.length > 0 || placeholder;
    const emit =
      leaf ||
      visible ||
      !!layout ||
      (clip && kids.length > 0) ||
      (op < 1 && kids.length > 0) ||
      (inFlex && !abs && kids.length > 0); // flex-элементы не схлопываем — иначе сломается раскладка родителя
    if (!emit || w < 0.5 || h < 0.5) return kids;

    nodeCount++;
    return [{
      t: 'el',
      name: nodeName(el, tag),
      x, y, w, h,
      fills,
      stroke,
      shadows,
      radius: rad,
      clip,
      opacity: op,
      zi: ziOf(st),
      abs: abs || undefined,
      grow: parseFloat(st.flexGrow) > 0 ? 1 : undefined,
      stretchSelf: st.alignSelf === 'stretch' || undefined,
      placeholder: placeholder || undefined,
      layout,
      children: kids,
    }];
  }

  // ждём шрифты (с таймаутом)
  try {
    if (doc.fonts && doc.fonts.ready) {
      await Promise.race([doc.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
    }
  } catch (e) {}

  const bodyKids = doc.body ? walk(doc.body, 0, false) : [];

  let rootBg = null;
  try {
    rootBg = parseColor(getComputedStyle(doc.body).backgroundColor);
    if (!rootBg || rootBg.a === 0) rootBg = parseColor(getComputedStyle(doc.documentElement).backgroundColor);
  } catch (e) {}
  if (!rootBg || rootBg.a === 0) rootBg = { r: 1, g: 1, b: 1, a: 1 };

  const root = {
    t: 'el',
    name: (doc.title || location.hostname || 'page').slice(0, 60),
    x: 0, y: 0, w: pageWidth, h: pageHeight,
    fills: [{ type: 'solid', color: rootBg }],
    stroke: null, shadows: [], radius: [0, 0, 0, 0],
    clip: true, opacity: 1, zi: 0,
    layout: null,
    children: bodyKids,
  };

  // Какие шрифты реально грузит сайт — семейство + имена файлов, чтобы человек
  // при желании скачал и поставил их себе сам (плагин сам ничего не ставит).
  function collectFonts() {
    const byFam = new Map(); // lowerFamily -> { family, files:Set, embedded, loaded }
    const ensure = (family) => {
      const disp = String(family || '').replace(/^["']|["']$/g, '').trim();
      if (!disp) return null;
      const k = disp.toLowerCase();
      let e = byFam.get(k);
      if (!e) { e = { family: disp, files: new Set(), embedded: false, loaded: false }; byFam.set(k, e); }
      return e;
    };

    // 1) @font-face из доступных таблиц стилей — даёт семейство и имена файлов
    let sheets = [];
    try { sheets = Array.from(doc.styleSheets); } catch (e) {}
    for (const sheet of sheets) {
      let rules = null;
      try { rules = sheet.cssRules; } catch (e) { rules = null; } // cross-origin CSS недоступен
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const isFF = (typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule) || rule.type === 5;
        if (!isFF || !rule.style) continue;
        const e = ensure(rule.style.getPropertyValue('font-family'));
        if (!e) continue;
        const src = rule.style.getPropertyValue('src') || '';
        const re = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g;
        let m;
        while ((m = re.exec(src))) {
          const u = m[2];
          if (/^data:/i.test(u)) { e.embedded = true; continue; } // встроен base64 — файла нет
          let file = '';
          try {
            const abs = new URL(u, sheet.href || location.href);
            file = decodeURIComponent((abs.pathname.split('/').pop() || '').trim());
          } catch (err) {
            file = (u.split('?')[0].split('#')[0].split('/').pop() || '').trim();
          }
          if (file) e.files.add(file);
        }
      }
    }

    // 2) FontFaceSet — реально загруженные семейства (ловит и cross-origin, где файл не виден)
    try {
      if (doc.fonts && typeof doc.fonts.forEach === 'function') {
        doc.fonts.forEach((ff) => {
          if (ff && ff.status === 'loaded') { const e = ensure(ff.family); if (e) e.loaded = true; }
        });
      }
    } catch (e) {}

    // Оставляем только шрифты, что реально используются на странице
    const all = Array.from(byFam.values());
    let list = all.filter((e) => e.loaded || usedFamilies.has(e.family.toLowerCase()));
    if (!list.length) list = all;
    return list.map((e) => ({
      family: e.family,
      files: Array.from(e.files).slice(0, 8),
      embedded: e.embedded,
    })).slice(0, 24);
  }

  let fonts = [];
  try { fonts = collectFonts(); } catch (e) { fonts = []; }

  return {
    root,
    pageWidth,
    pageHeight,
    images,
    fonts,
    truncated,
    nodeCount,
    title: doc.title || location.hostname,
    url: location.href,
  };
};
