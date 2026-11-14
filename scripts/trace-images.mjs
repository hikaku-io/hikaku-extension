// Diagnose local files or URLs through the actual browser extension, including
// its canvas preprocessing, backend choice, metadata checks, and optional model.
// npm run trace -- [--wasm] [--second-opinion] image.png https://example/image.jpg
import puppeteer from 'puppeteer';
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!inputs.length) { console.error('Usage: npm run trace -- [--wasm] [--second-opinion] image.png [URL …]'); process.exit(1); }
const secondOpinion = process.argv.includes('--second-opinion');
const locals = inputs.map((input) => /^https?:\/\//.test(input) ? null : resolve(input));
for (const file of locals.filter(Boolean)) if (!statSync(file).isFile()) throw new Error(`Not a file: ${file}`);
const server = http.createServer((req, res) => {
  const match = req.url.match(/^\/image\/(\d+)$/), file = match && locals[Number(match[1])];
  if (!file) { res.writeHead(404); return res.end(); }
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-length', statSync(file).size);
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  const ext = process.env.EXT_DIR || ROOT;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 0, args: [
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--enable-unsafe-webgpu',
    ...(process.argv.includes('--wasm') ? ['--disable-webgpu'] : []),
  ] });
  const worker = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const id = new URL(worker.url()).host, page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/popup/popup.html`);
  for (const [i, input] of inputs.entries()) {
    const url = locals[i] ? `http://127.0.0.1:${server.address().port}/image/${i}` : input;
    const result = await page.evaluate(({ url, secondOpinion }) => chrome.runtime.sendMessage({ type: 'analyze', url, kind: 'image', secondOpinion }), { url, secondOpinion });
    const { classifier, verdict, evidence, error, ms } = result;
    console.log(JSON.stringify({ input, verdict, evidence, ms, error,
      metadataSignals: result.signals?.filter((s) => !s.source.includes('classifier')).map((s) => s.label), classifier,
    }));
  }
} finally { await browser?.close(); server.close(); }
