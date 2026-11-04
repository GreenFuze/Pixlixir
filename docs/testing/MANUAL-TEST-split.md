# Manual test — Split into Photos (Scenarios A, B, G)

Prereqs: `npm ci && npm run build`; Chrome → `chrome://extensions` → Developer mode →
**Load unpacked** → select `dist/`. Have a scan or photo of an album page in Google Photos.

1. Open https://photos.google.com. Expect the **✦ Pixlixir** chip bottom-right.
2. Click the toolbar icon: the side panel shows your account email.
3. Open (or select exactly one) scanned photo. The chip badge shows `1`; the panel says "1 item selected".
4. Chip → **Split into Photos** (or the panel button). A new tab opens with your account in the header.
5. Expect outlines around each print, numbered in reading order, with previews on the right.
6. Drag a corner; move an outline; press Delete on a false detection; "+ Add photo" for a missed one; rotate a sideways print.
7. Click **Save N to Google Photos**. The confirm dialog names your account. Save.
8. Each card turns "Saved ✓" with "Open in Google Photos ↗". Open one: it exists and, with
   "Use the scan's date", sits next to the scan in the timeline.
9. The original scan is unchanged.
10. Close the editor mid-save and reopen the same scan: it resumes; saved prints are not re-uploaded.
11. Account safety: an editor bound to account A refuses to save through a tab signed into account B (`ACCOUNT_MISMATCH`).

Clean-up: the saved photos are normal items; delete them in Google Photos if they were test data.
