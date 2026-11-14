import { extractMetadata } from './lib/metadata.js';
import { evaluate } from './lib/score.js';
import { classifyImage, modelStatus, warmupModel } from './lib/classifier.js';

// ------------------------------------------------------------ settings

const settings = { visualModel: true };
const settingsReady = chrome.storage.sync.get(settings).then((s) => Object.assign(settings, s)).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.visualModel) return;
  settings.visualModel = changes.visualModel.newValue;
  cache.clear(); // results depend on whether the model ran
});

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const VIDEO_CHUNK = 3 * 1024 * 1024; // head and tail ranges; C2PA, XMP and moov usually sit at one end or the other
const MAX_CONCURRENT = 4;
const CACHE_MAX = 800;

// ------------------------------------------------------------ cache + queue

const cache = new Map(); // key -> Promise<result>
const queue = [];
let active = 0;

function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn().then(resolve, reject).finally(() => { active--; pump(); });
  }
}

function analyze(url, kind = 'image') {
  const key = `${kind}:${url}`;
  if (cache.has(key)) {
    const p = cache.get(key);
    cache.delete(key);
    cache.set(key, p); // LRU bump
    return p;
  }
  const p = schedule(() => analyzeNow(url, kind)).catch((err) => ({
    url, kind, verdict: 'error', score: 0, signals: [], error: String(err?.message || err),
  }));
  cache.set(key, p);
  // Don't cache transient failures (model still loading, a network blip), or they'd stick for the whole session.
  p.then((r) => { if (r.verdict === 'error' || r.classifier?.status === 'error') cache.delete(key); });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}

// ------------------------------------------------------------ fetching

async function readCapped(res, cap) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, cap));
  let o = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - o);
    out.set(c.subarray(0, n), o);
    o += n;
    if (o >= out.length) break;
  }
  return out;
}

async function fetchImage(url) {
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length')) || 0;
  const bytes = await readCapped(res, MAX_IMAGE_BYTES);
  return { bytes, mime: res.headers.get('content-type') || '', size: len || bytes.length, partial: len > bytes.length };
}

async function fetchVideo(url) {
  const head = await fetch(url, { credentials: 'include', headers: { Range: `bytes=0-${VIDEO_CHUNK - 1}` } });
  if (!head.ok) throw new Error(`HTTP ${head.status}`);
  const mime = head.headers.get('content-type') || '';
  const headBytes = await readCapped(head, VIDEO_CHUNK);

  // Content-Range: bytes 0-N/TOTAL
  const total = Number((head.headers.get('content-range') || '').split('/')[1]) || 0;
  if (head.status !== 206 || !total || total <= VIDEO_CHUNK) {
    return { bytes: headBytes, mime, size: total || headBytes.length, partial: head.status !== 206 && !!total };
  }
  let tailBytes = new Uint8Array(0);
  try {
    const tail = await fetch(url, { credentials: 'include', headers: { Range: `bytes=-${VIDEO_CHUNK}` } });
    if (tail.status === 206) tailBytes = await readCapped(tail, VIDEO_CHUNK);
  } catch { /* head alone is still useful */ }
  const bytes = new Uint8Array(headBytes.length + tailBytes.length);
  bytes.set(headBytes);
  bytes.set(tailBytes, headBytes.length);
  return { bytes, mime, size: total, partial: true };
}

async function analyzeNow(url, kind) {
  if (url.startsWith('blob:')) {
    throw new Error(kind === 'video'
      ? 'Streamed video: the file itself cannot be downloaded for a metadata check'
      : 'blob: URLs cannot be fetched by the extension');
  }
  const t0 = performance.now();
  const { bytes, mime, size, partial } = kind === 'video' ? await fetchVideo(url) : await fetchImage(url);
  const metadata = await extractMetadata(bytes, { partial });
  metadata.mime = mime;
  metadata.size = size;

  // Tier 2: the visual model. We skip it when provenance already settled things.
  await settingsReady;
  const fromMetadata = evaluate(metadata);
  let classifier;
  if (kind !== 'image') classifier = { status: 'skipped', reason: 'video frames are sampled separately' };
  else if (!settings.visualModel) classifier = { status: 'off', reason: 'disabled in settings' };
  else if (fromMetadata.verdict === 'ai' || fromMetadata.verdict === 'captured') classifier = { status: 'skipped', reason: 'provenance metadata is conclusive' };
  else if (/svg/.test(mime)) classifier = { status: 'skipped', reason: 'unsupported image type' };
  else classifier = await classifyImage(url).catch((err) => ({ status: 'error', reason: String(err?.message || err) }));

  const result = evaluate(metadata, classifier);
  return { url, kind, ...result, metadata, classifier, ms: Math.round(performance.now() - t0) };
}

// ------------------------------------------------------------ video frames

/** Classify sampled frames (data: URLs) and combine with any container metadata. */
async function analyzeFrames(url, frames, times = []) {
  await settingsReady;
  if (!settings.visualModel) return null;
  const t0 = performance.now();
  const ok = [], okTimes = [];
  for (const [i, f] of frames.slice(0, 5).entries()) {
    const r = await classifyImage(f).catch(() => null);
    if (r?.status === 'ok') { ok.push(r); okTimes.push(times[i]); }
  }
  if (!ok.length) return null;
  const scores = ok.map((r) => r.score);
  // Median, not mean or max: one bad frame (blurry keyframe, a transition, an overlay) shouldn't swing the verdict.
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const classifier = {
    status: 'ok',
    score: median,
    perFrame: scores,
    frameTimes: okTimes.every((t) => typeof t === 'number') ? okTimes : undefined,
    frames: ok.length,
    model: ok[0].model,
    variant: ok[0].variant,
    backend: ok[0].backend,
    inferenceMs: Math.round(ok.reduce((a, r) => a + r.inferenceMs, 0) / ok.length),
  };
  const base = url && !url.startsWith('blob:') ? await cache.get(`video:${url}`) : null;
  const metadata = base?.metadata || { ...(await extractMetadata(new Uint8Array(0))), format: 'stream' };
  return { url, kind: 'video', ...evaluate(metadata, classifier), metadata, classifier, ms: Math.round(performance.now() - t0) };
}

// Screenshot fallback for cross-origin video. Chrome only allows about 2 captures a second.
let captureChain = Promise.resolve();
let lastCapture = 0;
function captureFrame(windowId, rect, dpr) {
  const job = captureChain.then(async () => {
    const wait = lastCapture + 650 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCapture = Date.now();
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 92 });
    const bmp = await createImageBitmap(await (await fetch(shot)).blob(),
      Math.round(rect.x * dpr), Math.round(rect.y * dpr), Math.round(rect.w * dpr), Math.round(rect.h * dpr));
    const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(bin)}`;
  });
  captureChain = job.catch(() => {});
  return job;
}

// ------------------------------------------------------------ messaging

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // handled by the offscreen document
  if (msg?.type === 'analyze' && typeof msg.url === 'string') {
    analyze(msg.url, msg.kind === 'video' ? 'video' : 'image').then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'analyzeFrames' && Array.isArray(msg.frames)) {
    analyzeFrames(msg.url, msg.frames, Array.isArray(msg.times) ? msg.times : []).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg?.type === 'captureFrame' && _sender.tab) {
    captureFrame(_sender.tab.windowId, msg.rect, msg.dpr || 1)
      .then((dataUrl) => sendResponse({ dataUrl }), (err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'modelStatus') {
    modelStatus().then(sendResponse, () => sendResponse({ state: 'idle' }));
    return true;
  }
  if (msg?.type === 'modelWarmup') {
    warmupModel().then(sendResponse, (err) => sendResponse({ state: 'error', error: String(err?.message || err) }));
    return true;
  }
  return false;
});

// ------------------------------------------------------------ context menu

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'inspect-ai',
      title: 'Inspect for AI generation',
      contexts: ['image', 'video'],
    });
  });
});

async function sendToFrame(tabId, frameId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId });
  } catch {
    // No content script yet (tab was open before install, or it's a restricted frame): inject it and retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content/content.js'] });
      return await chrome.tabs.sendMessage(tabId, msg, { frameId });
    } catch {
      return undefined;
    }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'inspect-ai' || !tab?.id || !info.srcUrl) return;
  const frameId = info.frameId ?? 0;
  const kind = info.mediaType === 'video' ? 'video' : 'image';
  // Streamed video has no file to download. The page's content script grabs
  // frames straight from the player instead and opens the panel itself.
  if (kind === 'video' && info.srcUrl.startsWith('blob:')) {
    await sendToFrame(tab.id, frameId, { type: 'inspectVideo', url: info.srcUrl });
    return;
  }
  await sendToFrame(tab.id, frameId, { type: 'showDetails', url: info.srcUrl, kind, loading: true });
  const result = await analyze(info.srcUrl, kind);
  await sendToFrame(tab.id, frameId, { type: 'showDetails', url: info.srcUrl, kind, result });
});
