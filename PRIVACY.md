# Privacy Policy

_Last updated: 2026-11-13_

Nothing you browse leaves your device for analysis. There's no Hikaku server, no account, no analytics and no telemetry.

## What Hikaku processes, and where

| Data | What happens | Leaves your device? |
|---|---|---|
| Images and videos on pages you visit | Re-requested by the extension from the **same URL** the page uses (so your browser cache and cookies apply), then analyzed locally: metadata parsing and an on-device ML model. | **No.** Only the normal request to the site that already serves the image. |
| Video frames | Up to 3 frames per visible video, drawn from the video element (or, for cross-origin video, a screenshot of just the video's on-screen area), analyzed locally, then discarded. | **No.** |
| Analysis results | Kept in memory for the current browser session to avoid re-analyzing the same image. | **No.** |
| Settings (on/off, flag style, sensitivity, model on/off) | Stored with `chrome.storage.sync`. | Synced by your browser vendor if you have browser sync enabled. Hikaku never sees it. |
| Model weights | Downloaded **once** from `huggingface.co` (pinned version) and cached locally. Offline builds include them. | Hugging Face sees a normal download request (your IP address, user agent). No browsing data is included. |

Hikaku does **not** collect, store or transmit: browsing history, page content, images, URLs, identifiers, or usage statistics.

## Permissions and why we ask for them

| Permission | Why |
|---|---|
| Access to all sites (`<all_urls>`) | Lets the extension see images and videos on the pages you visit, fetch them for local analysis and, for cross-origin video, capture the visible video area. |
| `contextMenus` | The right-click **Inspect for AI generation** command. |
| `storage` | Saving your settings. |
| `scripting` | Puts the overlay into tabs that were already open when you installed the extension. |
| `offscreen` | Runs the ML model in a background document, because the service worker can't run it. |

## Changes

This file's history in the public repository tracks every change to the policy. Anything significant also gets a note in the [CHANGELOG](CHANGELOG.md).

## Contact

Questions: open an issue, or email privacy@hikaku.io.
