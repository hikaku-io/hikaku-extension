// Demo feed used by the screenshot and demo-video scripts. The images are
// generated here (no third-party content) and carry *demo* Content Credentials
// from a made-up "Example Image Model", so they flag without any real brand.
import jpeg from 'jpeg-js';

// ------------------------------------------------------------ procedural images

function landscape(w, h, palette, seed) {
  const data = Buffer.alloc(w * h * 4);
  const rnd = (x) => { const s = Math.sin(x * 127.1 + seed * 311.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return rnd(i) * (1 - u) + rnd(i + 1) * u; };
  const ridge = (x, scale, amp, off) => { let v = 0, a = amp, s = scale; for (let o = 0; o < 5; o++) { v += noise(x / s + off * 13 + o * 7) * a; a /= 2; s /= 2; } return v; };
  const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
  const horizon = h * 0.68;
  const sun = { x: w * 0.68, y: h * 0.3, r: h * 0.07 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ry = y, water = false;
      if (y > horizon) { ry = 2 * horizon - y + Math.sin(x / 9 + y / 3) * 1.5; water = true; }
      let col = mix(palette.skyTop, palette.skyLow, Math.min(1, ry / horizon));
      const d = Math.hypot(x - sun.x, ry - sun.y);
      if (d < sun.r) col = palette.sun;
      else col = mix(col, palette.sun, Math.max(0, 1 - (d - sun.r) / (h * 0.35)) * 0.45);
      palette.layers.forEach((lc, li) => {
        const top = horizon - ridge(x, 260 - li * 60, h * (0.42 - li * 0.1), li + seed) + li * h * 0.05;
        if (ry > top) col = mix(lc, palette.skyLow, 0.35 - li * 0.12);
      });
      if (water) col = mix(col, palette.water, 0.35).map((c) => c * 0.88);
      const o = (y * w + x) * 4;
      data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255;
    }
  }
  return jpeg.encode({ data, width: w, height: h }, 90).data;
}

function withDemoCredentials(jpg, sourceType) {
  const enc = (s) => Buffer.from(s, 'latin1');
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const label = Buffer.concat([enc('c2pa'), Buffer.from([0])]);
  const jumd = Buffer.concat([u32(8 + 16 + 1 + label.length), enc('jumd'), enc('c2pa'), Buffer.alloc(12), Buffer.from([3]), label]);
  const gen = enc('Example Image Model 2.0');
  const org = enc('Example AI Lab');
  const payload = Buffer.concat([
    Buffer.from([0x6f]), enc('claim_generator'), Buffer.from([0x60 + gen.length]), gen,
    enc(`http://cv.iptc.org/newscodes/digitalsourcetype/${sourceType}`), enc('c2pa.created'),
    Buffer.from([0x06, 0x03, 0x55, 0x04, 0x0a, 0x0c, org.length]), org,
  ]);
  const jumb = Buffer.concat([u32(8 + jumd.length + payload.length), enc('jumb'), jumd, payload]);
  const seg = Buffer.concat([enc('JP'), Buffer.from([0, 1]), u32(1), jumb]);
  const len = Buffer.alloc(2); len.writeUInt16BE(seg.length + 2);
  return Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xeb]), len, seg, jpg.subarray(2)]);
}

export const IMAGES = {
  a: withDemoCredentials(landscape(1200, 760, {
    skyTop: [74, 98, 196], skyLow: [247, 186, 150], sun: [255, 236, 200], water: [60, 80, 150],
    layers: [[120, 110, 170], [80, 70, 140], [45, 40, 95]],
  }, 1), 'trainedAlgorithmicMedia'),
  b: withDemoCredentials(landscape(1200, 760, {
    skyTop: [40, 110, 170], skyLow: [180, 220, 230], sun: [255, 250, 230], water: [40, 90, 110],
    layers: [[110, 150, 160], [60, 110, 110], [30, 70, 70]],
  }, 7), 'compositeWithTrainedAlgorithmicMedia'),
};

// ------------------------------------------------------------ mock feed

const post = (id, user, time, title, src) => `
<article class="post"><header><span class="av" style="background:${id === 1 ? '#f59e0b' : '#10b981'}"></span><b>${user}</b><span class="t">· ${time}</span></header>
<h2>${title}</h2><img src="${src}" alt=""><footer><span>▲ 1.2k</span><span>💬 214</span><span>↗ Share</span></footer></article>`;
export const feed = `<!doctype html><meta charset="utf-8"><title>Feed</title>
<style>
body{margin:0;background:#f4f4f5;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#18181b}
.top{height:56px;background:#fff;border-bottom:1px solid #e4e4e7;display:flex;align-items:center;padding:0 24px;gap:12px;font-weight:700}
.top i{width:28px;height:28px;border-radius:8px;background:#18181b;display:inline-block}
.wrap{max-width:720px;margin:24px auto;display:grid;gap:20px}
.post{background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:16px}
.post header{display:flex;align-items:center;gap:8px;font-size:13px}.av{width:24px;height:24px;border-radius:50%}.t{color:#71717a}
.post h2{font-size:17px;margin:10px 0 12px}.post img{width:100%;height:auto;display:block;border-radius:10px}
.post footer{display:flex;gap:18px;margin-top:12px;color:#52525b;font-size:13px;font-weight:600}
</style>
<div class="top"><i></i>Feed</div>
<div class="wrap">${post(1, 'u/skyline_daily', '3h', 'Sunset over the ridge this evening', '/a.jpg')}${post(2, 'u/lakeside', '5h', 'Morning at the lake, touched up a little', '/b.jpg')}</div>`;

/** Tiny static server for the feed and its images. Returns { base, close }. */
export async function serveFeed(http) {
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(feed); }
    const img = { '/a.jpg': IMAGES.a, '/b.jpg': IMAGES.b }[req.url];
    if (img) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(img); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
