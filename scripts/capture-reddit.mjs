// Captures Hikaku on a Reddit feed (written for a photography subreddit such
// as r/EarthPorn): usernames swapped for generic ones, a feed screenshot, the
// details panel for one photo (opened the same way as right-click > Inspect for
// AI generation), and hover shots of anything flagged. Runs headless.
//
// Usage: EXT_DIR=dist/hikaku-x.y.z-offline OUT=<dir> [PICK=<url-substring>] //          node scripts/capture-reddit.mjs https://www.reddit.com/r/EarthPorn/
import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = process.env.OUT, EXT = process.env.EXT_DIR, URL_ = process.argv[2];
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ headless: true, defaultViewport: null, args: ['--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu', '--window-size=1400,1000'] });

// Page helpers, installed once per document.
const helpers = () => {
  window.__deep = (root, sel, out = []) => { for (const el of root.querySelectorAll('*')) { if (el.matches(sel)) out.push(el); if (el.shadowRoot) window.__deep(el.shadowRoot, sel, out); } return out; };
  window.__names = window.__names || new Map();
  const N = ['u/trail_notes', 'u/alpine_hours', 'u/coastline_cam', 'u/field_journal', 'u/north_light', 'u/quiet_ridge', 'u/wide_open', 'u/far_valley'];
  const fake = (s) => { if (!window.__names.has(s)) window.__names.set(s, N[window.__names.size % N.length]); return window.__names.get(s); };
  window.__anon = () => {
    const walk = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) { const t = n.nodeValue.trim(); if (/^u\/[\w-]{3,}$/.test(t) && !N.includes(t)) n.nodeValue = n.nodeValue.replace(t, fake(t)); } };
    walk(document.body);
    for (const h of window.__deep(document, '*')) if (h.shadowRoot) walk(h.shadowRoot);
    for (const el of window.__deep(document, '[author]')) { const a = el.getAttribute('author'); if (!N.includes('u/' + a)) el.setAttribute('author', fake('u/' + a).slice(2)); }
  };
  window.__img = (u) => window.__deep(document, 'img').find((x) => (x.currentSrc || x.src) === u);
};
try {
  const sw = await b.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(sw.url()).host;
  const ext = await b.newPage();
  await ext.goto(`chrome-extension://${extId}/popup/popup.html`);
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'modelWarmup' }));
  await ext.evaluate(() => chrome.storage.local.set({ uiScheme: 'light' }));
  const p = await b.newPage();
  await p.setViewport({ width: 1366, height: 900, deviceScaleFactor: 2 });
  await p.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);
  await p.evaluate(helpers);
  await p.screenshot({ path: `${OUT}/load.png` });
  // Cookie banner: reject optional cookies if offered; close login nags.
  await p.evaluate(() => { for (const el of window.__deep(document, 'button')) { const t = (el.textContent || el.getAttribute('aria-label') || '').trim(); if (/^(reject optional cookies|reject all|close|not now)$/i.test(t) && el.getBoundingClientRect().width) el.click(); } });
  await p.keyboard.press('Escape');
  await sleep(800);
  const anon = () => p.evaluate(() => window.__anon());
  await anon();
  const stats = () => ext.evaluate(async () => { const [t] = await chrome.tabs.query({ url: '*://www.reddit.com/*' }); return t ? chrome.tabs.sendMessage(t.id, { type: 'stats' }, { frameId: 0 }).catch(() => null) : null; });
  for (let i = 0; i < 10; i++) { await p.evaluate(() => scrollBy(0, 700)); await sleep(1500); await anon(); }
  await sleep(2500);
  const s = await stats();
  console.log(`scanned ${s?.scanned}, flagged ${s?.flagged}`);
  for (const it of s?.flaggedItems || []) console.log(` ${it.verdict} ${(it.score ?? 0).toFixed(2)} ${it.url?.slice(-70)}`);
  writeFileSync(`${OUT}/stats.json`, JSON.stringify(s, null, 1));
  // Feed shots.
  await p.evaluate(() => scrollTo(0, 0)); await sleep(1500); await anon();
  await p.screenshot({ path: `${OUT}/feed-top.png` });
  await p.evaluate(() => scrollTo(0, 650)); await sleep(1500); await anon();
  await p.screenshot({ path: `${OUT}/feed-2.png` });
  // Large post photos.
  const photos = await p.evaluate(() => window.__deep(document, 'img').filter((im) => im.naturalWidth > 500 && im.getBoundingClientRect().width > 400 && /redd\.it/.test(im.currentSrc || im.src)).map((im) => im.currentSrc || im.src));
  console.log(`${photos.length} large photos`);
  writeFileSync(`${OUT}/photos.json`, JSON.stringify(photos, null, 1));
  // Details panel on a real photo, exactly like right-click > Inspect for AI generation.
  const pick = photos.find((u) => process.env.PICK && u.includes(process.env.PICK)) || photos[0];
  if (pick) {
    await p.evaluate((u) => window.__img(u)?.scrollIntoView({ block: "center" }), pick);
    await sleep(1500); await anon();
    await ext.evaluate(async (u) => {
      const [t] = await chrome.tabs.query({ url: '*://www.reddit.com/*' });
      await chrome.tabs.sendMessage(t.id, { type: 'showDetails', url: u, kind: 'image', loading: true }, { frameId: 0 });
      const result = await chrome.runtime.sendMessage({ type: 'analyze', url: u });
      await chrome.tabs.sendMessage(t.id, { type: 'showDetails', url: u, kind: 'image', result }, { frameId: 0 });
    }, pick);
    await sleep(2500);
    await p.screenshot({ path: `${OUT}/inspect-real.png` });
    await p.keyboard.press('Escape');
  }
  // Hover shots of anything flagged.
  let n = 0;
  for (const it of (s?.flaggedItems || []).filter((x) => x.url).slice(0, 4)) {
    n++;
    const ok = await p.evaluate((u) => { const im = window.__img(u); if (!im) return false; im.scrollIntoView({ block: 'center' }); return true; }, it.url);
    if (!ok) continue;
    await sleep(1500); await anon();
    const rect = await p.evaluate((u) => {
      const im = window.__img(u);
      let card = im;
      for (let e = im; e; e = e.parentElement || e.getRootNode().host) if (/^(SHREDDIT-POST|ARTICLE)$/.test(e.tagName)) { card = e; break; }
      const c = card.getBoundingClientRect(), i = im.getBoundingClientRect();
      return { sx: scrollX, sy: scrollY, card: { x: c.left, y: c.top, w: c.width, h: c.height }, img: { x: i.left, y: i.top, w: i.width, h: i.height } };
    }, it.url);
    await p.evaluate(() => dispatchEvent(new Event('scroll'))); await sleep(300);
    await p.mouse.move(rect.img.x + 18, rect.img.y + 14, { steps: 8 }); await sleep(1600);
    const clip = { x: Math.max(0, rect.card.x - 16) + rect.sx, y: Math.max(0, rect.card.y - 16) + rect.sy, width: rect.card.w + 32, height: Math.min(rect.card.h + 32, 1400) };
    await p.screenshot({ path: `${OUT}/flag-${n}-hover.png`, clip });
    writeFileSync(`${OUT}/flag-${n}.json`, JSON.stringify({ ...it, rect }, null, 1));
  }
} finally { await b.close(); }
