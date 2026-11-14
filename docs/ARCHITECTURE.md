# Architecture

Hikaku is a Manifest V3 extension that runs in four contexts. Everything is analyzed locally.

```mermaid
flowchart LR
  subgraph Page["Web page (each frame)"]
    CS["content/content.js<br/>observe media · overlay · video frame sampling"]
  end
  subgraph Ext["Extension"]
    SW["background.js (service worker)<br/>cache · metadata-only checks · scoring · context menu · tab capture"]
    OFF["offscreen/offscreen.js<br/>single image fetch · metadata · gates · ONNX Runtime"]
    POP["popup/<br/>settings · model status"]
    ST[("chrome.storage.sync<br/>settings")]
  end
  HF[("huggingface.co<br/>model weights, once")]

  CS -- "analyze(url) / analyzeFrames(frames) / captureFrame(rect)" --> SW
  SW -- "classify(url | data:, inspect, secondOpinion)" --> OFF
  OFF -. "first use only" .-> HF
  POP -- "modelStatus / warmup" --> SW
  POP <--> ST
  CS <--> ST
```

## Detection pipeline

Images are fetched once in the offscreen runner (or Firefox background page) when visual analysis is enabled. Bytes stay in memory, feed metadata extraction and image decoding, and are not persisted. With the model disabled, the service worker handles metadata alone.

```mermaid
flowchart TD
  A["Media near the viewport"] --> B["Fetch once; read metadata declarations"]
  B --> C["Decode; skip tiny images and flat graphics"]
  C --> D["Load model only for eligible images"]
  D --> E["SwinV2 estimate"]
  E --> F["Separate declarations and model estimates"]
  E -. "Explicit request in image details" .-> G["Optional Community Forensics estimate"]
  G --> F
```

### Scoring (`lib/score.js`)

- Evidence weights rank metadata signals; they are not confidence probabilities.
- Repeated EXIF/XMP/C2PA claims use the strongest declaration, not noisy-OR.
- Only explicit edit declarations produce `ai-edited`. A model cannot invent an edit history or promote a weak declaration to a verified claim.
- C2PA signatures and asset binding are not verified. Neither capture nor AI-use declarations bypass the visual check.
- Model-only results can reach **Likely AI** at the 0.90 threshold, never a verified verdict. Two weak model scores do not compound.
- **Strict** flags explicit metadata declarations only. The UI explains that declarations are editable.

Image and video-metadata work use separate bounded queues. Explicit context-menu inspections and second opinions are promoted ahead of queued automatic work. Queued jobs are cancelled on tab navigation/closure when no other tab needs them; active shared inference is allowed to finish. Transient errors are evicted from both caches, with at most two automatic image retries. Changing the visual-model setting invalidates page results and ignores stale responses.

### Why an offscreen document?

MV3 service workers get suspended after about 30 s idle, and they can't load ONNX Runtime's WASM factory because dynamic `import()` isn't allowed there. An offscreen document sticks around for the whole browser session, so the model loads once. `lib/classifier.js` creates the document on demand and retries messages while it's still starting up.

### Overlay (`content/content.js`)

- It lives in a closed shadow root on one fixed-position host. Page CSS can't break it, and it can't break the page.
- The frames never take pointer events, so the page stays clickable. Only the small tag/dot handle does.
- Hover is detected geometrically (is the pointer inside a flagged rect?), which keeps working when a site lays a transparent overlay over its images.
- Positions update on scroll and resize through `requestAnimationFrame`, plus a 600 ms ticker to catch layout shifts.

### Video

1. Direct files (`http(s):`) get a container metadata check first: range requests for the head and the tail, 3 MB each.
2. If that doesn't settle it, we sample up to 3 frames while the video is visible, at least 1.5 s apart in media time, and skip near-black ones.
3. Frames normally come from `canvas.drawImage(video)`. When the canvas is tainted (cross-origin video without CORS), the service worker captures the visible tab, rate-limited to about 1.5 per second, and crops out the video's rectangle.

## Messages

| Message | From → To | Purpose |
|---|---|---|
| `analyze {url, kind}` | content/popup → SW | Full analysis (cached per session); `secondOpinion: true` explicitly requests the optional still-image model |
| `analyzeFrames {url, frames[]}` | content → SW | Score sampled video frames, merge with container metadata |
| `captureFrame {rect, dpr}` | content → SW | Screenshot fallback for tainted video |
| `showDetails {url, result \| loading}` | SW → content | Open the panel (context menu) |
| `stats` | popup → content | Per-page counts |
| `modelStatus`, `modelWarmup` | popup → SW | Model download/load state |
| `{target:'offscreen', type:'classify' \| 'status' \| 'warmup'}` | SW → offscreen | Model inference |

## Security notes

- CSP: `script-src 'self' 'wasm-unsafe-eval'`. No remote code, and ONNX Runtime is vendored.
- Extension pages are cross-origin isolated (COOP/COEP) so WASM can use threads.
- The overlay DOM is built from `textContent` and attributes only. Page data never goes through `innerHTML`.
- Model weights are pinned to a Hugging Face commit in `lib/model-config.js`.
