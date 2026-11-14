// Re-encodes a video for the web (smaller resolution and bitrate) and saves a
// poster image. Chrome decodes it, and each frame is re-encoded to H.264 with
// WebCodecs and written with mp4-muxer, so no ffmpeg is needed.
//
// We don't use MediaRecorder here: its MP4s leave the total duration out of the
// header, so players show the wrong length and seeking misbehaves.
//
// Usage: node scripts/web-video.mjs <in.mp4> <outDir> [--width=1280] [--kbps=1800] [--poster-at=8] [--fps=30] [--duration=<s>]
// Output: <outDir>/demo.mp4, <outDir>/demo-poster.jpg, <outDir>/demo-poster.webp
import puppeteer from 'puppeteer';
import http from 'node:http';
import { createReadStream, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const [input, outDir] = args.filter((a) => !a.startsWith('--'));
const opt = (k, d) => Number(args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const WIDTH = opt('width', 1280), KBPS = opt('kbps', 1800), POSTER_AT = opt('poster-at', 8), FPS = opt('fps', 30), DURATION = opt('duration', 0);
mkdirSync(outDir, { recursive: true });

const size = statSync(input).size;
let saved = null;
const server = http.createServer((req, res) => {
  if (req.url === '/mux.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(new URL('../node_modules/mp4-muxer/build/mp4-muxer.js', import.meta.url))); }
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<script src="/mux.js"></script><video id="v" muted playsinline preload="auto" src="/v"></video>'); }
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

const browser = await puppeteer.launch({ headless: true, protocolTimeout: 0, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async ({ W, KBPS, POSTER_AT, FPS, DURATION }) => {
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

    // Length. MediaRecorder MP4s can report a wrong one; pass --duration for those.
    const D = DURATION || v.duration;
    if (!Number.isFinite(D) || D <= 0) throw new Error('Unknown video length; pass --duration=<seconds>');

    // Re-encode frame by frame.
    const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: FPS }, fastStart: 'in-memory' });
    let failed = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failed = e; } });
    enc.configure({ codec: 'avc1.4d0028', width: W, height: H, bitrate: KBPS * 1000, framerate: FPS, avc: { format: 'avc' } });
    const frames = Math.floor(D * FPS);
    for (let n = 0; n < frames; n++) {
      v.currentTime = (n + 0.5) / FPS;
      await new Promise((r) => (v.onseeked = r));
      x.drawImage(v, 0, 0, W, H);
      const f = new VideoFrame(c, { timestamp: Math.round((n * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(f, { keyFrame: n % (FPS * 2) === 0 });
      f.close();
      while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
      if (failed) throw failed;
    }
    await enc.flush();
    muxer.finalize();
    await post('demo.mp4', new Blob([muxer.target.buffer], { type: 'video/mp4' }));
    const mime = 'video/mp4 (H.264, ' + frames + ' frames)';
    return { W, H, duration: D, mime };
  }, { W: WIDTH, KBPS, POSTER_AT, FPS, DURATION });
  console.log(`✓ ${result.W}x${result.H}, ${result.duration.toFixed(1)} s, ${result.mime}`);
} finally {
  await browser.close();
  server.close();
}
for (const f of ['demo.mp4', 'demo-poster.jpg', 'demo-poster.webp']) {
  try { console.log(`  ${f}: ${(statSync(join(outDir, f)).size / 1048576).toFixed(2)} MB`); } catch {}
}
void saved;
