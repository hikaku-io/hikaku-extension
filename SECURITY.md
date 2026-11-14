# Security Policy

Hikaku can read every page you visit, so we take security reports seriously.

## Reporting a vulnerability

Please don't open a public issue for security problems.

- Preferred: use GitHub's **private vulnerability reporting** ("Report a vulnerability" under this repository's **Security** tab).
- Or email **security@hikaku.io**.

Please include the affected version, your browser and OS, steps to reproduce, and what you think the impact is. We aim to hit these targets:

| Step | Target |
|---|---|
| Acknowledge your report | within 3 business days |
| Initial assessment | within 7 days |
| Fix or mitigation for high/critical issues | within 30 days |

We'll credit you in the release notes unless you'd rather we didn't.

## Supported versions

While the project is pre-1.0, only the latest release gets security fixes.

## In scope

- Anything that lets a web page read, alter or exfiltrate data through the extension (e.g. via the overlay, message passing, or the offscreen document).
- Code execution in extension contexts; CSP bypasses.
- Browsing data leaving the device (see [PRIVACY.md](PRIVACY.md) for what should never leave).
- Supply-chain issues in the build or in how model weights are fetched and pinned.

## Out of scope

- Detection accuracy (false positives or misses). Please use the Detection report issue template for those.
- Issues requiring a malicious extension or a compromised browser.
