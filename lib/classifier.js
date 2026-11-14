// Background side of the visual classifier (Chrome / Edge).
//
// The model runs in an offscreen document, because MV3 service workers can't
// load ONNX Runtime; we talk to it with messages. Firefox gets
// lib/classifier-firefox.js instead (the build swaps it in), which runs the
// model directly in its background page.

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Run the on-device AI-image classification model (ONNX Runtime, WebGPU/WASM).',
  }).finally(() => { creating = null; });
  await creating;
}

// The document can exist before its module script has registered a listener
// (it's still importing ONNX Runtime), so on "no receiver" we retry for a bit.
async function sendToOffscreen(msg, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 50; ; delay = Math.min(delay * 2, 500)) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    } catch (err) {
      if (!/Receiving end does not exist/i.test(String(err?.message)) || Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** @returns {Promise<{status:'ok', score:number, model:string, variant:string, backend:string, inferenceMs:number} | {status:'skipped'|'error', reason:string}>} */
export async function classifyImage(url) {
  await ensureOffscreen();
  const r = await sendToOffscreen({ type: 'classify', url });
  return r || { status: 'error', reason: 'No response from model runner' };
}

export async function modelStatus() {
  if (!(await chrome.offscreen.hasDocument())) return { state: 'idle' };
  return (await sendToOffscreen({ type: 'status' }, 2000)) || { state: 'idle' };
}

export async function warmupModel() {
  await ensureOffscreen();
  return sendToOffscreen({ type: 'warmup' });
}
