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

## Candidates under evaluation

| Model | Role | Size | License | Notes |
|---|---|---|---|---|
| [CommunityForensics-DeepfakeDet-ViT](https://huggingface.co/buildborderless/CommunityForensics-DeepfakeDet-ViT) | General AI-image detector (2nd opinion or replacement) | 23 MB (int8) | MIT | Trained on 4,803 generators (CVPR 2025). Could cut the download ~95%. |
| UltraFace RFB-320 | Face detection gate | ~1 MB | MIT | Runs only to find faces for the next stage. |
| [AI-vs-Deepfake-vs-Real](https://huggingface.co/prithivMLmods/AI-vs-Deepfake-vs-Real-ONNX) | Per-face swap/deepfake check | 57 MB (q4) | Apache-2.0 | Self-reported 99% in-distribution; needs real-world eval on memes. |
