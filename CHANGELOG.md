# Changelog

Notable changes to this project are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-14

First public release.

### Added
- Firefox support (Firefox 140+). One build now makes both packages: `hikaku-<version>-chrome.zip` and `hikaku-<version>-firefox.zip`. In Firefox the model runs in the background page, since Firefox has no offscreen documents.
- Store kit in `store/`: listing text, permission justifications, reviewer notes, and screenshots and promo tiles at the sizes the stores require (`npm run store-assets`).
- **Provenance detection**: C2PA Content Credentials (JPEG, PNG, WebP, MP4/MOV/AVIF/HEIC), IPTC Digital Source Type, generator names in EXIF/XMP tool fields, "Made with … AI" declarations, and embedded generation parameters (Automatic1111, ComfyUI, InvokeAI, NovelAI).
- **On-device visual model** (SwinV2 AI-image detector, Apache-2.0) via ONNX Runtime Web: fp16 on WebGPU, uint8 on WASM fallback. One-time download, cached; optional offline bundle.
- **Video**: samples up to 3 frames per visible video (including streamed `blob:` video), median score; screenshot fallback for cross-origin video.
- **Animated GIF / WebP**: first/middle/last frames, median score.
- **Screenshot / flat-graphic filter** so chat captures, UI and slides aren't misread as AI.
- **Flag styles**: purple border (default) or dot; hover card with verdict and reasons; details panel with signals, Content Credentials, EXIF, XMP/IPTC, raw metadata and Copy JSON.
- Right-click **Inspect for AI generation** on any image or video.
- Toolbar popup: on/off, flag style, sensitivity (Balanced / Strict), visual-model status and download progress, per-page counts.
- Companion repositories: `hikaku-site` (landing page, Cloudflare) and `hikaku-bench` (real-world benchmarks).
- Backdrop copies (blurred or stretched images behind the real one, e.g. on Reddit) are ignored; outlines are clipped to the visible area and sit 4 px outside the media.
- Details panel lists which video timestamps / GIF frames were checked and each one's score.
- Project hygiene: Apache-2.0 license, NOTICE, privacy policy, security policy, contributing guide, code of conduct, CI/release/e2e workflows, issue and PR templates.
- Tooling: unit tests, ESLint, model evaluation script, end-to-end test in Chrome for Testing, production build + zip.

### Dependencies
- ONNX Runtime Web 1.31.1. Same results on the model check, and the end-to-end test passes on WebGPU.
- ESLint 10, and every GitHub Action pinned to an exact commit. Dependabot waits a week before proposing a new release.

[Unreleased]: https://github.com/hikaku-io/hikaku-extension/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hikaku-io/hikaku-extension/releases/tag/v0.1.0
