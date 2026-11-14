// Blurs prices and street addresses on real-estate listing cards in a screen
// recording, so a demo doesn't single out real homes.
//
// How: OCR (tesseract.js) finds each price ("$1,250,000") in sampled frames.
// On listing cards the address sits right under the price, so we blur a box
// anchored on the price that covers the price, the beds/baths line, the address
// and the features line.
//
// OCR misses a row now and then, mostly mid-scroll. So we also measure how far
// the page scrolled between samples (by sliding each frame over the previous
// one) and carry every box a few samples forward and back along that motion.
// A row stays blurred even if OCR loses it for a moment.
//
// The output is rendered offline, one frame at a time (seek, blur, encode with
// WebCodecs, mux with mp4-muxer). Real-time playback drifted a frame or two
// against the boxes during fast scrolls and let text show through.
//
// Crossfades are the weak spot: two frames blended together leave text a person
// can still read but OCR can't. So the whole frame is blurred for CUT_PAD seconds
// around every cut the scroll tracking finds, and around any extra ranges passed
// with --full.
//
// --mode=fake leaves prices and photos alone and only swaps each card's street
// address for an obviously made-up one ("212 Example Ct"). Each card keeps the
// same fake address for as long as it's on screen.
//
// Usage: node scripts/blur-listings.mjs <in.mp4> <out.mp4> [--from=0] [--to=end] [--fps=15] [--rate=30] [--full=1.6-3.1,17.9-19.5] [--mode=blur|fake]
import puppeteer from 'puppeteer';
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createWorker } from 'tesseract.js';

const args = process.argv.slice(2);
const [input, output] = args.filter((a) => !a.startsWith('--'));
const opt = (k, d) => { const v = args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]; return v == null ? d : Number(v); };
const FROM = opt('from', 0), TO = opt('to', Infinity), FPS = opt('fps', 15);
const RATE = opt('rate', 30);
const MODE = args.find((a) => a.startsWith('--mode='))?.slice(7) || 'blur';
const FULL = (args.find((a) => a.startsWith('--full='))?.slice(7) || '').split(',').filter(Boolean).map((r) => r.split('-').map(Number));                 // output frame rate
const STEP = Math.max(1, Math.round(RATE / FPS)); // OCR every STEP-th frame
const at = (n) => (n + 0.5) / RATE;          // seek to the middle of frame n so we land on it, not its neighbour
const WINDOW = 0.3;       // seconds a detected box is carried forward and back along the scroll
const PRICE = /^\$\d{1,3}(,\d{3})+/; // $250,000 / $1,250,000

const size = statSync(input).size;
const server = http.createServer((req, res) => {
  if (req.url === '/mux.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(new URL('../node_modules/mp4-muxer/build/mp4-muxer.js', import.meta.url))); }
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<body style="margin:0"><script src="/mux.js"></script><video id="v" muted playsinline preload="auto" src="/v"></video>'); }
  if (req.url === '/save') {
    const parts = []; req.on('data', (d) => parts.push(d));
    req.on('end', () => { writeFileSync(output, Buffer.concat(parts)); res.end('ok'); });
    return;
  }
  const m = (req.headers.range || '').match(/bytes=(\d+)-(\d*)/);
  if (m) {
    const s = +m[1], e = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${s}-${e}/${size}`, 'accept-ranges': 'bytes', 'content-length': e - s + 1 });
    return createReadStream(input, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
  createReadStream(input).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await puppeteer.launch({ headless: true, protocolTimeout: 0, args: ['--autoplay-policy=no-user-gesture-required'] });
const worker = await createWorker('eng');
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const info = await page.evaluate(async () => {
    const v = document.getElementById('v');
    if (v.readyState < 1) await new Promise((r) => (v.onloadedmetadata = r));
    return { w: v.videoWidth, h: v.videoHeight, duration: v.duration };
  });
  const end = Math.min(TO, info.duration);
  console.log(`video ${info.w}x${info.h}, ${info.duration.toFixed(1)} s; scanning ${FROM}-${end.toFixed(1)} s, OCR on every ${STEP} frame(s) at ${RATE} fps`);

  // ---- 1. find prices in sampled frames (cached next to the output, since OCR is the slow part)
  const cache = `${output}.boxes.json`;
  const key = JSON.stringify({ input, size, FROM, TO: end, RATE, STEP });
  const cached = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : null;
  const samples = cached?.key === key ? cached.samples : [];
  if (samples.length) console.log(`reusing OCR results from ${cache}`);
  else for (let n = Math.ceil(FROM * RATE); at(n) <= end; n += STEP) {
    const t = at(n);
    const b64 = await page.evaluate(async (time) => {
      const v = document.getElementById('v');
      v.currentTime = time;
      await new Promise((r) => (v.onseeked = r));
      const c = Object.assign(document.createElement('canvas'), { width: v.videoWidth, height: v.videoHeight });
      c.getContext('2d').drawImage(v, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    }, t);
    const { data } = await worker.recognize(Buffer.from(b64, 'base64'), {}, { blocks: true });
    const prices = [];
    for (const bl of data.blocks || []) for (const p of bl.paragraphs) for (const l of p.lines) for (const wd of l.words) {
      if (PRICE.test(wd.text.trim())) prices.push(wd.bbox);
    }
    // Card width: spacing between prices on the same row, else a multiple of the text height.
    const boxes = prices.map((b) => {
      const h = b.y1 - b.y0;
      const row = prices.filter((o) => Math.abs(o.y0 - b.y0) < h && o.x0 > b.x0 + h * 4).map((o) => o.x0 - b.x0);
      const cardW = row.length ? Math.min(...row) - h * 0.6 : h * 13;
      return { x: b.x0 - h * 0.5, y: b.y0 - h * 0.45, w: cardW + h * 0.4, h: h * 5.1 };
    });
    samples.push({ t, boxes });
    if (samples.length % 20 === 0) process.stdout.write(`  ${t.toFixed(1)} s: ${boxes.length} price(s)\n`);
  }
  if (!cached || cached.key !== key) writeFileSync(cache, JSON.stringify({ key, samples }));
  const total = samples.reduce((n, s) => n + s.boxes.length, 0);
  console.log(`found ${total} price boxes in ${samples.length} frames`);

  // ---- 1a. OCR sometimes merges a price with the line under it, which makes
  // its box twice as tall. All prices on screen share one size, so size every box
  // from the median price height around that moment.
  const phOf = (b) => b.h / 5.1;
  for (const [i, sm] of samples.entries()) {
    const near = samples.slice(Math.max(0, i - 4), i + 5).flatMap((o) => o.boxes.map(phOf)).sort((a, b) => a - b);
    if (!near.length) continue;
    const med = near[Math.floor(near.length * 0.25)]; // low quantile: merged boxes only ever come out too big
    sm.boxes = sm.boxes.map((b) => {
      const ph = phOf(b);
      if (ph < med * 1.25 && ph > med * 0.8) return b;
      const x0 = b.x + ph * 0.5, y0 = b.y + ph * 0.45, cardW = b.w - ph * 0.4;
      return { x: x0 - med * 0.5, y: y0 - med * 0.45, w: cardW + med * 0.4, h: med * 5.1 };
    });
  }

  // ---- 1b. fill gaps: OCR sometimes misses a price in a frame or two. If a box
  // exists shortly before and after (matched by position), insert the in-between box.
  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const match = (b, list) => {
    let best = null, bestD = Infinity;
    for (const o of list) {
      const a = center(b), c = center(o), d = Math.hypot(a.x - c.x, a.y - c.y);
      if (d < bestD && d < Math.max(b.w, b.h) * 0.6) { best = o; bestD = d; }
    }
    return best;
  };
  const lerpBox = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });
  let filled = 0;
  for (let gap = 1; gap <= 3; gap++) {
    for (let i = 0; i + gap + 1 < samples.length; i++) {
      const A = samples[i], B = samples[i + gap + 1];
      for (const a of A.boxes) {
        const b = match(a, B.boxes);
        if (!b) continue;
        for (let j = 1; j <= gap; j++) {
          const S = samples[i + j], k = j / (gap + 1), mid = lerpBox(a, b, k);
          if (!match(mid, S.boxes)) { S.boxes.push(mid); filled++; }
        }
      }
    }
  }
  console.log(`filled ${filled} missed boxes from neighbouring frames`);

  // ---- 1c. measure vertical scroll between samples. Compare quarter-size
  // grayscale frames below the sticky header; a big leftover difference means a
  // cut or a layout change, and boxes are not carried across it.
  const motion = await page.evaluate(async (times) => {
    const v = document.getElementById('v');
    const S = 4, w = Math.round(v.videoWidth / S), h = Math.round(v.videoHeight / S);
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const x = c.getContext('2d', { willReadFrequently: true });
    const gray = () => { const d = x.getImageData(0, 0, w, h).data, g = new Float32Array(w * h); for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; return g; };
    const out = [{ dy: 0, err: 0 }];
    let prev = null;
    const y0 = Math.round(h * 0.3), y1 = Math.round(h * 0.97), MAX = Math.round(h * 0.3);
    for (const t of times) {
      v.currentTime = t;
      await new Promise((r) => (v.onseeked = r));
      x.drawImage(v, 0, 0, w, h);
      const cur = gray();
      if (prev) {
        let best = 0, bestE = Infinity;
        for (let s = -MAX; s <= MAX; s++) {
          let e = 0, n = 0;
          for (let y = Math.max(y0, y0 + s); y < Math.min(y1, y1 + s); y += 2) {
            const a = y * w, b = (y - s) * w;
            for (let xx = 0; xx < w; xx += 2) { e += Math.abs(cur[a + xx] - prev[b + xx]); n++; }
          }
          e /= n || 1;
          if (e < bestE) { bestE = e; best = s; }
        }
        out.push({ dy: best * S, err: bestE });
      }
      prev = cur;
    }
    return out;
  }, samples.map((s) => s.t));
  const CUT = 12; // mean gray difference above this = not the same page
  let Y = 0, seg = 0;
  samples.forEach((s, i) => {
    if (i && motion[i].err > CUT) seg++;
    else Y += motion[i].dy;
    Object.assign(s, { Y, seg, dy: i && motion[i].err <= CUT ? motion[i].dy : 0 });
  });
  const CUT_PAD = 0.4;
  for (let i = 1; i < samples.length; i++) if (samples[i].seg !== samples[i - 1].seg) FULL.push([samples[i - 1].t - CUT_PAD, samples[i].t + CUT_PAD]);
  console.log(`scroll: ${samples.filter((s) => s.dy).length} moving samples, ${seg} cut(s); full-frame blur at ${FULL.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}`).join(', ')}`);

  // ---- 1d. give every card an id, so it keeps one fake address. Cards are told
  // apart by their position on the page (screen position minus scroll).
  const clusters = [];
  for (const s of samples) for (const b of s.boxes) {
    const px = b.x, py = b.y - s.Y;
    let c = clusters.find((k) => k.seg === s.seg && Math.abs(k.py - py) < b.h * 0.3 && Math.abs(k.px - px) < b.w * 0.3);
    if (!c) clusters.push((c = { id: clusters.length, seg: s.seg, px, py, n: 0 }));
    c.px = (c.px * c.n + px) / (c.n + 1); c.py = (c.py * c.n + py) / (c.n + 1); c.n++;
    b.id = c.id;
  }
  // Nothing gets drawn above the highest price seen on this page: that's where
  // the sticky header starts, and cards scrolling under it are hidden.
  // (The header doesn't scroll, so this is a screen position per segment.)
  const tops = {};
  for (const s of samples) for (const b of s.boxes) tops[s.seg] = Math.min(tops[s.seg] ?? Infinity, b.y + phOf(b) * 0.45);
  for (const s of samples) s.top = (tops[s.seg] ?? 0) - 2;
  if (MODE === 'fake') console.log(`${clusters.length} cards get a made-up address`);

  // ---- 2. render every frame offline with the boxes blurred (or addresses replaced)
  const mime = await page.evaluate(async ({ samples, WINDOW, RATE, FULL, MODE }) => {
    const v = document.getElementById('v');
    const W = v.videoWidth & ~1, H = v.videoHeight & ~1;
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const x = c.getContext('2d', { willReadFrequently: true });
    // Page offset at time t: the sample's offset plus a share of the next step.
    const where = (t) => {
      const i = samples.findIndex((s) => s.t > t + 1e-6);
      if (i === -1) return { Y: samples.at(-1).Y, seg: samples.at(-1).seg };
      if (i === 0) return { Y: samples[0].Y, seg: samples[0].seg };
      const A = samples[i - 1], B = samples[i], k = (t - A.t) / (B.t - A.t);
      return B.seg === A.seg ? { Y: A.Y + B.dy * k, seg: A.seg } : (k < 0.5 ? { Y: A.Y, seg: A.seg } : { Y: B.Y, seg: B.seg });
    };
    // Every box seen within WINDOW seconds, moved by the scroll since it was seen.
    const boxesAt = (t) => {
      const here = where(t), out = [];
      for (const s of samples) {
        if (Math.abs(s.t - t) > WINDOW || s.seg !== here.seg) continue;
        for (const b of s.boxes) out.push({ ...b, x: b.x - b.w * 0.03, w: b.w * 1.15, y: b.y + (here.Y - s.Y) - b.h * 0.5, h: b.h * 1.8 }); // padded: fast scrolls blend frames and tracking can be off by a line
      }
      return out;
    };

    // Fake mode: one box per card, taken from the nearest sample and moved by the scroll.
    const STREETS = ['101 Example Ave', '212 Sample Ct', '318 Placeholder Ln', '425 Demo Dr', '537 Mockup Loop', '642 Fictional Trl', '759 Specimen St', '864 Prototype Pl', '973 Sandbox Rd', '1080 Template Ter', '1191 Standin Cv', '1203 Rehearsal Way', '1314 Pretend Path', '1427 Makebelieve Blvd', '1536 Dummy Ridge Dr', '1648 Test Hollow Ln'];
    const cardsAt = (t) => {
      const here = where(t), best = new Map();
      for (const s of samples) {
        const d = Math.abs(s.t - t);
        if (d > Math.min(WINDOW, 0.1) || s.seg !== here.seg) continue; // tight: zooms aren't tracked, only scrolls
        for (const b of s.boxes) if (!best.has(b.id) || best.get(b.id).d > d) best.set(b.id, { d, b: { ...b, y: b.y + (here.Y - s.Y) } });
      }
      return { top: samples.find((s) => s.seg === here.seg)?.top ?? 0, cards: [...best.values()].map((e) => e.b) };
    };
    const fakeAddress = (b) => {
      // Back out the price's own box from the card box (see the OCR step).
      const ph = b.h / 5.1, x0 = b.x + ph * 0.5, y0 = b.y + ph * 0.45, cardW = b.w - ph * 0.4;
      const right = Math.min(W - 1, x0 + cardW - ph * 0.4);
      const sx = Math.max(0, Math.round(x0 - ph * 0.1)), sw = Math.round(Math.min(right, x0 + cardW * 0.75) - sx);
      const sy = Math.max(0, Math.round(y0 - ph * 0.6)), sh = Math.min(H - sy, Math.round(ph * 7));
      if (sw < 20 || sh < 20) return;
      // Find the text rows under the price by counting dark pixels per row.
      const d = x.getImageData(sx, sy, sw, sh).data, lum = new Float32Array(sw * sh);
      for (let i = 0; i < lum.length; i++) lum[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
      const bgL = [...lum].sort((p, q) => p - q)[Math.floor(lum.length * 0.9)];
      const rows = [];
      let start = -1, gap = 0;
      for (let y = 0; y < sh; y++) {
        let n = 0;
        for (let xx = 0; xx < sw; xx++) if (lum[y * sw + xx] < bgL - 45) n++;
        if (n > 2) { if (start < 0) start = y; gap = 0; } else if (start >= 0 && ++gap > 1) { if (y - gap - start >= 3) rows.push({ top: start, bot: y - gap }); start = -1; gap = 0; }
      }
      if (start >= 0) rows.push({ top: start, bot: sh - 1 });
      // The price is the tallest of the first two rows; the address is two rows below it.
      const pi = rows.length > 1 && rows[1].bot - rows[1].top > rows[0].bot - rows[0].top ? 1 : 0;
      const row = rows[pi + 2];
      if (!row) return;
      let inkR = 0;
      for (let y = row.top; y <= row.bot; y++) for (let xx = sw - 1; xx > inkR; xx--) if (lum[y * sw + xx] < bgL - 45) { inkR = xx; break; }
      const top = sy + row.top, rh = row.bot - row.top + 1;
      const [r, g, bl] = x.getImageData(Math.max(0, Math.round(x0 - ph * 0.25)), Math.round(top + rh / 2), 1, 1).data;
      x.fillStyle = `rgb(${r},${g},${bl})`;
      x.fillRect(x0 - 2, top - 2, Math.min(right, sx + inkR + 4) - x0 + 2, rh + 4);
      x.save();
      x.beginPath(); x.rect(x0 - 2, top - 3, right - x0 + 2, rh + 6); x.clip();
      x.fillStyle = 'rgba(78,78,78,0.9)';
      x.font = `${(rh * 1.12).toFixed(1)}px "Segoe UI", Inter, Arial, sans-serif`;
      x.textBaseline = 'alphabetic';
      x.fillText(`${STREETS[b.id % STREETS.length]}, Buda, TX 78610`, x0, top + rh * 0.88);
      x.restore();
    };

    const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: RATE }, fastStart: 'in-memory' });
    let failed = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failed = e; } });
    enc.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 10_000_000, framerate: RATE, avc: { format: 'avc' } });

    const frames = Math.floor(v.duration * RATE);
    for (let n = 0; n < frames; n++) {
      const t = (n + 0.5) / RATE;
      v.currentTime = t;
      await new Promise((r) => (v.onseeked = r));
      x.drawImage(v, 0, 0, W, H);
      if (FULL.some(([a, b]) => t >= a && t <= b)) { x.filter = MODE === 'fake' ? 'blur(12px)' : 'blur(24px)'; x.drawImage(v, 0, 0, W, H); x.filter = 'none'; }
      else if (MODE === 'fake') { const { top, cards } = cardsAt(t); x.save(); x.beginPath(); x.rect(0, top, W, H - top); x.clip(); for (const b of cards) fakeAddress(b); x.restore(); }
      else for (const b of boxesAt(t)) {
        x.save();
        x.beginPath(); x.rect(b.x, b.y, b.w, b.h); x.clip();
        x.filter = 'blur(32px)';
        x.drawImage(v, 0, 0, W, H);
        x.filter = 'none';
        x.restore();
      }
      const f = new VideoFrame(c, { timestamp: Math.round((n * 1e6) / RATE), duration: Math.round(1e6 / RATE) });
      enc.encode(f, { keyFrame: n % (RATE * 2) === 0 });
      f.close();
      while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
      if (failed) throw failed;
    }
    await enc.flush();
    muxer.finalize();
    await fetch('/save', { method: 'POST', body: muxer.target.buffer });
    return `video/mp4 (avc, ${frames} frames)`;
  }, { samples, WINDOW, RATE, FULL, MODE });
  console.log(`✓ ${output} (${mime}, ${(statSync(output).size / 1048576).toFixed(1)} MB)`);
} finally {
  await worker.terminate();
  await browser.close();
  server.close();
}
