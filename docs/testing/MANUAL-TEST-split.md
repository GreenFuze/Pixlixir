# Manual test — Split into Photos (Scenarios A, B, G)

Prereqs: `npm ci && npm run build`; Chrome → `chrome://extensions` → Developer mode →
**Load unpacked** → select `dist/`. Have a scan or photo of an album page in Google Photos.

1. Open https://photos.google.com. Expect the **✦ Pixlixir** chip bottom-right.
2. Click the toolbar icon: the side panel shows your account email at the top.
3. Open or select one scanned photo, or select up to 100 for a bulk split. The chip badge shows the count.
   Bulk: a filmstrip lists the scans (badge = photos found); click one to review it; **Save N from M scans** saves them all.
4. Chip → **Split** icon (or the same icon in the side panel). A new tab opens with your account in the header.
5. Expect outlines around each print, numbered in reading order, with previews on the right.
6. Drag a corner; move an outline; press Delete on a false detection; "+ Add" for a missed one; rotate a sideways print.
7. Fix: on a card click **Fix…**. Expect a large preview with auto-fixes applied.
   - Hold **Hold to compare** to see the original; tick **Show fixed areas**.
   - Toggle/adjust Glare, Lighting & shadows, Restore colour (Fix fading & casts / Keep original tones), Dust & scratches, Sharpen.
   - Pick the **Glare** brush and paint over a reflection; **Repair** over a crease/scratch; **Protect** over something auto-fix should not touch. **Undo stroke** works.
   - **Use these settings for all photos** copies the sliders (not brush strokes) to the other photos. **Done** closes.
   - If prints were photographed sideways, use **Rotate all** (⟲ ⟳) above the list.
8. Click **Save N to Google Photos**. The confirm dialog names your account. Save.
9. Each card turns "Saved" with "Open in Google Photos ↗". Open one: it exists, includes your fixes, and (with
   "Use the scan's date") sits next to the scan in the timeline.
10. The original scan is unchanged.
11. Close the editor mid-save and reopen the same scan: it resumes; saved prints are not re-uploaded.
12. Account safety: an editor bound to account A refuses to save through a tab signed into account B (`ACCOUNT_MISMATCH`).

Known limits (by design, see FEATURES.md): heavy glare on glossy prints is only reduced, not removed
(R-18 multi-shot is the real fix); orientation is manual (R-19); prints that overlap can merge.

Clean-up: the saved photos are normal items; delete them in Google Photos if they were test data.
