// Pure preprocessing helpers (no DOM), shared by the browser runner and Node tests.
import { MODEL } from './model-config.js';

/**
 * Turns RGBA pixels (already resized to MODEL.size²) into normalized float32 CHW
 * tensor data. Transparent pixels are composited onto white first.
 */
export function rgbaToCHW(rgba, size = MODEL.size) {
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  const [m0, m1, m2] = MODEL.mean;
  const [s0, s1, s2] = MODEL.std;
  for (let i = 0; i < plane; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const r = (rgba[i * 4] * a + 255 * (1 - a)) / 255;
    const g = (rgba[i * 4 + 1] * a + 255 * (1 - a)) / 255;
    const b = (rgba[i * 4 + 2] * a + 255 * (1 - a)) / 255;
    out[i] = (r - m0) / s0;
    out[plane + i] = (g - m1) / s1;
    out[2 * plane + i] = (b - m2) / s2;
  }
  return out;
}

/**
 * Screenshots, chat captures, UI, slides and flat graphics are outside what the
 * photo-vs-generated model was trained on, so its scores on them are noise
 * (often "AI"). We spot them from the resized RGBA: a handful of colors cover
 * most of the image AND most neighbouring pixels are identical.
 * The thresholds come from chat screenshots (0.92+/0.88+) versus photos and AI
 * images (max 0.73 / 0.81, never both high). See scripts/eval-model.mjs.
 */
export const GRAPHIC = { top8: 0.85, flat: 0.75 };
export function graphicStats(rgba, width = MODEL.size) {
  const n = rgba.length / 4;
  const counts = new Map();
  let flat = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const k = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (i % width !== width - 1) {
      const j = o + 4;
      if (Math.abs(rgba[o] - rgba[j]) + Math.abs(rgba[o + 1] - rgba[j + 1]) + Math.abs(rgba[o + 2] - rgba[j + 2]) <= 3) flat++;
    }
  }
  const top8 = [...counts.values()].sort((a, b) => b - a).slice(0, 8).reduce((a, b) => a + b, 0) / n;
  return { top8, flat: flat / n };
}
export const looksLikeGraphic = (rgba, width) => {
  const s = graphicStats(rgba, width);
  return s.top8 >= GRAPHIC.top8 && s.flat >= GRAPHIC.flat;
};

/** Softmax over the logits, returning the probability of the "artificial" class. */
export function aiProbability(logits) {
  const arr = Array.from(logits);
  const max = Math.max(...arr);
  const exps = arr.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps[MODEL.aiIndex] / sum;
}

/**
 * Area-averaging resize of RGBA pixels (stretch, no crop). This is for Node,
 * which has no canvas. In the browser we use canvas resampling instead.
 */
export function resizeRGBA(src, sw, sh, dw = MODEL.size, dh = MODEL.size) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) {
        for (let xx = x0; xx < x1 && xx < sw; xx++) {
          const i = (yy * sw + xx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}
