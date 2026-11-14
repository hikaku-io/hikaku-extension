import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMetadata } from '../lib/metadata.js';
import { evaluate } from '../lib/score.js';

// ---------------------------------------------------------------- byte builders

const enc = new TextEncoder();
const bytes = (...parts) => {
  const arrs = parts.map((p) => (typeof p === 'string' ? Uint8Array.from(p, (c) => c.charCodeAt(0)) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const be16 = (n) => [(n >>> 8) & 255, n & 255];

const pngChunk = (type, data) => bytes(be32(data.length), type, data, [0, 0, 0, 0]);
const png = (...chunks) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ...chunks, pngChunk('IEND', new Uint8Array(0)));
const jpegSeg = (marker, data) => bytes([0xff, marker], be16(data.length + 2), data);
const jpeg = (...segs) => bytes([0xff, 0xd8], ...segs, [0xff, 0xd9]);

async function deflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function c2paBox({ generator, sourceType, org }) {
  const label = bytes('c2pa', [0]);
  const jumd = bytes(be32(8 + 16 + 1 + label.length), 'jumd', 'c2pa', new Uint8Array(12), [0x03], label);
  const gen = enc.encode(generator);
  const payload = bytes(
    [0x6f], 'claim_generator', [0x60 + gen.length], gen,
    `http://cv.iptc.org/newscodes/digitalsourcetype/${sourceType}`,
    'c2pa.created',
    [0x06, 0x03, 0x55, 0x04, 0x0a, 0x0c, org.length], org,
  );
  return bytes(be32(8 + jumd.length + payload.length), 'jumb', jumd, payload);
}

function tiff(entries) {
  // Little-endian TIFF with ASCII entries only; values stored after the IFD.
  const head = 8, ifdSize = 2 + entries.length * 12 + 4;
  let dataOff = head + ifdSize;
  const ifd = [...be16(0).reverse()];
  ifd[0] = entries.length & 255; ifd[1] = entries.length >> 8;
  const data = [];
  for (const [tag, str] of entries) {
    const v = [...enc.encode(str), 0];
    ifd.push(tag & 255, tag >> 8, 2, 0, ...le32(v.length));
    if (v.length <= 4) { while (v.length < 4) v.push(0); ifd.push(...v); }
    else { ifd.push(...le32(dataOff)); data.push(...v); dataOff += v.length; }
  }
  ifd.push(0, 0, 0, 0);
  return bytes('II', [42, 0], le32(8), ifd, data);
}

// ---------------------------------------------------------------- tests

test('PNG with Automatic1111 parameters → AI', async () => {
  const params = 'a castle on a hill\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 1234';
  const md = await extractMetadata(png(pngChunk('tEXt', bytes('parameters', [0], params))));
  assert.equal(md.format, 'png');
  const r = evaluate(md);
  assert.equal(r.verdict, 'ai');
  assert.match(r.signals[0].label, /Stable Diffusion/);
});

test('PNG with compressed (zTXt) ComfyUI workflow → AI', async () => {
  const wf = JSON.stringify({ 3: { class_type: 'KSampler', inputs: { steps: 20 } } });
  const md = await extractMetadata(png(pngChunk('zTXt', bytes('prompt', [0, 0], await deflate(enc.encode(wf))))));
  assert.match(md.text.prompt, /KSampler/);
  assert.equal(evaluate(md).verdict, 'ai');
});

test('JPEG with IPTC trainedAlgorithmicMedia + "Made with Google AI" credit → AI', async () => {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description
    photoshop:Credit="Made with Google AI"
    Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></rdf:RDF></x:xmpmeta>`;
  const md = await extractMetadata(jpeg(jpegSeg(0xe1, bytes('http://ns.adobe.com/xap/1.0/', [0], enc.encode(xmp)))));
  assert.deepEqual(md.xmpFields.sourceTypes, ['trainedAlgorithmicMedia']);
  assert.equal(md.xmpFields.Credit, 'Made with Google AI');
  const r = evaluate(md);
  assert.equal(r.verdict, 'ai');
  assert.ok(r.score >= 0.95);
});

test('JPEG with C2PA manifest in APP11 → AI, generator + signer extracted', async () => {
  const box = c2paBox({ generator: 'ChatGPT', sourceType: 'trainedAlgorithmicMedia', org: 'OpenAI' });
  const md = await extractMetadata(jpeg(jpegSeg(0xeb, bytes('JP', [0, 1], be32(1), box))));
  assert.ok(md.c2pa);
  assert.equal(md.c2pa.claimGenerator, 'ChatGPT');
  assert.deepEqual(md.c2pa.certOrganizations, ['OpenAI']);
  assert.deepEqual(md.c2pa.actions, ['c2pa.created']);
  assert.equal(evaluate(md).verdict, 'ai');
});

test('C2PA composite (generative fill) → AI-edited', async () => {
  const box = c2paBox({ generator: 'Adobe Photoshop', sourceType: 'compositeWithTrainedAlgorithmicMedia', org: 'Adobe Inc.' });
  const md = await extractMetadata(jpeg(jpegSeg(0xeb, bytes('JP', [0, 1], be32(1), box))));
  assert.equal(evaluate(md).verdict, 'ai-edited');
});

test('C2PA camera capture → not flagged', async () => {
  const box = c2paBox({ generator: 'Leica Camera', sourceType: 'digitalCapture', org: 'Leica Camera AG' });
  const md = await extractMetadata(jpeg(jpegSeg(0xeb, bytes('JP', [0, 1], be32(1), box))));
  const r = evaluate(md);
  assert.equal(r.verdict, 'captured');
  assert.equal(r.score, 0);
});

test('Camera JPEG with ordinary EXIF → no AI signals', async () => {
  const exif = tiff([[0x010f, 'Canon'], [0x0110, 'Canon EOS R5'], [0x0131, 'Adobe Lightroom Classic 13.0']]);
  const md = await extractMetadata(jpeg(jpegSeg(0xe1, bytes('Exif', [0, 0], exif))));
  assert.equal(md.exif.Make, 'Canon');
  assert.equal(md.exif.Software, 'Adobe Lightroom Classic 13.0');
  assert.equal(evaluate(md).verdict, 'none');
});

test('EXIF Software naming a generator → AI', async () => {
  const md = await extractMetadata(jpeg(jpegSeg(0xe1, bytes('Exif', [0, 0], tiff([[0x0131, 'Midjourney']])))));
  const r = evaluate(md);
  assert.equal(r.verdict, 'ai');
  assert.match(r.signals[0].label, /Midjourney named in EXIF Software/i);
});

test('Artist/description mentioning AI vendors is NOT treated as a generator', async () => {
  const exif = tiff([[0x013b, 'Sora Tanaka'], [0x010e, 'Photo of the OpenAI office in San Francisco']]);
  const md = await extractMetadata(jpeg(jpegSeg(0xe1, bytes('Exif', [0, 0], exif))));
  assert.equal(evaluate(md).verdict, 'none');
});

test('WebP with XMP chunk → AI', async () => {
  const xmp = enc.encode('<x:xmpmeta><Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType></x:xmpmeta>');
  const chunk = bytes('XMP ', le32(xmp.length), xmp, xmp.length & 1 ? [0] : []);
  const body = bytes('WEBP', chunk);
  const md = await extractMetadata(bytes('RIFF', le32(body.length), body));
  assert.equal(md.format, 'webp');
  assert.equal(evaluate(md).verdict, 'ai');
});

test('MP4 fragment with C2PA (byte scan) → AI', async () => {
  const box = c2paBox({ generator: 'Sora', sourceType: 'trainedAlgorithmicMedia', org: 'OpenAI' });
  const ftyp = bytes(be32(16), 'ftyp', 'isom', be32(0));
  const uuid = bytes(be32(8 + 16 + box.length), 'uuid', new Uint8Array(16), box);
  const md = await extractMetadata(bytes(ftyp, uuid, new Uint8Array(1000)), { partial: true });
  assert.equal(md.format, 'mp4');
  assert.equal(md.c2pa?.claimGenerator, 'Sora');
  assert.equal(evaluate(md).verdict, 'ai');
});

test('Garbage / truncated input never throws', async () => {
  for (const b of [new Uint8Array(0), Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0xff), png().subarray(0, 12), crypto.getRandomValues(new Uint8Array(4096))]) {
    const md = await extractMetadata(b);
    assert.ok(['none', 'captured', 'uncertain', 'likely-ai', 'ai', 'ai-edited'].includes(evaluate(md).verdict));
  }
});

// ---------------------------------------------------------------- visual model scoring

const noMeta = () => extractMetadata(new Uint8Array(16));
const clf = (score) => ({ status: 'ok', score, model: 'test', variant: 'uint8', backend: 'wasm', inferenceMs: 5 });

test('Classifier alone can at most say "likely AI", and only above 0.9', async () => {
  const md = await noMeta();
  assert.equal(evaluate(md, clf(0.99)).verdict, 'likely-ai');
  assert.equal(evaluate(md, clf(0.99)).score, 0.99);
  assert.equal(evaluate(md, clf(0.8)).verdict, 'uncertain');
  assert.equal(evaluate(md, clf(0.3)).verdict, 'none');
});

test('Classifier skipped/error results are ignored', async () => {
  const md = await noMeta();
  assert.equal(evaluate(md, { status: 'error', reason: 'x' }).verdict, 'none');
  assert.equal(evaluate(md, { status: 'skipped', reason: 'x' }).signals.length, 0);
});

test('Classifier corroborates weaker metadata evidence', async () => {
  const md = await extractMetadata(png(pngChunk('tEXt', bytes('Title', [0], 'AI generated image'))));
  assert.equal(evaluate(md).verdict, 'likely-ai');            // phrase alone: 0.75
  assert.equal(evaluate(md, clf(0.95)).verdict, 'ai');        // combined via noisy-OR
});

// ---------------------------------------------------------------- screenshot / graphic detection

import { looksLikeGraphic } from '../lib/preprocess.js';

test('Flat UI-like image is treated as a graphic; noisy photo-like image is not', () => {
  const S = 256, ui = new Uint8ClampedArray(S * S * 4), photo = new Uint8ClampedArray(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const y = Math.floor(i / S);
    // UI: white background with grey "message bubbles" and a few dark text rows
    const v = y % 40 < 30 ? 240 : y % 40 < 34 ? 30 : 255;
    ui.set([v, v, v, 255], i * 4);
    // Photo-like: smooth gradient + noise
    const n = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    photo.set([100 + (i % S) / 3 + n * 20, 80 + y / 4 + n * 20, 120 + n * 30, 255], i * 4);
  }
  assert.equal(looksLikeGraphic(ui), true);
  assert.equal(looksLikeGraphic(photo), false);
});
