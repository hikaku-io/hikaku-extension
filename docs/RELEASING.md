# Releasing

Once the extension is in the stores, shipping an update is one tag:

```sh
# bump "version" in manifest.json and package.json, add a CHANGELOG entry, then
git commit -am "Release 0.2.0"
git tag v0.2.0
git push && git push --tags
```

The [release workflow](../.github/workflows/release.yml) then lints, tests and builds, creates the GitHub release with both zips, and uploads the new version to the Chrome Web Store and Firefox Add-ons. Each store reviews it (usually a few hours to a couple of days). After approval, browsers update everyone's installed copy on their own. Users don't have to do anything.

The very first version has to be submitted by hand (see [store/README.md](../store/README.md)). The API can only update a listing that already exists.

## One-time setup: Chrome Web Store

You need five repository secrets. Add them under **Settings → Secrets and variables → Actions**.

1. **CWS_PUBLISHER_ID**: Developer Dashboard → **Publisher → Settings**.
2. **CWS_EXTENSION_ID**: the 32-letter ID on the item's **Package** tab.
3. **CWS_CLIENT_ID** and **CWS_CLIENT_SECRET**:
   - In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Chrome Web Store API**.
   - Set up the OAuth consent screen (External is fine) and add your Google account as a test user.
   - Create an OAuth client of type **Web application** with `https://developers.google.com/oauthplayground` as an authorized redirect URI.
4. **CWS_REFRESH_TOKEN**:
   - Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), click the gear, tick **Use your own OAuth credentials** and paste the client ID and secret.
   - Enter the scope `https://www.googleapis.com/auth/chromewebstore`, authorize with the account that owns the listing, then **Exchange authorization code for tokens** and copy the refresh token.
   - Publish the consent screen (move it out of Testing). While it's in Testing, Google expires refresh tokens after 7 days.

The account needs 2-step verification turned on, or the store refuses to publish.

To try it by hand without submitting for review: `node scripts/publish-chrome.mjs dist/hikaku-0.1.0-chrome.zip --upload-only` with those variables set. That leaves a draft you can check in the dashboard.

Edge picks up the same Chrome package, but the Edge Add-ons store is separate and still a manual upload for now.

## One-time setup: Firefox Add-ons

1. Sign in at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) and generate credentials.
2. Add them as secrets: **AMO_JWT_ISSUER** (the "JWT issuer") and **AMO_JWT_SECRET** (the "JWT secret").

The workflow signs and submits with `web-ext sign --channel=listed` and attaches a source zip (`git archive` of the tag), which Mozilla's reviewers ask for because of the bundled ONNX Runtime.

## If a step fails

Store steps skip themselves when their secrets are missing, so a GitHub release still goes out. If an upload is rejected (most often because the version wasn't bumped, or a review is still pending for the previous version), fix it and re-run the job from the Actions tab, or upload the zip from the release by hand.
