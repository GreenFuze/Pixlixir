# Security & policy risk assessment (v0.1)

## Policy / terms

| Risk | Assessment | Mitigation |
|---|---|---|
| Undocumented Google Photos web interfaces | Unsupported; may change or be restricted at any time. Automating them may conflict with Google's Terms of Service (https://policies.google.com/terms) — **not reviewed by a lawyer**. | Isolate in `src/gphotos`; act only on explicit user actions in their own signed-in session; no bulk scraping; no request disguising; no bypass of auth, CAPTCHA, entitlements or quotas; fail safely and disable writes on unexpected shapes. Re-review before any bulk/automated write feature. |
| Chrome Web Store review | Extensions using private APIs of third-party sites can be rejected. | Minimal permissions; clear disclosure; distribute unpacked/GitHub until reviewed. |
| Third-party code licences | GPTK (MIT) used as reference only; google-photos-deduper is **AGPL-3.0** and must not be copied into this Apache-2.0 project. | No code copied; protocol facts documented independently; THIRD_PARTY_NOTICES lists references. |

## Threats & controls (current scope)

| Threat | Control |
|---|---|
| Malicious page script drives our privileged code | Isolated world only; no MAIN-world injection; launcher in a closed shadow root. |
| Another extension / web page messages us | `onMessageExternal` not registered; sender id + URL checks; zod validation on every message. |
| Operation against the wrong Google account | `expectedEmail` checked inside the tab before every request; the SW never substitutes another account's tab; the editor header and confirm dialog name the account. |
| Session secrets leak | Tokens in private fields of `SessionContext`, never serialized, logged or messaged; no cookie access. |
| Destructive change | No delete/trash/replace code exists in this release. Saves create new items only, after a confirmation dialog. |
| Duplicate uploads on retry | Per-print saved state persisted in IndexedDB before moving on; retries skip saved prints. |
| Private media leaves the device | No network calls except to photos.google.com in the user's own tab. No telemetry. |
| Large payload DoS | 60 MB original cap; 12,000 px rectification cap. |

## Future-scope gates

- **External API (companion):** loopback only, per-client tokens, scopes, Host/Origin checks,
  rate limits, no credential exposure, approval prompts for writes. Design review before code.
- **Vault:** threat model + external review before implementation; established AEAD
  (AES-GCM / XChaCha20-Poly1305) and KDF (Argon2id); no custom crypto; documented limits of
  browser memory protection.
- **Cloud AI providers:** per-operation consent showing exactly what leaves the device.
