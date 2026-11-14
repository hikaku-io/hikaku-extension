// Score local image files exactly like the extension would (Node, WASM, uint8).
// Usage: node scripts/score-file.mjs <image.jpg|png> [...]
import * as ort from 'onnxruntime-web';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, localPath } from '../lib/model-config.js';
import { rgbaToCHW, aiProbability, resizeRGBA, graphicStats, looksLikeGraphic } from '../lib/preprocess.js';
import { extractMetadata } from '../lib/metadata.js';
import { evaluate } from '../lib/score.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const session = await ort.InferenceSession.create(readFileSync(join(ROOT, localPath('uint8'))), { executionProviders: ['wasm'] });
for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f);
  const img = buf[0] === 0xff ? jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 }) : PNG.sync.read(buf);
  const rgba = resizeRGBA(img.data, img.width, img.height);
  const g = graphicStats(rgba);
  let classifier;
  if (looksLikeGraphic(rgba)) classifier = { status: 'skipped', reason: 'screenshot/graphic' };
  else {
    const out = await session.run({ [MODEL.inputName]: new ort.Tensor('float32', rgbaToCHW(rgba), [1, 3, MODEL.size, MODEL.size]) });
    classifier = { status: 'ok', score: aiProbability(out[MODEL.outputName].data) };
  }
  const r = evaluate(await extractMetadata(buf), classifier);
  const p = classifier.status === 'ok' ? `P(AI)=${classifier.score.toFixed(3)}` : `model skipped (${classifier.reason})`;
  console.log(`${basename(f)}: ${img.width}x${img.height} graphic[top8=${g.top8.toFixed(2)} flat=${g.flat.toFixed(2)}] ${p} → ${r.verdict}`);
}
