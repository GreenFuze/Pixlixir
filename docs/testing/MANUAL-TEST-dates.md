# Manual test — Wrong dates from file names

Prereqs: `npm ci && npm run build`, reload Pixlixir in `chrome://extensions`, reload the Google
Photos tab. **Fixing changes real dates in place.** Start with one or two photos.

## Formats
1. Side panel **⚙** (or right-click the extension icon → Options; or **Formats…** in Bulk operations).
   The account shows at the top: each Google account has its own list.
2. A new account starts with the default formats. Add `IMG-yyyymmdd.*`: it joins the list.
   Bad ones explain themselves: `IMG-*.*` says "Needs yyyy, mm and dd."
3. **Try a file name**: `IMG-20240328.jpg` shows the date and the format that matched.
4. Reload: the list is kept. Delete a default: **Restore defaults** brings it back.
5. Another account (`/u/1`) has its own list.

6a. Tick **Saved** on a format: its names stop producing suggestions, and they do not count as unmatched.

## Find them
6. **On selected items:** select photos or videos, or open one → **Fix dates** (the icon in the side
   panel or the chip's menu). The modal opens on those items only.
6b. **Across the library:** side panel → **Bulk operations** → tick **Wrong dates**, untick
   **Panoramas** for speed → **Scan**.
   Either way, expect "Reading file names: k of n", then a list of items with old date → new date.
   Hover the **?** on a row to see which format matched and why the row is there. The status counts names that match no format.
   **Scan again**: names are not read again.

## Fix
7. **None**, then tick one or two → **Fix N** → the dialog names the account → **Change dates**.
8. The rows show **Fixed**. In Google Photos, those items now sit at the new date, still in their
   albums. A date-only name kept its time of day.
9. **Undo** → **Put back**: they return to the old dates.
10. Side panel → **Recent work** lists "Dates fixed".

If a date does not stick, the message names the file; hover it for the wanted and returned times.

Known limits: Undo ends when the scan closes or a new one starts. Items owned by someone else are
caught when the date is read back, which stops the run with a message.

## Saved copies and their originals

1. Scan with **Wrong dates** on `/u/1`. The `2022-12-02 (N).jpg` files are under **saved copies**, not wrong dates, and **All** leaves them out.
2. Select one such photo alone and press **Fix dates**. It should still be listed as a saved copy. Hover its **?**: it should say the file's own date is another day. If it gives another reason, tell us: the real files were counted with a test reader, not yet with Pixlixir's own.
3. Originals are looked for without asking, as the last step of the scan. If Duplicates was not part of the scan, the first time can take about an hour; **Stop** keeps what it has read, and **Find originals** continues it. A copy whose original has the same date shows **Date is right**.
4. Each pair shows both pictures and a percentage. Click the small original to open it. Tell us any that are not the same picture.
5. Tick a pair, press **Fix 1**, and check the copy's date in Google Photos. **Undo** must put it back.
6. **Use name** moves a copy to wrong dates, for a name that really is the date taken.
