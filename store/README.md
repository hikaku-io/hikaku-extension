# Publishing Hikaku

How to get Hikaku into the Chrome Web Store (which also covers Edge if you want a separate Edge listing later) and Firefox Add-ons (AMO). Everything you need to paste into the forms is in [listing.md](listing.md), and the images are in [assets/](assets/).

## Before you start

1. **The privacy policy has to be online.** Both stores ask for a URL. Deploy the site (hikaku-site repo) so https://hikaku.io/privacy works.
2. **Build the packages.**
   ```sh
   npm install
   npm run build          # dist/hikaku-<version>-chrome.zip and dist/hikaku-<version>-firefox.zip
   npm run store-assets   # refresh store/assets/ if the UI changed
   ```
3. **Check the version.** `manifest.json` and `package.json` must match, and each store upload needs a version higher than the last one you uploaded.

## Chrome Web Store

1. Register as a developer at https://chrome.google.com/webstore/devconsole (one-time US$5 fee). Use an account you'll keep, ideally a shared team account rather than a personal one. Verify the contact email.
2. **New item** and upload `dist/hikaku-<version>-chrome.zip`.
3. **Store listing tab:** paste the text from [listing.md](listing.md#chrome-web-store). Upload `assets/icon-128.png`, the five `assets/screenshot-*.png` (1280x800) and `assets/promo-small.png` (440x280). The marquee (`promo-marquee.png`) is optional.
4. **Privacy tab:** paste the single purpose, the permission justifications and the remote code answer from listing.md. Under data usage, tick nothing (Hikaku collects none of the listed data types) and certify the three disclosures. Privacy policy URL: https://hikaku.io/privacy
5. **Distribution:** public, all regions.
6. Submit for review.

**What to expect:** because Hikaku asks for access to all websites, Google does an in-depth review. That usually takes a few days and sometimes a couple of weeks. Clear permission justifications (we have them) are what speed this up. If they reject something, the email says which policy; fix it, bump the version, and resubmit.

## Firefox Add-ons (AMO)

1. Create an account at https://addons.mozilla.org/developers/ (free) and enable two-factor authentication, which AMO requires for submitting.
2. **Submit a New Add-on**, choose **On this site** (listed), and upload `dist/hikaku-<version>-firefox.zip`.
3. The validator will show two warnings, both inside ONNX Runtime Web (`DANGEROUS_EVAL`, `UNSAFE_VAR_ASSIGNMENT`). That's expected; explain them with the reviewer notes in [listing.md](listing.md#notes-for-reviewers).
4. **Source code:** AMO asks whether you used tools that minify or transpile code. Our own code isn't processed at all. The only minified files are the unmodified ONNX Runtime release, so answer **No** and point to the reviewer notes, which list the exact npm version and file hashes.
5. Paste the listing text, pick the categories, add the screenshots and the privacy policy, and submit.

**What to expect:** automatic signing is usually quick, and a human review can follow later. Reviewers sometimes ask about the third-party library; the reviewer notes answer that up front.

The add-on ID is `hikaku@hikaku.io` (set in `scripts/build.mjs`). Don't change it after the first upload, or Firefox treats it as a different add-on.

## After launch

- Put the store links on hikaku.io and in the README (replace the "Download" links that point at GitHub releases).
- Each release: bump the version in both files, update CHANGELOG.md, `npm run build`, and upload the new zips to both stores. Automating the uploads with the Chrome Web Store API and `web-ext sign` is possible later.
