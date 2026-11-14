// Turns a video into an animated GIF (for READMEs, store listings, social posts).
// Chrome decodes the video frame by frame; gifenc writes the GIF.
//
// Usage: node scripts/mp4-to-gif.mjs <in.mp4> [out.gif] [--fps=10] [--width=640]
import puppeteer from 'puppeteer';
import http from 'node:http';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const output = args.filter((a) => !a.startsWith('--'))[1] || input.replace(/\.[^.]+$/, '.gif');
const opt = (k, d) => Number(args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d);
const FPS = opt('fps', 10), WIDTH = opt('width', 640);

// Serve the file with Range support so the video element can seek.
const size = statSync(input).size;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<video id="v" muted preload="auto" src="/v"></video>'); }
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

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const info = await page.evaluate(async (W) => {
    const v = document.getElementById('v');
    if (v.readyState < 1) await new Promise((r) => (v.onloadedmetadata = r));
    const h = Math.round((v.videoHeight / v.videoWidth) * W / 2) * 2;
    window.__c = Object.assign(document.createElement('canvas'), { width: W, height: h });
    return { duration: v.duration, w: v.videoWidth, h: v.videoHeight, outH: h };
  }, WIDTH);
  console.log(`input ${info.w}x${info.h}, ${info.duration.toFixed(1)} s → ${WIDTH}x${info.outH} at ${FPS} fps`);

  const gif = GIFEncoder();
  const frames = Math.floor(info.duration * FPS);
  for (let i = 0; i < frames; i++) {
    const b64 = await page.evaluate(async (t) => {
      const v = document.getElementById('v'), c = window.__c, x = c.getContext('2d', { willReadFrequently: true });
      v.currentTime = t;
      await new Promise((r) => (v.onseeked = r));
      x.drawImage(v, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let s = '';
      for (let k = 0; k < d.length; k += 0x8000) s += String.fromCharCode(...d.subarray(k, k + 0x8000));
      return btoa(s);
    }, (i + 0.5) / FPS);
    const rgba = new Uint8Array(Buffer.from(b64, 'base64'));
    const palette = quantize(rgba, 256);
    gif.writeFrame(applyPalette(rgba, palette), WIDTH, info.outH, { palette, delay: Math.round(1000 / FPS) });
    if ((i + 1) % 50 === 0) process.stdout.write(`  ${i + 1}/${frames} frames\n`);
  }
  gif.finish();
  writeFileSync(output, gif.bytes());
  console.log(`✓ ${output} (${(statSync(output).size / 1048576).toFixed(1)} MB, ${frames} frames)`);
} finally {
  await browser.close();
  server.close();
}
