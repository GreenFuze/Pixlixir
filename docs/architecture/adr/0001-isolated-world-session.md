# ADR-0001: Read the Photos session in the isolated world

**Status:** accepted (2026-11-04)

**Context.** The private API needs `WIZ_global_data` values (XSRF token, session id, build
label, path prefix, account email). Existing projects (GPTK, google-photos-deduper,
photo-curator) inject scripts into the page's MAIN world and talk over `window.postMessage`,
which any page script can observe or spoof.

**Decision.** Parse the inline bootstrap `<script>` text from the DOM in the content
script's isolated world (live-verified: the object literal is valid JSON). Never inject code
into the page.

**Consequences.** + No postMessage bridge to secure; tokens never enter a context the page
controls; no `web_accessible_resources`. − If Google stops inlining the data (e.g. moves it to
a JS-only global), reading fails safely with `SESSION_UNAVAILABLE` and we must revisit.

**Alternatives.** MAIN-world injection (rejected: larger attack surface); `chrome.scripting`
with `world: "MAIN"` on demand (kept as a fallback design if the DOM source disappears).
