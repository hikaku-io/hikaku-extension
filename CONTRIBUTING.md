# Contributing to Hikaku

Thanks for helping out. Hikaku is a browser extension that flags AI-generated images and video on the user's own device. Bug fixes, new detection signals, model evaluations, docs and detection reports are all welcome.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

These are what make Hikaku worth trusting, so a PR that breaks one won't be merged.

1. **Privacy first.** Nothing the user browses may leave the device. No telemetry, no analytics, no remote APIs for detection.
2. **No remotely hosted code.** Manifest V3 forbids it and we wouldn't want it anyway. Model *weights* can be downloaded (pinned by revision). Code can't.
3. **Precision over recall.** Wrongly flagging a real person's photo does more harm than missing a fake. If you add a signal, tell us how it avoids false positives.
4. **Show your evidence.** Every flag has to be explainable in the details panel: which signal, which source, what value.
5. **License-compatible.** Dependencies and models must allow commercial use and redistribution (Apache-2.0, MIT, BSD and so on). No non-commercial or research-only weights.

## Development setup

Requirements: Node.js ≥ 20 (see `.nvmrc`), Chrome or Edge ≥ 116.

```sh
git clone <repo-url> hikaku && cd hikaku
npm install            # also copies ONNX Runtime into vendor/
```

Open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the repo root. After you change code, hit the reload icon on the extension card and refresh the page you're testing on.

## Project layout

```
manifest.json          MV3 manifest
background.js          service worker: fetching, caching, scoring, context menu, video-frame capture
content/content.js     in-page overlay: observes media, draws border/dot, tooltip, details panel, video sampling
offscreen/             offscreen document hosting the ONNX model (WebGPU, falling back to WASM)
popup/                 toolbar settings UI
lib/metadata.js        C2PA / XMP / IPTC / EXIF / PNG-text extraction (no dependencies)
lib/score.js           signals → verdict (thresholds live here)
lib/preprocess.js      image preprocessing + screenshot/graphic filter
lib/model-config.js    pinned model definition
scripts/               setup, build, evaluation, end-to-end tests
test/                  unit tests (node:test)
docs/                  architecture and model documentation
third_party/           license texts for vendored dependencies
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces talk to each other.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests (metadata parsing, scoring, filters). Fast, no network. |
| `npm run lint` | ESLint. |
| `npm run build` | Production build into `dist/` (+ zip). `-- --offline` bundles model weights. |
| `npm run setup -- --model=uint8` | Download model weights locally (needed for the two commands below). |
| `npm run eval-model -- --n=16` | Score labelled Wikimedia Commons images in Node; prints TPR/FPR per threshold. |
| `npm run e2e` | Loads the extension in Chrome for Testing, runs the whole pipeline and saves screenshots. Use `EXT_DIR=dist/hikaku-x.y.z` to test a build. |
| `node scripts/score-file.mjs <files…>` | Score local images exactly like the extension. |

## Making changes

- **Detection logic** (`lib/metadata.js`, `lib/score.js`, `lib/preprocess.js`): add unit tests in `test/`. If you touch a threshold or a filter, include before/after numbers from `npm run eval-model`.
- **Models**: follow [Adding a model in docs/MODELS.md](docs/MODELS.md#adding-a-model). Pin the revision and document the license and how you evaluated it.
- **UI** (`content/`, `popup/`): attach before/after screenshots in light and dark, keep it usable from the keyboard, and run `npm run e2e`.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `chore:`. Example: `fix(metadata): stop CBOR header byte leaking into source type`.

### Pull request checklist

- [ ] `npm run lint` and `npm test` pass
- [ ] `npm run e2e` passes for UI / pipeline changes
- [ ] New behaviour is covered by tests or eval numbers
- [ ] `CHANGELOG.md` updated under **Unreleased**
- [ ] No new permissions, network calls or dependencies without discussion

## Reporting detection mistakes

Reports of false positives and misses help us more than anything else. Use the **Detection report** issue template and paste what **Copy JSON** gives you in the details panel. Only share images you have the right to share.

## Releasing (maintainers)

1. Bump `version` in **both** `manifest.json` and `package.json`.
2. Move **Unreleased** entries in `CHANGELOG.md` under the new version.
3. Tag and push: `git tag vX.Y.Z && git push --tags`. The release workflow builds the zip and attaches it to a GitHub release.
