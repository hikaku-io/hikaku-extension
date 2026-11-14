// Re-encodes a video for the web (smaller resolution and bitrate) and saves a
// poster image. Chrome decodes and re-encodes it with MediaRecorder, so no
// ffmpeg is needed. Encoding runs in real time (a 40 s video takes ~40 s).
//
// Usage: node scripts/web-video.mjs <in.mp4> <outDir> [--width=1280] [--kbps=1800] [--poster-at=8]
// Output: <outDir>/demo.mp4 (or .webm), <outDir>/demo-poster.jpg, <outDir>/demo-poster.webp
import puppeteer from 'puppeteer';
import http from 'node:http';
import { createReadStream, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const [input, outDir] = args.filter((a) => !a.startsWith('--'));
const opt = (k, d) => Number(args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const WIDTH = opt('width', 1280), KBPS = opt('kbps', 1800), POSTER_AT = opt('poster-at', 8);
mkdirSync(outDir, { recursive: true });

const size = statSync(input).size;
let saved = null;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<video id="v" muted playsinline preload="auto" src="/v"></video>'); }
  if (req.url.startsWith('/save')) {
    const name = new URL(req.url, 'http://x').searchParams.get('name');
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => { writeFileSync(join(outDir, name), Buffer.concat(parts)); saved = name; res.end('ok'); });
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

const browser = await puppeteer.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async ({ W, KBPS, POSTER_AT }) => {
    const v = document.getElementById('v');
    if (v.readyState < 2) await new Promise((r) => (v.oncanplay = r));
    const H = Math.round((v.videoHeight / v.videoWidth) * W / 2) * 2;
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const x = c.getContext('2d');
    const post = async (name, blob) => fetch(`/save?name=${name}`, { method: 'POST', body: blob });

    // Poster frame, in JPEG and WebP.
    v.currentTime = Math.min(POSTER_AT, v.duration - 0.1);
    await new Promise((r) => (v.onseeked = r));
    x.drawImage(v, 0, 0, W, H);
    await post('demo-poster.jpg', await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)));
    await post('demo-poster.webp', await new Promise((r) => c.toBlob(r, 'image/webp', 0.82)));

    // Re-encode by playing the video onto the canvas and recording it.
    const types = ['video/mp4;codecs=avc1.4d0028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime, videoBitsPerSecond: KBPS * 1000 });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    v.currentTime = 0;
    await new Promise((r) => (v.onseeked = r));
    rec.start(1000);
    await v.play();
    await new Promise((done) => {
      const draw = () => { x.drawImage(v, 0, 0, W, H); if (v.ended) done(); else requestAnimationFrame(draw); };
      draw();
      v.onended = done;
    });
    rec.stop();
    await new Promise((r) => (rec.onstop = r));
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    await post(`demo.${ext}`, new Blob(chunks, { type: mime }));
    return { W, H, duration: v.duration, mime };
  }, { W: WIDTH, KBPS, POSTER_AT });
  console.log(`✓ ${result.W}x${result.H}, ${result.duration.toFixed(1)} s, ${result.mime}`);
} finally {
  await browser.close();
  server.close();
}
for (const f of ['demo.mp4', 'demo.webm', 'demo-poster.jpg', 'demo-poster.webp']) {
  try { console.log(`  ${f}: ${(statSync(join(outDir, f)).size / 1048576).toFixed(2)} MB`); } catch {}
}
void saved;
