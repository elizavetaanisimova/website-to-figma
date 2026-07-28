'use strict';
// Рендер SVG-ассетов в PNG для карточки Figma Community.
// Запуск: node tools/render-assets.js (из корня figma-site-importer)

const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'server', 'node_modules', 'playwright'));

const ASSETS = [
  ['icon.svg', 'icon.png', 128, 128],
  ['cover.svg', 'cover.png', 1920, 1080],
];

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }).catch(() => chromium.launch({ headless: true }));
  for (const [src, out, w, h] of ASSETS) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.goto('file://' + path.join(__dirname, '..', 'assets', src));
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(__dirname, '..', 'assets', out),
      clip: { x: 0, y: 0, width: w, height: h },
      type: 'png',
    });
    await page.close();
    console.log('готово:', out, w + 'x' + h);
  }
  await browser.close();
})();
