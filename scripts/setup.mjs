// Prepares the unpacked extension:
//   1. copies the ONNX Runtime Web files into vendor/ort/ (MV3 forbids loading runtime code remotely)
//   2. optionally downloads model weights into models/ so they ship with the extension
//      (otherwise the extension downloads them from Hugging Face on first use and caches them)
//
// Usage: npm run setup                  # runtime only
//        npm run setup -- --model=uint8 # + bundle 199 MB CPU model
//        npm run setup -- --model=fp16  # + bundle 393 MB GPU model
//        npm run setup -- --model=all
import { copyFileSync, mkdirSync, existsSync, statSync, createWriteStream, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODEL, SECONDARY_MODEL, remoteUrl, localPath } from '../lib/model-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORT_DIST = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const ORT_FILES = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

if (!existsSync(ORT_DIST)) {
  console.error('onnxruntime-web not installed. Run `npm install` first.');
  process.exit(1);
}
const vendor = join(ROOT, 'vendor', 'ort');
mkdirSync(vendor, { recursive: true });
for (const f of ORT_FILES) copyFileSync(join(ORT_DIST, f), join(vendor, f));
// The npm package ships without its license text; MIT requires it to travel with the code.
copyFileSync(join(ROOT, 'third_party', 'onnxruntime-web', 'LICENSE'), join(vendor, 'LICENSE'));
console.log(`✓ ONNX Runtime Web → vendor/ort/ (${ORT_FILES.length} files)`);

const arg = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1];
const variants = arg === 'all' ? [...Object.keys(MODEL.variants), 'secondary'] : arg ? [arg] : [];
for (const name of variants) {
  const model = name === 'secondary' ? SECONDARY_MODEL : MODEL;
  const v = name === 'secondary' ? 'int8' : name;
  if (!model.variants[v]) { console.error(`Unknown model variant "${name}"`); process.exit(1); }
  const dest = join(ROOT, localPath(v, model));
  if (existsSync(dest) && statSync(dest).size > 1e6) { console.log(`✓ ${localPath(v, model)} already present`); continue; }
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`↓ ${name} model (~${model.variants[v].approxMB} MB) from ${model.repo}@${model.revision.slice(0, 7)}`);
  const res = await fetch(remoteUrl(v, model));
  if (!res.ok) { console.error(`Download failed: HTTP ${res.status}`); process.exit(1); }
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0, lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    done += c.length;
    const pct = total ? Math.floor((done / total) * 100) : 0;
    if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write(`  ${pct}%\n`); }
  });
  await pipeline(body, createWriteStream(dest + '.part'));
  renameSync(dest + '.part', dest);
  console.log(`✓ ${localPath(v, model)}`);
}
if (!variants.length) console.log('  (model not bundled, the extension will download it on first use)');
