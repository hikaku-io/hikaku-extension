// Runs the ONNX model: loading (bundled, cached or downloaded once), picking
// WebGPU or WASM, and scoring images and animation frames.
//
// Where it runs depends on the browser. In Chrome it lives in the offscreen
// document (offscreen/offscreen.js), because MV3 service workers can't load it.
// Firefox has no offscreen documents but its background page can run it
// directly, so lib/classifier.js imports this module there.
import * as ort from '../vendor/ort/ort.webgpu.min.mjs';
import { MODEL, remoteUrl, localPath } from './model-config.js';
import { rgbaToCHW, aiProbability, looksLikeGraphic } from './preprocess.js';

ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/ort/');
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

const CACHE_NAME = 'ai-lens-models-v1'; // internal name, kept from before the rename so people don't have to re-download the model
let status = { state: 'idle', progress: 0, variant: null, backend: null, error: null };
let sessionPromise = null;
let chain = Promise.resolve(); // run one inference at a time

// ------------------------------------------------------------ model loading

async function pickBackend() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter?.features.has('shader-f16')) return { variant: 'fp16', backend: 'webgpu' };
  } catch { /* no WebGPU */ }
  return { variant: 'uint8', backend: 'wasm' };
}

async function readWithProgress(res) {
  const total = Number(res.headers.get('content-length')) || MODEL.variants[status.variant].approxMB * 1e6;
  const reader = res.body.getReader();
  const chunks = [];
  let done = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.length;
    status.progress = Math.min(0.99, done / total);
  }
  const out = new Uint8Array(done);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function loadModelBytes(variant) {
  // 1. Bundled with the extension (npm run setup -- --model=…)
  try {
    const r = await fetch(chrome.runtime.getURL(localPath(variant)));
    if (r.ok) { status.source = 'bundled'; return new Uint8Array(await r.arrayBuffer()); }
  } catch { /* not bundled */ }

  // 2. Previously downloaded
  const url = remoteUrl(variant);
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) { status.source = 'cache'; return new Uint8Array(await hit.arrayBuffer()); }

  // 3. Download once from Hugging Face (weights are data, not code, so MV3 is fine with it)
  status.state = 'downloading';
  status.source = 'download';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  const bytes = await readWithProgress(res);
  await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  return bytes;
}

async function createSession({ variant, backend }) {
  status = { state: 'loading', progress: 0, variant, backend, error: null };
  const bytes = await loadModelBytes(variant);
  status.state = 'loading';
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
  });
  // Warm-up run so the first real image doesn't pay for shader compilation and friends.
  const size = MODEL.size;
  await session.run({ [MODEL.inputName]: new ort.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size]) });
  status = { ...status, state: 'ready', progress: 1, loadMs: Math.round(performance.now() - t0) };
  return session;
}

function getSession() {
  sessionPromise ??= (async () => {
    const choice = await pickBackend();
    try {
      return await createSession(choice);
    } catch (err) {
      if (choice.backend !== 'webgpu') throw err;
      console.warn('WebGPU session failed, falling back to WASM:', err);
      return await createSession({ variant: 'uint8', backend: 'wasm' });
    }
  })().catch((err) => {
    sessionPromise = null;
    status = { ...status, state: 'error', error: String(err?.message || err) };
    throw err;
  });
  return sessionPromise;
}

// ------------------------------------------------------------ inference

const MAX_FRAMES = 3; // frames sampled from animated images (GIF / animated WebP)

// Draw an ImageBitmap or VideoFrame into model input, or say why we can't.
function sourceToTensor(source, width, height) {
  if (Math.min(width, height) < MODEL.minSide) return { skipped: `image smaller than ${MODEL.minSide}px` };
  const size = MODEL.size;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size); // transparent GIF/PNG pixels become white
  ctx.drawImage(source, 0, 0, size, size); // stretch, don't crop: the model was trained that way
  const rgba = ctx.getImageData(0, 0, size, size).data;
  if (looksLikeGraphic(rgba, size)) return { skipped: 'looks like a screenshot or flat graphic, and the model gets those wrong a lot' };
  return { data: rgbaToCHW(rgba) };
}

// Servers often mislabel content types; trust the bytes.
function sniffType(b, fallback) {
  const s = String.fromCharCode(...b.subarray(0, 12));
  if (s.startsWith('GIF8')) return 'image/gif';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'image/webp';
  if (s.startsWith('\x89PNG')) return 'image/png';
  return fallback || '';
}

/** Up to MAX_FRAMES frames spread across an animation, or null if not animated / unsupported. */
async function decodeAnimationFrames(buf, type) {
  if (typeof ImageDecoder === 'undefined' || !/^image\/(gif|webp|png)$/.test(type)) return null;
  if (!(await ImageDecoder.isTypeSupported(type))) return null;
  const dec = new ImageDecoder({ data: buf, type });
  try {
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    if (!track?.animated) return null;
    await dec.completed; // frameCount is final once fully parsed
    const n = track.frameCount;
    if (n < 2) return null;
    const indices = [...new Set([0, Math.floor(n / 2), n - 1])].slice(0, MAX_FRAMES);
    const out = [];
    for (const frameIndex of indices) {
      const { image } = await dec.decode({ frameIndex });
      out.push(sourceToTensor(image, image.displayWidth, image.displayHeight));
      image.close();
    }
    return { preps: out, frameCount: n, indices };
  } finally {
    dec.close();
  }
}

function runModel(session, data) {
  const size = MODEL.size;
  const run = chain.then(async () => {
    const t0 = performance.now();
    const out = await session.run({ [MODEL.inputName]: new ort.Tensor('float32', data, [1, 3, size, size]) });
    return { score: aiProbability(out[MODEL.outputName].data), ms: performance.now() - t0 };
  });
  chain = run.catch(() => {});
  return run;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export async function classify(url) {
  const session = await getSession();
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const type = sniffType(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)), res.headers.get('content-type')?.split(';')[0]);

  // Animated GIF or WebP gets several frames, everything else gets one.
  const anim = await decodeAnimationFrames(buf, type).catch(() => null);
  let preps;
  if (anim) preps = anim.preps.map((p, i) => ({ ...p, frameIndex: anim.indices[i] }));
  else {
    const bitmap = await createImageBitmap(new Blob([buf], { type }));
    preps = [sourceToTensor(bitmap, bitmap.width, bitmap.height)];
    bitmap.close();
  }
  const usable = preps.filter((p) => p.data);
  if (!usable.length) return { status: 'skipped', reason: preps[0]?.skipped || 'no usable frames' };

  const runs = [];
  for (const p of usable) runs.push(await runModel(session, p.data));
  const scores = runs.map((r) => r.score);
  const base = {
    status: 'ok',
    model: MODEL.name,
    variant: status.variant,
    backend: status.backend,
    inferenceMs: Math.round(runs.reduce((a, r) => a + r.ms, 0) / runs.length),
  };
  if (!anim) return { ...base, score: scores[0] };
  return { ...base, score: median(scores), frames: scores.length, perFrame: scores, frameIndices: usable.map((p) => p.frameIndex), animated: true, frameCount: anim.frameCount };
}

export const getStatus = () => status;
export const warmup = () => getSession().then(() => status, () => status);
