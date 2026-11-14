// Captures real-world screenshots of Hikaku on a real-estate listings page
// (written for Redfin's search results): Grid layout, cookie banner closed
// without accepting, every street address swapped for an obviously fictional
// one, then for each flagged photo a close-up of its card, the card with the
// hover summary, and the page with the details panel open. Runs headless.
//
// Usage: EXT_DIR=dist/hikaku-x.y.z-offline OUT=<dir> [PAGES=1] //          node scripts/capture-listings.mjs <results-page-url> [max-per-page]
//
// Check every capture before publishing it: a flag on a real photo is the
// model's estimate, not proof, so don't present a likely false positive as AI.
import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = process.env.OUT, EXT = process.env.EXT_DIR, URL_ = process.argv[2], MAX = +(process.argv[3] || 6);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ headless: true, defaultViewport: null, args: ['--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu', '--window-size=1400,1000'] });
try {
  const sw = await b.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(sw.url()).host;
  const ext = await b.newPage();
  await ext.goto(`chrome-extension://${extId}/popup/popup.html`);
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'modelWarmup' }));
  await ext.evaluate(() => chrome.storage.local.set({ uiScheme: 'light' }));
  const p = await b.newPage();
  await p.setViewport({ width: 1366, height: 900, deviceScaleFactor: 2 });
  const PAGES = +(process.env.PAGES || 1);
  let n = +(process.env.N0 || 0);
  for (let pg = +(process.env.P0 || 1); pg <= PAGES; pg++) {
  await p.goto(pg === 1 ? URL_ : `${URL_.replace(/\/$/, '')}/page-${pg}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  // Overlays: the cookie banner's X closes it without accepting; then any small close buttons near the top.
  await p.evaluate(() => {
    document.querySelector('#onetrust-close-btn-container button, .onetrust-close-btn-handler')?.click();
    for (const el of document.querySelectorAll('button')) { const t = (el.getAttribute('aria-label') || el.textContent || '').trim(); const r = el.getBoundingClientRect(); if (r.width && /^(close|close button|dismiss)$/i.test(t) && r.top < 300) el.click(); }
  });
  await sleep(800);
  // Grid layout.
  if (await p.$('.ExposedLayoutButton')) await p.click('.ExposedLayoutButton'); else console.log('no layout button (grid kept)');
  await sleep(800);
  await p.evaluate(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Grid' && e.getBoundingClientRect().width); el?.closest('button, [role="menuitem"], [role="menuitemradio"], li, label')?.click() || el?.click(); });
  await sleep(3000);

  // Fictional street addresses, kept in place as the page re-renders.
  await p.evaluate(() => {
    const NAMES = ['Example St', 'Sample Ct', 'Placeholder Ln', 'Demo Dr', 'Mockup Loop', 'Fictional Way', 'Specimen St', 'Prototype Pl', 'Sandbox Rd', 'Template Ter', 'Standin Cv', 'Rehearsal Way', 'Pretend Path', 'Makebelieve Blvd'];
    const map = new Map();
    const RE = /^(.*?),\s*(Fort Myers Beach|Fort Myers|Bonita Springs|Estero),\s*FL\s*(\d{5})$/;
    const fake = (street) => { if (!map.has(street)) { const i = map.size; map.set(street, `${1000 + ((i * 397) % 8900)} ${NAMES[i % NAMES.length]}`); } return map.get(street); };
    const fix = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) { const m = n.nodeValue.trim().match(RE); if (m && !/^\d{3,4} (Example|Sample|Placeholder|Demo|Mockup|Fictional|Specimen|Prototype|Sandbox|Template|Standin|Rehearsal|Pretend|Makebelieve)/.test(m[1])) n.nodeValue = `${fake(m[1])}, ${m[2]}, FL ${m[3]}`; }
      for (const el of root.querySelectorAll?.('[aria-label*=", FL "], [title*=", FL "], img[alt*=", FL "]') || []) for (const a of ['aria-label', 'title', 'alt']) { const v = el.getAttribute(a); if (v && /, FL \d{5}/.test(v)) el.setAttribute(a, v.replace(/(Property at )?[^,]+,/, (s, pre) => `${pre || ''}${fake(s.replace(/^Property at /, '').slice(0, -1))},`)); }
    };
    fix(document.body);
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) fix(n); else if (n.nodeType === 3 && n.parentElement) fix(n.parentElement); fix(document.body); }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  if (pg === 1) await p.screenshot({ path: `${OUT}/grid-top.png` });

  // Scroll slowly so every photo gets checked.
  const stats = () => ext.evaluate(async () => { const [t] = await chrome.tabs.query({ url: '*://www.redfin.com/*' }); return t ? chrome.tabs.sendMessage(t.id, { type: 'stats' }, { frameId: 0 }).catch(() => null) : null; });
  for (let i = 0; i < 30; i++) {
    const done = await p.evaluate(() => { const before = scrollY; scrollBy(0, 500); return scrollY === before; });
    await p.bringToFront();
    await sleep(1400);
    if (done) break;
  }
  await sleep(3000);
  const s = await stats();
  const items = (s?.flaggedItems || []).filter((it) => it.url).sort((a, b) => (b.score || 0) - (a.score || 0));
  console.log(`page ${pg}: scanned ${s?.scanned}, flagged ${s?.flagged}`);
  for (const it of items) console.log(` ${it.verdict} ${(it.score ?? 0).toFixed(2)} ${it.url.slice(-60)}`);
  writeFileSync(`${OUT}/flagged-p${pg}.json`, JSON.stringify(items, null, 1));

  for (const it of items.slice(0, MAX)) {
    n++;
    const ok = await p.evaluate((u) => { const el = [...document.images].find((im) => (im.currentSrc || im.src) === u); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; }, it.url);
    if (!ok) { console.log(`#${n} not on page`); continue; }
    await p.mouse.move(5, 450);
    await sleep(1500);
    const r = await p.evaluate((u) => {
      const im = [...document.images].find((x) => (x.currentSrc || x.src) === u);
      const card = im.closest('.bp-Homecard') || im.closest('[class*="HomeCardContainer"], [class*="Homecard"]') || im.parentElement;
      const c = card.getBoundingClientRect(), i = im.getBoundingClientRect();
      return { sx: scrollX, sy: scrollY, card: { x: c.left, y: c.top, w: c.width, h: c.height }, img: { x: i.left, y: i.top, w: i.width, h: i.height } };
    }, it.url);
    const pad = 24, clip = { x: Math.max(0, r.card.x - pad) + r.sx, y: Math.max(0, r.card.y - pad) + r.sy, width: r.card.w + pad * 2, height: r.card.h + pad * 2 };
    await p.screenshot({ path: `${OUT}/card-${n}.png`, clip });
    await p.evaluate(() => dispatchEvent(new Event('scroll')));
    await sleep(300);
    await p.mouse.move(r.img.x + r.img.w * 0.5, r.img.y + r.img.h * 0.5, { steps: 6 });
    await sleep(300);
    await p.mouse.move(r.img.x + 18, r.img.y + 14, { steps: 10 });
    await sleep(1600);
    await p.screenshot({ path: `${OUT}/card-${n}-hover.png`, clip });
    await p.mouse.move(r.img.x + 16, r.img.y + 12, { steps: 5 });
    await sleep(400);
    await p.mouse.down(); await p.mouse.up();
    await sleep(2200);
    await p.screenshot({ path: `${OUT}/card-${n}-panel.png` });
    await p.keyboard.press('Escape');
    await sleep(600);
    writeFileSync(`${OUT}/card-${n}.json`, JSON.stringify({ ...it, page: pg, rect: r }, null, 1));
  }
  }
} finally {
  await b.close();
}
