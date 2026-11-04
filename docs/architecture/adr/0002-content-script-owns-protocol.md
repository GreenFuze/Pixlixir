# ADR-0002: The Photos tab's content script owns all Google requests

**Status:** accepted (2026-11-04)

**Context.** batchexecute and upload calls must be same-origin with the user's cookies.
Media URLs (`…usercontent.google.com/…=d`) return 403 without cookies (live-verified), and
extension-origin requests may not carry them depending on third-party-cookie settings.

**Decision.** All Google traffic (RPCs, uploads, original downloads) runs in the content
script of a Photos tab signed into the target account. Extension pages send typed requests
with `expectedEmail`; bytes move as base64 over extension messaging (60 MB cap).

**Consequences.** + One proven network path; tokens stay in one place; host permissions
reduced to `photos.google.com`. − A Photos tab for that account must stay open during work
(the SW re-resolves another tab of the same account if the original closes). − base64 adds
~33% transfer overhead; acceptable for photos, to revisit for video (likely companion).
