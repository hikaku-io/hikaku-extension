// Records a short demo video of the real extension.
//
// 1. Record: drive the extension on the demo feed (smooth mouse moves, a click,
//    a scroll, the popup) while Chrome streams screen frames to us.
// 2. Compose: a page replays those frames on a canvas with title and end cards,
//    crossfades between scenes, a drawn cursor with click ripples and captions,
//    and records the canvas with MediaRecorder. No ffmpeg needed.
//
// Usage: npm run build && node scripts/demo-video.mjs [outDir=docs]
// Output: hikaku-demo.mp4 (or .webm if this Chrome can't encode MP4)
import puppeteer from 'puppeteer';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveFeed } from './lib/mock-feed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(ROOT, 'dist');
const EXT = process.env.EXT_DIR || join(dist, readdirSync(dist).filter((d) => /^hikaku-[\d.]+$/.test(d)).sort().at(-1));
const OUT = process.argv.slice(2).find((a) => !a.startsWith('--')) || join(ROOT, 'docs');
// --live=<url> adds a scene on a real website (e.g. a listings page). Real sites
// block headless browsers, so this mode opens a visible Chrome window. Only use
// it for internal demos unless you have the site's and the listing owners' OK.
const LIVE = process.argv.find((a) => a.startsWith('--live='))?.slice(7) || null;
// --pick=<text>: feature the flagged photo whose URL contains this text. Review
// what gets flagged first and pick one you're confident about.
const PICK = process.argv.find((a) => a.startsWith('--pick='))?.slice(7) || null;
const WORK = join(OUT, '.demo-frames');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const W = 1280, H = 720;
const POPUP = { w: 340, h: 600 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// ------------------------------------------------------------ timeline
// Everything is stamped against one clock so the composer can replay it.
// Reset to zero right before the title card, so browser start-up and model
// loading never show up as dead time in the video.
let T0 = Date.now();
const now = () => Date.now() - T0;
const timeline = { frames: [], cursor: [], clicks: [], segments: [] };
let frameNo = 0;

function segment(kind, caption = '') {
  const prev = timeline.segments.at(-1);
  if (prev) prev.end = now();
  timeline.segments.push({ kind, caption, start: now(), end: null });
}

async function recordScreen(page, scene) {
  const client = await page.createCDPSession();
  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    const file = `f${String(frameNo++).padStart(5, '0')}.jpg`;
    writeFileSync(join(WORK, file), Buffer.from(data, 'base64'));
    timeline.frames.push({ scene, t: now(), file });
    client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const size = scene === 'popup' ? POPUP : { w: W, h: H };
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: size.w, maxHeight: size.h, everyNthFrame: 1 });
  return () => client.send('Page.stopScreencast').catch(() => {});
}

// Smooth, eased mouse glide that also logs the cursor path for the composer.
const pos = { feed: { x: W * 0.8, y: H * 0.85 }, live: { x: W * 0.5, y: H * 0.8 }, popup: { x: POPUP.w / 2, y: POPUP.h - 40 } };
async function glide(page, scene, x, y, ms = 900) {
  const from = { ...pos[scene] };
  const steps = Math.max(10, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const k = ease(i / steps);
    const px = from.x + (x - from.x) * k, py = from.y + (y - from.y) * k;
    await page.mouse.move(px, py);
    timeline.cursor.push({ scene, t: now(), x: px, y: py });
    await sleep(ms / steps);
  }
  pos[scene] = { x, y };
}
async function click(page, scene) {
  timeline.clicks.push({ scene, t: now(), ...pos[scene] });
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}
async function smoothScroll(page, dy, ms = 1400) {
  const steps = Math.round(ms / 16);
  let done = 0;
  for (let i = 1; i <= steps; i++) {
    const target = Math.round(dy * ease(i / steps));
    await page.evaluate((d) => scrollBy(0, d), target - done);
    done = target;
    await sleep(16);
  }
}

// ------------------------------------------------------------ 1. record
const feedServer = await serveFeed(http);
const browser = await puppeteer.launch({
  headless: !LIVE,
  defaultViewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu', `--window-size=${W},${H + 140}`],
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(sw.url()).host;
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${extId}/popup/popup.html`);
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'modelWarmup' }));
  await ext.evaluate(() => chrome.storage.local.set({ uiScheme: 'light' }));

  const feed = await browser.newPage();
  await feed.setViewport({ width: W, height: H });
  const popup = await browser.newPage();
  await popup.setViewport({ width: POPUP.w, height: POPUP.h });

  T0 = Date.now();
  segment('title');
  await sleep(2600);

  // Scene: the feed loads and Hikaku outlines the AI images.
  await feed.bringToFront();
  const stopFeed = await recordScreen(feed, 'feed');
  segment('feed', 'Hikaku checks images as you browse');
  await feed.goto(feedServer.base, { waitUntil: 'load' });
  await feed.evaluate(() => scrollTo(0, 30));
  for (let i = 0; i < 40; i++) {
    const s = await ext.evaluate(async (u) => {
      const [t] = await chrome.tabs.query({ url: u + '/*' });
      return chrome.tabs.sendMessage(t.id, { type: 'stats' }, { frameId: 0 }).catch(() => null);
    }, feedServer.base);
    if (s?.flagged >= 2) break;
    await feed.bringToFront();
    await sleep(250);
  }
  await sleep(1600);

  const img = await feed.$eval('img', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  segment('feed', 'Hover for a quick summary');
  await glide(feed, 'feed', img.x + img.w * 0.58, img.y + img.h * 0.55, 1100);
  await sleep(2200);

  segment('feed', 'Click the tag to see the evidence');
  await glide(feed, 'feed', img.x + 16, img.y + 12, 800);
  await sleep(300);
  await click(feed, 'feed');
  await sleep(3000);
  await feed.keyboard.press('Escape');
  await sleep(500);

  segment('feed', 'AI edits get a double outline');
  await glide(feed, 'feed', W * 0.82, H * 0.6, 600);
  await smoothScroll(feed, 760, 1600);
  const img2 = await feed.$$eval('img', (els) => { const r = els[1].getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await glide(feed, 'feed', img2.x + img2.w * 0.5, Math.min(H - 80, img2.y + img2.h * 0.4), 1000);
  await sleep(2200);
  await stopFeed();

  // Scene (optional): a real website, e.g. a listings page.
  if (LIVE) {
    const live = await browser.newPage();
    await live.setViewport({ width: W, height: H });
    await live.bringToFront();
    // Load before recording so the video never shows a blank, half-loaded page.
    await live.goto(LIVE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    // Close cookie banners, promo bubbles and sign-in prompts so they don't cover
    // the listings. We prefer "close" and "decline" buttons and never accept
    // tracking cookies on the viewer's behalf.
    const dismissed = [];
    for (let round = 0; round < 3; round++) {
      const hit = await live.evaluate(() => {
        const CLOSE = /^(close|dismiss|no,? thanks|not now|maybe later|skip|reject( all)?|decline( all)?|only necessary|necessary only|×|✕|x)$/i;
        const isOverlay = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'fixed' || pos === 'sticky' || p.getAttribute('role') === 'dialog' || /cookie|consent|banner|modal|popover|tooltip|toast/i.test(p.className + ' ' + p.id)) return true; } return false; };
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        for (const el of document.querySelectorAll('button, [role="button"], a')) {
          const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
          if (!label || label.length > 30 || !CLOSE.test(label) || !visible(el) || !isOverlay(el)) continue;
          el.click();
          return label;
        }
        return null;
      });
      if (!hit) break;
      dismissed.push(hit);
      await sleep(600);
    }
    await live.keyboard.press('Escape');
    console.log(`live site: closed ${dismissed.length ? dismissed.join(', ') : 'nothing'}`);
    if (process.env.DEMO_CHECK) await live.screenshot({ path: join(OUT, 'live-check.png') });
    const host = new URL(LIVE).hostname;
    const stats = () => ext.evaluate(async (h) => {
      const [t] = await chrome.tabs.query({ url: `*://${h}/*` });
      return t ? chrome.tabs.sendMessage(t.id, { type: 'stats' }, { frameId: 0 }).catch(() => null) : null;
    }, host);
    // Listing sites often scroll a results panel, not the page, so scroll the
    // photo itself into view (that moves whichever container holds it).
    const centerOn = (match) => live.evaluate((m) => {
      const el = [...document.images].find((im) => (im.currentSrc || im.src).includes(m));
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    }, match);
    const rectOf = (match) => live.evaluate((m) => {
      const el = [...document.images].find((im) => (im.currentSrc || im.src).includes(m));
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }, match);

    const stopLive = await recordScreen(live, 'live');
    segment('live', 'It works on real sites too, like home listings');
    await sleep(1800);

    // With --pick, find that photo (scrolling the results if needed), bring it
    // into view so Hikaku checks it, then wait for the flag.
    if (PICK) {
      let found = await centerOn(PICK);
      for (let i = 0; i < 14 && !found; i++) {
        await live.evaluate(() => {
          const sc = [...document.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.clientHeight > 300);
          (sc || document.scrollingElement).scrollBy({ top: 600, behavior: 'smooth' });
        });
        await sleep(900);
        found = await centerOn(PICK);
      }
      if (!found) console.log(`live site: no photo matching "${PICK}" on the page`);
      await sleep(1300);
    }
    let flaggedUrl = null;
    for (let i = 0; i < 40 && !flaggedUrl; i++) {
      await live.bringToFront();
      await sleep(500);
      const items = (await stats())?.flaggedItems || [];
      flaggedUrl = (PICK ? items.find((it) => it.url?.includes(PICK)) : items[0])?.url || null;
    }
    console.log(`live site: featuring ${flaggedUrl || '(nothing flagged)'}`);
    if (flaggedUrl) {
      await centerOn(flaggedUrl);
      await sleep(1200);
      const r = await rectOf(flaggedUrl);
      console.log(`live site: photo on screen at ${JSON.stringify(r)}`);
      segment('live', 'Flags listing photos that look AI-enhanced');
      await glide(live, 'live', r.x + r.w * 0.55, r.y + r.h * 0.6, 1100);
      await sleep(2000);
      await glide(live, 'live', r.x + 16, r.y + 12, 700);
      await sleep(250);
      await click(live, 'live');
      await sleep(3200);
      await live.keyboard.press('Escape');
      await sleep(500);
    } else {
      console.log('live site: nothing was flagged, scene kept short');
      await sleep(1500);
    }
    await stopLive();
  }

  // Scene: settings popup. Switch to the dot style and dark theme.
  await popup.bringToFront();
  const stopPopup = await recordScreen(popup, 'popup');
  segment('popup', 'Border or dot, light or dark. Your call.');
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(1200);
  const dot = await popup.$eval('input[name="style"][value="dot"]', (el) => { const r = el.closest('label').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await glide(popup, 'popup', dot.x, dot.y, 900);
  await click(popup, 'popup');
  await sleep(900);
  const dark = await popup.$eval('input[name="theme"][value="dark"]', (el) => { const r = el.closest('label').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await glide(popup, 'popup', dark.x, dark.y, 900);
  await click(popup, 'popup');
  await sleep(1600);
  await stopPopup();

  // Scene: back on the page, now with dots and the dark card.
  await feed.bringToFront();
  await feed.evaluate(() => scrollTo(0, 30));
  const stopFeed2 = await recordScreen(feed, 'feed');
  segment('feed', 'Everything runs on your device');
  await sleep(700);
  const r1 = await feed.$eval('img', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  pos.feed = { x: W * 0.8, y: H * 0.7 };
  await glide(feed, 'feed', r1.x + r1.w - 12, r1.y + 12, 1000);
  await sleep(2400);
  await stopFeed2();

  segment('end');
  await sleep(3200);
  timeline.segments.at(-1).end = now();
} finally {
  await browser.close();
  feedServer.close();
}
console.log(`recorded ${timeline.frames.length} frames over ${(now() / 1000).toFixed(1)} s`);

// ------------------------------------------------------------ 2. compose
const logo = readFileSync(join(ROOT, 'icons', 'logo.svg'), 'utf8');
writeFileSync(join(WORK, 'timeline.json'), JSON.stringify(timeline));

const composer = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
const W = ${W}, H = ${H}, POPUP = ${JSON.stringify(POPUP)}, FPS = 30, FADE = 550;
const tl = await (await fetch('/timeline.json')).json();
const logo = new Image(); logo.src = 'data:image/svg+xml;base64,' + btoa(${JSON.stringify(logo)}); await logo.decode();
const imgs = new Map();
await Promise.all(tl.frames.map(async (f) => { const i = new Image(); i.src = '/frames/' + f.file; await i.decode(); imgs.set(f.file, i); }));
const c = document.getElementById('c'), x = c.getContext('2d');
const total = tl.segments.at(-1).end;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

const frameAt = (scene, t) => { let best = null; for (const f of tl.frames) { if (f.scene !== scene) continue; if (f.t <= t) best = f; else break; } return best ? imgs.get(best.file) : (tl.frames.find((f) => f.scene === scene) && imgs.get(tl.frames.find((f) => f.scene === scene).file)); };
const lastFeedBefore = (t) => { let best = null; for (const f of tl.frames) if (f.scene === 'feed' && f.t <= t) best = f; return best && imgs.get(best.file); };
const cursorAt = (scene, t) => { let best = null; for (const p of tl.cursor) { if (p.scene !== scene) continue; if (p.t <= t) best = p; else break; } return best; };
const popupBox = () => ({ x: W - POPUP.w * 0.9 - 36, y: 40, s: 0.9 });

function roundRect(px, py, w, h, r) { x.beginPath(); x.roundRect(px, py, w, h, r); }
function drawCursor(px, py) {
  x.save(); x.translate(px, py); x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = 6; x.shadowOffsetY = 2;
  x.beginPath(); x.moveTo(0, 0); x.lineTo(0, 21); x.lineTo(5.5, 16); x.lineTo(9.5, 25); x.lineTo(13, 23.5); x.lineTo(9, 15); x.lineTo(16, 15); x.closePath();
  x.fillStyle = '#fff'; x.fill(); x.shadowColor = 'transparent'; x.lineWidth = 1.4; x.strokeStyle = '#111'; x.stroke(); x.restore();
}
function drawRipples(scene, t, map) {
  for (const k of tl.clicks) {
    if (k.scene !== scene) continue;
    const dt = t - k.t; if (dt < 0 || dt > 600) continue;
    const p = map(k.x, k.y), a = 1 - dt / 600;
    x.beginPath(); x.arc(p.x, p.y, 8 + dt / 18, 0, Math.PI * 2); x.strokeStyle = 'rgba(124,58,237,' + a + ')'; x.lineWidth = 3; x.stroke();
  }
}
function card(title, sub, foot) {
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0f0b1f'); g.addColorStop(1, '#2a1260');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.drawImage(logo, W / 2 - 44, H / 2 - 150, 88, 88);
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.font = '700 60px system-ui, Segoe UI, sans-serif'; x.fillText(title, W / 2, H / 2 + 20);
  x.fillStyle = 'rgba(255,255,255,.75)'; x.font = '400 26px system-ui, Segoe UI, sans-serif'; x.fillText(sub, W / 2, H / 2 + 70);
  if (foot) { x.fillStyle = '#c4b5fd'; x.font = '600 22px system-ui, Segoe UI, sans-serif'; x.fillText(foot, W / 2, H / 2 + 130); }
}
function caption(text, alpha) {
  if (!text || alpha <= 0) return;
  x.save(); x.globalAlpha = alpha; x.font = '600 22px system-ui, Segoe UI, sans-serif';
  const w = x.measureText(text).width + 44, px = 40, py = H - 86;
  x.fillStyle = 'rgba(17,17,24,.82)'; roundRect(px, py, w, 50, 25); x.fill();
  x.fillStyle = '#a78bfa'; x.beginPath(); x.arc(px + 22, py + 25, 5, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fff'; x.textAlign = 'left'; x.fillText(text, px + 36, py + 33); x.restore();
}
function drawSegment(s, t) {
  if (s.kind === 'title') return card('Hikaku', 'Seeing is believing. Check anyway.');
  if (s.kind === 'end') return card('Hikaku', 'Free, open source, and private.', 'hikaku.io');
  if (s.kind === 'feed' || s.kind === 'live') {
    const sc = s.kind;
    const f = frameAt(sc, t); if (f) x.drawImage(f, 0, 0, W, H); else { x.fillStyle = '#f4f4f5'; x.fillRect(0, 0, W, H); }
    const p = cursorAt(sc, t); drawRipples(sc, t, (a, b) => ({ x: a, y: b })); if (p) drawCursor(p.x, p.y);
    return;
  }
  if (s.kind === 'popup') {
    const bg = lastFeedBefore(s.start); if (bg) x.drawImage(bg, 0, 0, W, H);
    const k = ease(clamp((t - s.start) / 450));
    x.fillStyle = 'rgba(10,10,14,' + 0.35 * k + ')'; x.fillRect(0, 0, W, H);
    const b = popupBox(); const f = frameAt('popup', t);
    x.save(); x.globalAlpha = k; x.translate(0, (1 - k) * -18);
    x.shadowColor = 'rgba(0,0,0,.4)'; x.shadowBlur = 40; x.shadowOffsetY = 12;
    roundRect(b.x, b.y, POPUP.w * b.s, POPUP.h * b.s, 14); x.fillStyle = '#fff'; x.fill(); x.shadowColor = 'transparent';
    x.save(); roundRect(b.x, b.y, POPUP.w * b.s, POPUP.h * b.s, 14); x.clip(); if (f) x.drawImage(f, b.x, b.y, POPUP.w * b.s, POPUP.h * b.s); x.restore();
    const map = (a, c2) => ({ x: b.x + a * b.s, y: b.y + c2 * b.s });
    drawRipples('popup', t, map); const p = cursorAt('popup', t); if (p) { const q = map(p.x, p.y); drawCursor(q.x, q.y); }
    x.restore();
  }
}
function render(t) {
  const i = tl.segments.findIndex((s) => t >= s.start && t < s.end);
  const s = tl.segments[Math.max(0, i)];
  drawSegment(s, t);
  // Crossfade into each segment whose look differs from the one before it.
  const prev = tl.segments[i - 1];
  if (prev && prev.kind !== s.kind && t - s.start < FADE) {
    x.save(); x.globalAlpha = 1 - ease((t - s.start) / FADE); drawSegment(prev, prev.end - 1); x.restore();
  }
  // Captions fade in, hold, and fade out with their segment.
  const a = Math.min(clamp((t - s.start - 200) / 350), clamp((s.end - t) / 300));
  caption(s.caption, a);
}

const types = ['video/mp4;codecs=avc1.4d0028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
const mime = types.find((m) => MediaRecorder.isTypeSupported(m));
const stream = c.captureStream(FPS);
const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
render(0); rec.start(500);
const start = performance.now();
await new Promise((done) => { (function tick() { const t = performance.now() - start; if (t >= total) return done(); render(t); setTimeout(tick, 1000 / FPS / 2); })(); });
rec.stop(); await new Promise((r) => (rec.onstop = r));
await fetch('/upload?type=' + encodeURIComponent(mime), { method: 'POST', body: new Blob(chunks, { type: mime }) });
document.title = 'done';
</script>`;

let outFile = null;
const comp = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(composer); }
  if (req.url === '/timeline.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(readFileSync(join(WORK, 'timeline.json'))); }
  const m = req.url.match(/^\/frames\/(f\d+\.jpg)$/);
  if (m) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(readFileSync(join(WORK, m[1]))); }
  if (req.url.startsWith('/upload')) {
    const type = decodeURIComponent(req.url.split('type=')[1] || '');
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      outFile = join(OUT, `hikaku-demo.${type.includes('mp4') ? 'mp4' : 'webm'}`);
      writeFileSync(outFile, Buffer.concat(parts));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => comp.listen(0, '127.0.0.1', r));
const cb = await puppeteer.launch({ headless: true });
try {
  const p = await cb.newPage();
  await p.setViewport({ width: W, height: H });
  await p.goto(`http://127.0.0.1:${comp.address().port}/`);
  await p.waitForFunction(() => document.title === 'done', { timeout: 300000, polling: 1000 });
} finally {
  await cb.close();
  comp.close();
}
rmSync(WORK, { recursive: true, force: true });
console.log(`✓ ${outFile}`);
