// Generates marketing/README screenshots with the real extension running on a
// mock feed. Images are procedurally generated and carry *demo* Content
// Credentials ("Example Image Model"), so there are no third-party rights issues.
//
// Usage: node scripts/screenshots.mjs [outDir=docs/images]
//   Website: node scripts/screenshots.mjs ../hikaku-site/public/assets/screens
import puppeteer from 'puppeteer';
import http from 'node:http';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveFeed } from './lib/mock-feed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = process.env.EXT_DIR || ROOT;
const OUT = process.argv[2] || join(ROOT, 'docs', 'images');
mkdirSync(OUT, { recursive: true });

const { base, close } = await serveFeed(http);
const server = { close };

// ------------------------------------------------------------ capture

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu'] });
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(sw.url()).host;
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${extId}/popup/popup.html`);
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'modelWarmup' })); // so the popup shows "Ready"

  const tab = await browser.newPage();
  await tab.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
  await tab.goto(base, { waitUntil: 'load' });
  const stats = async () => ext.evaluate(async (u) => {
    const [t] = await chrome.tabs.query({ url: u + '/*' });
    return chrome.tabs.sendMessage(t.id, { type: 'stats' }, { frameId: 0 });
  }, base);
  let s;
  for (let i = 0; i < 30; i++) { await tab.bringToFront(); await sleep(500); s = await stats(); if (s?.flagged >= 2) break; }
  if (!(s?.flagged >= 2)) throw new Error(`expected 2 flagged, got ${JSON.stringify(s)}`);

  await tab.bringToFront();
  await tab.evaluate(() => scrollTo(0, 40));
  await sleep(400);
  const r = await tab.$eval('img', (el) => { const b = el.getBoundingClientRect(); return { cx: b.left + b.width * 0.55, cy: b.top + b.height * 0.55, tx: b.left + 18, ty: b.top + 14 }; });
  await tab.mouse.move(r.cx, r.cy);
  await sleep(800);
  await tab.screenshot({ path: join(OUT, 'hover.png') });

  await tab.mouse.move(r.tx, r.ty);
  await tab.mouse.click(r.tx, r.ty);
  await sleep(500);
  await tab.screenshot({ path: join(OUT, 'panel.png') });
  await tab.keyboard.press('Escape');

  await ext.evaluate(() => chrome.storage.sync.set({ style: 'dot' }));
  await tab.bringToFront();
  await tab.mouse.move(5, 5);
  await sleep(800);
  await tab.screenshot({ path: join(OUT, 'dot.png') });
  await ext.evaluate(() => chrome.storage.sync.set({ style: 'border' }));

  const pop = await browser.newPage();
  await pop.setViewport({ width: 368, height: 560, deviceScaleFactor: 2 });
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(800);
  // Opened as a tab, the popup can't see the feed tab, so show the feed's real counts.
  await pop.evaluate((st) => { document.getElementById('pageStats').textContent = `${st.flagged} flagged · ${st.scanned} checked on this page`; }, s);
  await pop.screenshot({ path: join(OUT, 'popup.png'), fullPage: true });
  // WebP copies for the website: same pixels, a fraction of the size.
  const conv = await browser.newPage();
  for (const f of readdirSync(OUT).filter((n) => n.endsWith('.png'))) {
    const src = `data:image/png;base64,${readFileSync(join(OUT, f)).toString('base64')}`;
    const webp = await conv.evaluate(async (s) => {
      const img = new Image(); img.src = s; await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.86).split(',')[1];
    }, src);
    writeFileSync(join(OUT, f.replace(/\.png$/, '.webp')), Buffer.from(webp, 'base64'));
  }
  console.log(`✓ screenshots → ${OUT}`);
} finally {
  await browser.close();
  server.close();
}
