// Production build. Copies just the files the extension needs into a folder you
// can load unpacked, and zips it for the stores:
//
//   dist/hikaku-<version>/            Chrome / Edge   → dist/hikaku-<version>-chrome.zip
//   dist/hikaku-<version>-firefox/    Firefox         → dist/hikaku-<version>-firefox.zip
//
// Usage: npm run build                       # both browsers
//        npm run build -- --target=chrome    # or firefox
//        npm run build -- --offline          # bundle the model too (~620 MB, no download at runtime)
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { MODEL, SECONDARY_MODEL, localPath } from '../lib/model-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const offline = process.argv.includes('--offline');
const target = process.argv.find((a) => a.startsWith('--target='))?.slice(9) || 'all';
const targets = target === 'all' ? ['chrome', 'firefox'] : [target];
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const COMMON = [
  'LICENSE',
  'NOTICE',
  'third_party/community-forensics/LICENSE',
  'background.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
  'content',
  'popup',
  'vendor/ort',
  'lib/metadata.js',
  'lib/score.js',
  'lib/runner.js',
  'lib/model-config.js',
  'lib/preprocess.js',
  'lib/work-queue.js',
];

// Firefox differences:
// - MV3 background is a page with scripts, not a service worker. It can run the
//   model itself, so there's no offscreen document (Firefox doesn't have them).
// - The cross-origin-isolation keys and minimum_chrome_version are Chrome-only.
// - AMO requires an add-on ID and a data collection declaration (we collect nothing).
function firefoxManifest(m) {
  const f = structuredClone(m);
  f.background = { scripts: [m.background.service_worker], type: 'module' };
  f.permissions = m.permissions.filter((p) => p !== 'offscreen');
  delete f.cross_origin_embedder_policy;
  delete f.cross_origin_opener_policy;
  delete f.minimum_chrome_version;
  f.browser_specific_settings = {
    gecko: {
      id: 'hikaku@hikaku.io',
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  };
  return f;
}

// Preconditions. Always refresh vendor/ so the shipped runtime (and its license) match package.json.
execFileSync(process.execPath, [join(ROOT, 'scripts/setup.mjs')], { stdio: 'inherit' });
if (!existsSync(join(ROOT, 'icons/icon128.png'))) execFileSync(process.execPath, [join(ROOT, 'scripts/make-icons.mjs')], { stdio: 'inherit' });
const extra = [];
if (offline) {
  execFileSync(process.execPath, [join(ROOT, 'scripts/setup.mjs'), '--model=all'], { stdio: 'inherit' });
  for (const v of Object.keys(MODEL.variants)) extra.push(localPath(v));
  extra.push(localPath('int8', SECONDARY_MODEL));
}

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
// Zipping: Windows ships bsdtar, which writes real zips. Elsewhere use zip(1).
// GNU tar (Linux, Git Bash) ignores the .zip name and writes a plain tar file.
const winTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const zipFolder = (folder, zipName) => {
  if (process.platform === 'win32' && existsSync(winTar)) execFileSync(winTar, ['-a', '-c', '-f', zipName, '-C', folder, '.'], { cwd: DIST, stdio: 'inherit' });
  else execFileSync('zip', ['-q', '-r', '-X', join('..', zipName), '.'], { cwd: join(DIST, folder), stdio: 'inherit' });
};

for (const browser of targets) {
  const m = browser === 'firefox' ? firefoxManifest(manifest) : manifest;
  const folder = `hikaku-${manifest.version}${browser === 'firefox' ? '-firefox' : ''}${offline ? '-offline' : ''}`;
  const OUT = join(DIST, folder);
  const include = [...COMMON, ...extra, ...(browser === 'chrome' ? ['offscreen', 'lib/classifier.js'] : [])];

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const p of include) cpSync(join(ROOT, p), join(OUT, p), { recursive: true });
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  // Firefox runs the model in its background page, so it gets the in-process classifier.
  if (browser === 'firefox') cpSync(join(ROOT, 'lib/classifier-firefox.js'), join(OUT, 'lib/classifier.js'));

  // Every file the manifest points at must be in the package.
  const referenced = [
    ...(m.background.scripts || [m.background.service_worker]),
    m.action.default_popup,
    ...m.content_scripts.flatMap((c) => c.js),
    ...Object.values(m.icons || {}),
    ...Object.values(m.action.default_icon || {}),
  ];
  for (const f of referenced) if (!existsSync(join(OUT, f))) throw new Error(`${browser}: manifest references missing file ${f}`);

  const files = walk(OUT);
  const total = files.reduce((n, f) => n + statSync(f).size, 0);
  const zipName = `hikaku-${manifest.version}-${browser}${offline ? '-offline' : ''}.zip`;
  rmSync(join(DIST, zipName), { force: true });
  zipFolder(folder, zipName);
  console.log(`✓ ${browser.padEnd(7)} ${files.length} files, ${mb(total)} → ${relative(ROOT, OUT)}/  (${zipName}, ${mb(statSync(join(DIST, zipName)).size)})`);
}
console.log(offline ? '  model bundled, works without network access to Hugging Face'
                    : '  model downloads from Hugging Face on first use (use --offline to bundle it)');
