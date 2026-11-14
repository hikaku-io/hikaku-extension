// Generates the images the stores ask for, using the real extension on the demo
// feed (synthetic images with demo Content Credentials, so no third-party content).
//
//   store/assets/screenshot-1..5.png   1280x800  (Chrome Web Store and AMO screenshots)
//   store/assets/promo-small.png       440x280   (Chrome "small promo tile", required)
//   store/assets/promo-marquee.png     1400x560  (Chrome "marquee", optional)
//   store/assets/icon-128.png          128x128   (store icon)
//
// Usage: npm run build && node scripts/store-assets.mjs
import puppeteer from 'puppeteer';
import http from 'node:http';
import { mkdirSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveFeed } from './lib/mock-feed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(ROOT, 'dist');
const EXT = process.env.EXT_DIR || join(dist, readdirSync(dist).filter((d) => /^hikaku-[\d.]+$/.test(d)).sort().at(-1));
const OUT = join(ROOT, 'store', 'assets');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logoSvg = readFileSync(join(ROOT, 'icons', 'logo.svg'), 'utf8');
const logo = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`;
const png = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

const feed = await serveFeed(http);
const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(sw.url()).host;
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${extId}/popup/popup.html`);
  await ext.evaluate(() => chrome.storage.local.set({ uiScheme: 'light' }));
  // Load the model first, so the popup screenshot says "Ready" instead of "Downloading".
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'modelWarmup' }));

  const tab = await browser.newPage();
  await tab.setViewport({ width: 1280, height: 800 });
  await tab.goto(feed.base, { waitUntil: 'load' });
  const flagged = async () => ext.evaluate(async (u) => {
    const [t] = await chrome.tabs.query({ url: u + '/*' });
    return (await chrome.tabs.sendMessage(t.id, { type: 'stats' }, { frameId: 0 }).catch(() => null))?.flagged || 0;
  }, feed.base);
  for (let i = 0; i < 40 && (await flagged()) < 2; i++) { await tab.bringToFront(); await sleep(300); }
  await tab.bringToFront();
  await tab.evaluate(() => scrollTo(0, 40));
  await sleep(500);
  const img = await tab.$eval('img', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });

  // 1. Hover card
  await tab.mouse.move(img.x + img.w * 0.6, img.y + img.h * 0.55);
  await sleep(900);
  await tab.screenshot({ path: join(OUT, 'screenshot-1.png') });
  // 2. Details panel
  await tab.mouse.move(img.x + 16, img.y + 12);
  await tab.mouse.click(img.x + 16, img.y + 12);
  await sleep(700);
  await tab.screenshot({ path: join(OUT, 'screenshot-2.png') });
  await tab.keyboard.press('Escape');
  // 3. AI-edited image (double outline)
  await tab.mouse.move(5, 5);
  await tab.evaluate(() => scrollTo(0, 820));
  await sleep(500);
  const img2 = await tab.$$eval('img', (els) => { const r = els[1].getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await tab.mouse.move(img2.x + img2.w * 0.55, Math.min(700, img2.y + img2.h * 0.45));
  await sleep(900);
  await tab.screenshot({ path: join(OUT, 'screenshot-3.png') });

  // 4. Settings popup over the page
  await tab.mouse.move(5, 5);
  await tab.evaluate(() => scrollTo(0, 40));
  await sleep(400);
  const bg = await tab.screenshot();
  const pop = await browser.newPage();
  await pop.setViewport({ width: 340, height: 640, deviceScaleFactor: 1 });
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(700);
  await pop.evaluate(() => { document.getElementById('pageStats').textContent = '2 flagged · 2 checked on this page'; });
  const popShot = await pop.screenshot({ fullPage: true });

  // 5. Dot style + dark theme
  await ext.evaluate(() => chrome.storage.sync.set({ style: 'dot', theme: 'dark' }));
  await tab.bringToFront();
  await sleep(700);
  await tab.mouse.move(img.x + img.w * 0.6, img.y + img.h * 0.55);
  await sleep(900);
  await tab.screenshot({ path: join(OUT, 'screenshot-5.png') });
  await ext.evaluate(() => chrome.storage.sync.set({ style: 'border', theme: 'auto' }));

  // Compose the popup shot and the promo tiles as small HTML pages.
  const page = await browser.newPage();
  const render = async (w, h, html, file) => {
    await page.setViewport({ width: w, height: h });
    await page.setContent(`<!doctype html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:system-ui,'Segoe UI',sans-serif">${html}</body>`);
    await sleep(200);
    await page.screenshot({ path: join(OUT, file) });
  };
  await render(1280, 800, `
    <img src="${png(bg)}" style="position:absolute;inset:0;filter:brightness(.62)">
    <div style="position:absolute;right:40px;top:28px;width:340px;border-radius:4px;overflow:hidden;border:1px solid #d8dee4;box-shadow:0 3px 12px rgba(0,0,0,.16)"><img src="${png(popShot)}" style="display:block;width:340px"></div>`, 'screenshot-4.png');
  const brand = (size, sub) => `
    <div style="position:absolute;inset:0;background:#f6f8fa;color:#24292f;display:flex;align-items:center;justify-content:center;gap:${size * 0.5}px">
      <img src="${logo}" style="width:${size * 1.6}px;height:${size * 1.6}px">
      <div><div style="font-weight:650;font-size:${size}px;letter-spacing:-.02em">Hikaku</div>
      <div style="font-size:${size * 0.36}px;opacity:.82;margin-top:${size * 0.12}px">${sub}</div></div>
    </div>`;
  await render(440, 280, brand(48, 'Check for AI images as you browse.'), 'promo-small.png');
  await render(1400, 560, brand(96, 'Check for AI images as you browse.'), 'promo-marquee.png');
  // Social share image for hikaku.io (Open Graph / Twitter card size).
  const shot1 = readFileSync(join(OUT, 'screenshot-1.png'));
  await render(1200, 630, `
    <div style="position:absolute;inset:0;background:#f6f8fa"></div>
    <div style="position:absolute;left:64px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center;color:#24292f">
      <div style="display:flex;align-items:center;gap:16px"><img src="${logo}" style="width:64px;height:64px"><span style="font-weight:650;font-size:44px;letter-spacing:-.02em">Hikaku</span></div>
      <div style="font-weight:700;font-size:46px;line-height:1.1;letter-spacing:-.02em;margin-top:30px">Check for AI images as you browse.</div>
      <div style="font-size:22px;opacity:.8;margin-top:20px;line-height:1.4">Free, open-source extension for Chrome, Edge and Firefox. Runs on your device.</div>
    </div>
    <div style="position:absolute;left:580px;top:70px;width:760px;height:490px;border-radius:4px;overflow:hidden;border:1px solid #d8dee4">
      <img src="${png(shot1)}" style="width:760px;display:block;margin-top:-20px;margin-left:-110px;transform:scale(1.18);transform-origin:top left"></div>`, 'og-1200x630.png');
  copyFileSync(join(ROOT, 'icons', 'icon128.png'), join(OUT, 'icon-128.png'));
  console.log(`✓ store assets → ${OUT}`);
} finally {
  await browser.close();
  feed.close();
}
