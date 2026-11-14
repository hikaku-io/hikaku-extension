// Firefox version of lib/classifier.js (the build swaps it in).
//
// Firefox has no offscreen documents, but its MV3 background is a real page that
// can run ONNX Runtime itself, so the model runner lives right here. Same API
// as the Chrome version.
import { classify, getStatus, warmup } from './runner.js';

let used = false;

export async function classifyImage(url, inspect = false, secondOpinion = false) {
  used = true;
  return classify(url, inspect, secondOpinion).catch((err) => ({ status: 'error', reason: String(err?.message || err) }));
}

export async function modelStatus() {
  return used ? getStatus() : { state: 'idle' };
}

export async function warmupModel() {
  used = true;
  return warmup();
}
