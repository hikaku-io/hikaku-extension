// Blurs prices and street addresses on real-estate listing cards in a screen
// recording, so a demo doesn't single out real homes.
//
// How: OCR (tesseract.js) finds each price ("$1,250,000") in sampled frames.
// On listing cards the address sits right under the price, so we blur a box
// anchored on the price that covers the price, the beds/baths line, the address
// and the features line. Between OCR samples each box glides from its old to its
// new position, so the blur follows the page as it scrolls.
//
// The output is rendered offline, one frame at a time (seek, blur, encode with
// WebCodecs, mux with mp4-muxer). Real-time playback drifted a frame or two
// against the boxes during fast scrolls and let text show through.
//
// Usage: node scripts/blur-listings.mjs <in.mp4> <out.mp4> [--from=0] [--to=end] [--fps=15] [--rate=30]
import puppeteer from 'puppeteer';
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createWorker } from 'tesseract.js';

const args = process.argv.slice(2);
const [input, output] = args.filter((a) => !a.startsWith('--'));
const opt = (k, d) => { const v = args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]; return v == null ? d : Number(v); };
const FROM = opt('from', 0), TO = opt('to', Infinity), FPS = opt('fps', 15);
const RATE = opt('rate', 30);                 // output frame rate
const STEP = Math.max(1, Math.round(RATE / FPS)); // OCR every STEP-th frame
const at = (n) => (n + 0.5) / RATE;          // seek to the middle of frame n so we land on it, not its neighbour
const HOLD = 0.15;         // seconds an unmatched box stays blurred around its sample
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

  // ---- 2. render every frame offline with the boxes blurred
  const mime = await page.evaluate(async ({ samples, HOLD, RATE }) => {
    const v = document.getElementById('v');
    const W = v.videoWidth & ~1, H = v.videoHeight & ~1;
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const x = c.getContext('2d');
    const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const partner = (b, list) => {
      let best = null, bestD = Infinity;
      for (const o of list) { const a = center(b), q = center(o), d = Math.hypot(a.x - q.x, a.y - q.y); if (d < bestD && d < Math.max(b.w, b.h) * 0.6) { best = o; bestD = d; } }
      return best;
    };
    const boxesAt = (t) => {
      const i = samples.findIndex((s) => s.t > t + 1e-6);
      if (i === -1) return samples.filter((s) => Math.abs(s.t - t) <= HOLD).flatMap((s) => s.boxes);
      if (i === 0) return t >= samples[0].t - HOLD ? samples[0].boxes : [];
      const A = samples[i - 1], B = samples[i], k = (t - A.t) / (B.t - A.t);
      const out = [];
      for (const a of A.boxes) {
        const b = partner(a, B.boxes);
        if (b) out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });
        else if (t - A.t <= HOLD) out.push(a);
      }
      for (const b of B.boxes) if (!partner(b, A.boxes) && B.t - t <= HOLD) out.push(b);
      return out;
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
      for (const b of boxesAt(t)) {
        x.save();
        x.beginPath(); x.rect(b.x, b.y, b.w, b.h); x.clip();
        x.filter = 'blur(16px)';
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
  }, { samples, HOLD, RATE });
  console.log(`✓ ${output} (${mime}, ${(statSync(output).size / 1048576).toFixed(1)} MB)`);
} finally {
  await worker.terminate();
  await browser.close();
  server.close();
}
