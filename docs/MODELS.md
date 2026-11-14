# Models

## Current: SwinV2 AI-image detector

| | |
|---|---|
| Purpose | Whole-image "generated vs. real" classification |
| Upstream | [haywoodsloan/ai-image-detector-deploy](https://huggingface.co/haywoodsloan/ai-image-detector-deploy) (SwinV2-base) |
| ONNX export | [SoldadoXara/ai-image-detector-deploy-ONNX](https://huggingface.co/SoldadoXara/ai-image-detector-deploy-ONNX) @ `0df8696b5db0ab5bd72baeab571fec55d65128e7` |
| License | Apache-2.0 |
| Variants | `fp16` (393 MB) on WebGPU with `shader-f16`; `uint8` (199 MB) on WASM |
| Input | 256×256 RGB, stretched (no crop), ImageNet mean/std, transparent → white |
| Output | softmax over `[artificial, real]`; we use P(artificial) |
| Config | [`lib/model-config.js`](../lib/model-config.js) |

### Thresholds (`lib/score.js` → `CLASSIFIER`)

| P(AI) | Verdict when the model is the only signal |
|---|---|
| ≥ 0.90 | **Likely AI** (flagged in Balanced mode) |
| 0.70 – 0.90 | Weak signals (not flagged; shown in panel) |
| < 0.70 | No flag |

### Evaluation

`npm run eval-model -- --n=16` (uint8, 16 AI + 16 real images from Wikimedia Commons). **Sanity check, not a benchmark.**

| Threshold | AI caught | Real wrongly flagged |
|---|---|---|
| 0.50 | 94% | 6% |
| 0.90 | 88% | 6% |

Browser timing (end-to-end test): ~70–200 ms per image with fp16 on WebGPU (software adapter in headless Chrome); ~0.5–1 s with uint8 on WASM.

**Real-world (Reddit via soci.ly, 548 images + 53 videos/GIFs, weak labels, from [hikaku-bench](https://github.com/hikaku-io/hikaku-bench)):** 65% of AI images caught, 6% of real photos flagged (2.5% excluding film), AI video 22% caught. Provenance metadata survived on 0 of 548 Reddit images.

### Known failure modes

| Input | Behaviour | Mitigation |
|---|---|---|
| Screenshots, chat captures, UI, slides | Scores look like "AI" (out of distribution) | Screenshot/graphic filter skips the model ([`lib/preprocess.js`](../lib/preprocess.js)) |
| Glossy product shots, 3D renders | Occasional false positives | High threshold; "Likely" wording; Strict mode |
| Face swaps / local edits on real photos | Not detected (the image is mostly real) | Planned face pipeline (see below) |
| New generators, heavy recompression | Lower recall | Planned broader-coverage model |
| Film photography (grain, scans) | 25% false positives on r/analog | Needs calibration / better model |
| AI video frames | 22% recall | Needs a video-trained model |
| Thumbnails < 160 px | Skipped | Open the full-size image |

## Adding a model

1. **License**: must permit commercial use and redistribution. No NC/research-only weights.
2. **Pin** the exact revision (commit SHA) and record size, input spec and labels in a config like `lib/model-config.js`.
3. **Evaluate** with `scripts/eval-model.mjs` (extend the sets if needed) and include TPR/FPR at the proposed threshold, plus hard negatives relevant to the model (e.g. real faces for a face-swap model).
4. **Cost**: report download size and per-image latency on WebGPU and WASM. Prefer cascades (cheap gate first) over always-on models.
5. **Signal**: the model contributes its own labelled signal in `lib/score.js` with a conservative strength, so users can see which model said what.
6. Update this file and `NOTICE`.

## Optional second opinion and comparison

| Model | Role | Size | License | Notes |
|---|---|---|---|---|
| [CommunityForensics-DeepfakeDet-ViT](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) | Optional second opinion in still-image details | 23 MB (int8) | MIT | Pinned to `ac6ee457bea904a373065754107451793b56db00`; not a default replacement. |
| UltraFace RFB-320 | Face detection gate | ~1 MB | MIT | Runs only to find faces for the next stage. |
| [AI-vs-Deepfake-vs-Real](https://huggingface.co/prithivMLmods/AI-vs-Deepfake-vs-Real-ONNX) | Per-face swap/deepfake check | 57 MB (q4) | Apache-2.0 | Self-reported 99% in-distribution; needs real-world eval on memes. |

### Browser comparison, 2026-11-14

All 548 local Reddit images, plus four user-provided examples excluded from metrics. Weak subreddit labels. Chrome 156, Ryzen 7 7800X3D, WASM/four threads; indicative single-inference timings, not a repeated hardware benchmark. Common graphic/minimum-size gates; browser canvas preprocessing. Node area-averaging produces materially different scores on some inputs, so Node results must not be presented as exact browser behavior.

| Model | Weight bytes (MB) | Median inference | AI-labelled flagged / scored at 0.90 | Real-labelled flagged / scored |
|---|---:|---:|---:|---:|
| SwinV2 uint8 | 198.9 | 537 ms | 149/233 | 15/239 |
| Community Forensics INT8 | 23.0 | 221 ms | 26/233 | 0/239 |
| Community Forensics FP32 | 87.4 | 329 ms | 21/233 | 0/239 |

An either-model policy flagged 154/233 AI-labelled images and 15/239 real-labelled images: five additional AI-labelled flags, with no additional real-labelled flags in this sample. This does not establish a general false-positive rate. The second model remains explicit and optional: its default threshold is conservative, adds work, and the weak labels are insufficient to validate a new automatic policy.

The second model resizes the shortest side to 440, center-crops to 384, applies CLIP normalization, and uses a single-logit sigmoid. It does not reuse SwinV2’s stretch, ImageNet normalization, or softmax. FP32 and quantized results can differ; revisions and variants are pinned.

Reproduce from `hikaku-bench`: `npm run compare -- --examples=/path/to/local/examples`. Results, model weights and media remain local and gitignored. The comparison also reports an experiment on saved video scores: any-frame pooling flags 9/18 AI-labelled videos versus 4/18 for the median, but only six real-labelled videos exist. The default remains median pooling pending a suitable evaluation.

Diagnose a file or URL through the real extension with `npm run trace -- --second-opinion image.png` (`--wasm` forces CPU). A second model can also be confidently wrong; no image URL, filename or subreddit is used as ground-truth evidence by the extension.
