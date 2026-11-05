# Manual test — Wrong dates from file names

Prereqs: `npm ci && npm run build`, reload Pixlixir in `chrome://extensions`, reload the Google
Photos tab. **Fixing changes real dates in place.** Start with one or two photos.

## Formats
1. Side panel **⚙** (or right-click the extension icon → Options; or **Formats…** in the scan).
   The account shows at the top: each Google account has its own list.
2. A new account starts with the default formats. Add `IMG-yyyymmdd.*`: it joins the list.
   Bad ones explain themselves: `IMG-*.*` says "Needs yyyy, mm and dd."
3. **Try a file name**: `IMG-20240328.jpg` shows the date and the format that matched.
4. Reload: the list is kept. Delete a default: **Restore defaults** brings it back.
5. Another account (`/u/1`) has its own list.

## Scan
6. **Scan library…** → tick **Wrong dates**, untick **Panoramas** for speed → **Scan**. Expect
   "Reading file names: k of n", then a list of items with old date → new date. Hover a name
   to see which format matched. Scan again: names are not read again.

## Fix
7. **None**, then tick one or two → **Fix N** → the dialog names the account → **Change dates**.
8. The rows show **Fixed**. In Google Photos, those items now sit at the new date, still in their
   albums. A date-only name kept its time of day.
9. **Undo** → **Put back**: they return to the old dates.
10. Side panel → **Recent work** lists "Dates fixed".

Known limits: Undo ends when the scan closes or a new one starts. Items owned by someone else are
caught when the date is read back, which stops the run with a message.
