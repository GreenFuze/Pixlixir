# Google Photos mobile-feature parity — research matrix

Findings only; empty cells mean **not yet investigated**. We do not bypass payment, device,
region or account restrictions.

Checked 2026-11-06, read-only, from the app's code and the web app's loaded scripts: nothing run on
a phone except one Magic Eraser test by the owner, whose copy is a separate file with a C2PA
credential from Google Photos Android and no edit recipe. Native use from the web was dropped.

| Feature | Mobile-only today? | Local or backend? | Hidden web UI? | Private web request? | Entitlement / device tie | Independent equivalent |
|---|---|---|---|---|---|---|
| Magic Eraser | Yes, as far as Google's pages say | Phone: models downloaded to it; saved as finished pixels | None in the web code loaded | None found | Device checks in the app | Edit, Erase button (ADR-0009) |
| Generative edit (Magic Editor) | Yes, as far as Google's pages say | Backend: `PhotosGenerateMagicEditorEraseObjectEffect` and others | None in the web code loaded | Refused: the same 400 for any body from the web session | Metered per account | Edit, text (ADR-0009) |
| Unblur | Yes, as far as Google's pages say | Phone: `unblur_v1_cpu`, `unblur_v2_*` models | None in the web code loaded | None found | Device checks in the app | Edit, Unblur button (ADR-0009) |
| Best Take | | | | | | C-06 |
| Auto Frame | | | | | | Outpainting + crop |
| Portrait light / blur | | | | | | S-14 |
| Video stabilization | | | | | | V-02 (companion/FFmpeg) |
| Enhanced video editor | | | | | | V-* |
