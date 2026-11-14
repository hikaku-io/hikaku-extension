# Store listing text

Copy-paste text for both stores. Keep the claims here in line with what the extension actually does and with the numbers published in hikaku-bench.

## Chrome Web Store

**Name:** Hikaku

**Summary** (shown under the name; max 132 characters):

> Spot AI-generated images and video as you browse. Hikaku outlines them and shows you why. Everything runs on your device.

**Category:** Tools

**Language:** English

**Description:**

> Hikaku puts a quiet outline around AI-generated images and video while you browse, and shows you why it flagged each one.
>
> How it works
> • It first reads what the file says about itself: Content Credentials (C2PA), IPTC "AI-generated" labels and the tags some generators leave behind. If a file says it was made with AI, that's the answer.
> • Most sites strip that information, so Hikaku also runs a small AI-image detection model directly on your device.
> • Hover a flagged image for a short summary. Click the tag, or right-click any image and choose "Inspect for AI generation", to see every signal and its source.
>
> What you can set
> • A purple outline or a small dot
> • Balanced or Strict (Strict only flags images with proof in their metadata)
> • Light, dark or matching Chrome
>
> Privacy
> Nothing you browse leaves your computer. There's no Hikaku server, no account and no tracking. The detection model downloads once from Hugging Face and then runs offline.
>
> Please read this
> Hikaku gives you a signal, not a verdict. No flag doesn't mean an image is human-made, and the model gets things wrong sometimes, especially with brand-new generators, AI video, film photos and 3D renders. Our test results are public at https://github.com/hikaku-io/hikaku-bench.
>
> Hikaku is free and open source (Apache-2.0): https://github.com/hikaku-io/hikaku-extension

**Website:** https://hikaku.io  ·  **Support:** https://github.com/hikaku-io/hikaku-extension/issues

### Privacy tab

**Single purpose:**

> Hikaku helps people tell whether images and videos on the web pages they visit were generated or edited by AI, by marking those images on the page and explaining why.

**Permission justifications:**

| Permission | Justification |
|---|---|
| Host permission `<all_urls>` | Hikaku checks images and videos on whatever page the user is viewing. It needs to see those elements, re-download the image files from the same address the page uses to read their metadata, and run the on-device detection model on them. Nothing is sent anywhere else. |
| `contextMenus` | Adds the right-click "Inspect for AI generation" command on images and videos. |
| `storage` | Saves the user's settings (on/off, flag style, sensitivity, theme, model on/off). |
| `scripting` | Adds the overlay to tabs that were already open when the extension was installed, and to frames when the user runs "Inspect" there. |
| `offscreen` | Runs the AI-image detection model (ONNX Runtime with WebGPU/WebAssembly) in an offscreen document, because MV3 service workers can't host it. |

**Remote code:** No, I am not using remote code. All JavaScript and WebAssembly ships in the package. The only thing downloaded at runtime is the model's weights file (data, not code) from a pinned Hugging Face revision.

**Data usage:** Collects none of the listed data types. Certify all three: not sold to third parties, not used for unrelated purposes, not used for creditworthiness or lending.

**Privacy policy URL:** https://hikaku.io/privacy

## Firefox Add-ons (AMO)

**Name:** Hikaku

**Summary** (max 250 characters):

> Spot AI-generated images and video as you browse. Hikaku outlines them, shows you the evidence behind each flag, and does all of it on your own computer. No account, no tracking.

**Description:** use the Chrome description above (AMO allows basic formatting).

**Categories:** Privacy & Security, Photos, Music & Videos

**License:** Apache License 2.0

**Support site:** https://github.com/hikaku-io/hikaku-extension/issues  ·  **Homepage:** https://hikaku.io

**Privacy policy:** paste the contents of PRIVACY.md (AMO wants the text, not just a link).

### Notes for reviewers

> Thanks for reviewing Hikaku. A few things that will save you time:
>
> 1. Third-party library. vendor/ort/ is ONNX Runtime Web 1.31.1 by Microsoft (MIT), copied unmodified from the npm package "onnxruntime-web@1.31.1", folder dist/. The two validator warnings (DANGEROUS_EVAL, UNSAFE_VAR_ASSIGNMENT) come from that library. SHA-256 of the shipped files:
>    - ort.webgpu.min.mjs  329cd956772397a1aedd668e911195d39afefb182f6fc14aafa4f08ac8d8f379
>    - ort-wasm-simd-threaded.asyncify.mjs  59cf781530e1a16df2a291d78798e3ec1152467edaec402d6f9599d85047c302
>    - ort-wasm-simd-threaded.asyncify.wasm  ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec
>    You can verify with: npm pack onnxruntime-web@1.31.1, then compare package/dist/<file>.
> 2. Our own code isn't minified, bundled or transpiled. Full source: https://github.com/hikaku-io/hikaku-extension (build with "npm install && npm run build -- --target=firefox").
> 3. The only network request beyond re-fetching images the page already shows is a one-time download of the model weights (a .onnx data file) from a pinned Hugging Face commit. No code is loaded remotely and no user data is sent anywhere.
> 4. To test: open any page with images and hover a purple outline, or right-click an image and choose "Inspect for AI generation". The first check downloads the model (about 200 to 400 MB), and its progress shows in the toolbar popup.
