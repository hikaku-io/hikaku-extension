// Uploads a build to the Chrome Web Store and submits it for review, using the
// Chrome Web Store API v2. The release workflow runs this when a version tag is
// pushed; you can also run it by hand.
//
// It needs these environment variables (see docs/RELEASING.md for how to get them):
//   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN   OAuth client and refresh token
//   CWS_PUBLISHER_ID                                      Developer Dashboard → Publisher → Settings
//   CWS_EXTENSION_ID                                      the 32-letter item ID
//
// Usage: node scripts/publish-chrome.mjs dist/hikaku-0.1.0-chrome.zip [--upload-only]
import { readFileSync } from 'node:fs';

const zip = process.argv[2];
const uploadOnly = process.argv.includes('--upload-only');
const env = (k) => process.env[k] || (console.error(`Missing ${k}`), process.exit(1));
if (!zip) { console.error('Usage: node scripts/publish-chrome.mjs <zip> [--upload-only]'); process.exit(1); }

const API = 'https://chromewebstore.googleapis.com';
const item = `publishers/${env('CWS_PUBLISHER_ID')}/items/${env('CWS_EXTENSION_ID')}`;

async function call(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${url} → ${res.status}\n${text}`);
  return body;
}

// 1. Swap the long-lived refresh token for a short-lived access token.
const { access_token: token } = await call('https://oauth2.googleapis.com/token', {
  method: 'POST',
  body: new URLSearchParams({
    client_id: env('CWS_CLIENT_ID'),
    client_secret: env('CWS_CLIENT_SECRET'),
    refresh_token: env('CWS_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  }),
});
const auth = { Authorization: `Bearer ${token}` };

// 2. Upload the zip. Big uploads can still be processing when this returns.
console.log(`Uploading ${zip}`);
let up = await call(`${API}/upload/v2/${item}:upload`, { method: 'POST', headers: auth, body: readFileSync(zip) });
for (let i = 0; up.uploadState === 'IN_PROGRESS' && i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  up = await call(`${API}/v2/${item}:fetchStatus`, { headers: auth });
  up.uploadState = up.lastAsyncUploadState ?? up.uploadState;
}
console.log('Upload:', JSON.stringify(up));
if (up.uploadState && up.uploadState !== 'SUCCEEDED') { console.error('Upload did not succeed.'); process.exit(1); }

// 3. Submit for review. Once Google approves it, the store publishes it and
// Chrome updates everyone who has it installed within a few hours.
if (uploadOnly) { console.log('Uploaded as a draft (--upload-only). Submit it from the Developer Dashboard.'); process.exit(0); }
const pub = await call(`${API}/v2/${item}:publish`, { method: 'POST', headers: auth });
console.log('Submitted for review:', JSON.stringify(pub));
