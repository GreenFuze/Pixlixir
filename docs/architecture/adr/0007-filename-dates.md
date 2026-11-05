# ADR-0007: Wrong dates from file names, with formats the user knows

**Status:** accepted (2026-11-05)

**Context.** The owner's earlier extension, Photo Date Fixer, set Google Photos dates from the
timestamp in each file name, with five conventions in code and a list of the name shapes it did
not recognise. The owner wants this in Pixlixir, without that list: a settings page where they
add the formats they know (`IMG-20240328.jpg` is `IMG-yyyymmdd.*`), saved.

**Decision.**

1. *A scan detector*, `FilenameDateDetector`, next to panoramas: same scopes, progress, review
   and bulk action. No separate Scan / Plan / Apply steps.
2. *Masks, not regular expressions.* `yyyy mm dd hh ss` are the date, `mm` after `hh` is minutes,
   `*` is any text, `?` is any one character, the rest is literal and case-insensitive. Date
   letters inside a word ("Message", "Summer") are literal. A mask compiles to a regular
   expression with every literal escaped, so it can never act as one. No library takes a file
   name plus such a template; date-fns only parses a date once it has been isolated.
3. *The defaults are ordinary entries*: Photo Date Fixer's five conventions, as eight masks,
   visible, editable and deletable. Nothing is hidden in code. Formats with a time are tried
   first, so the list needs no ordering.
4. *Per account*, like everything saved: `chrome.storage.local`, one key per email. File names are
   cached per account by dedup key (stable across albums), so a second scan reads only new items.
5. *Dates change in place*, the one Pixlixir feature that alters existing items, so:
   a confirm dialog names the count and the account; the old dates are written to a job record
   before the first change; batches of 100 are read back, and a date that did not stick stops the
   run and says how many; Undo puts the run's dates back while the scan stays open.

**Kept from Photo Date Fixer:** a date-only name changes the day and keeps the time of day; a name
with a time counts as correct within 120 s; `PXL_` names are UTC; years before 1990 or after next
year are not dates.

**Measured on the owner's library (2026-11-05, read-only, numbers only).** `EWgK9e` returned the
name, time and offset for all 2,567 items, matching `lcxiM` on the 200 compared, and also takes
album item keys (20 of 20). The default masks match 2,426 names and would change 47 dates: 36
names with a time (9 off by up to 5 minutes, 13 up to an hour, 2 up to 3 hours, 12 over a day) and
11 date-only names. A prototype's `*` and `?` translating each other missed 2,169 plain camera
names; that case is now a test.

**Not verified live:**

- Writing dates in bulk: `DaSgWe` is live-verified on Pixlixir's own uploads only, and on the
  owner's library only through Photo Date Fixer.
- Flag 27 (owned by someone else) comes from Photo Date Fixer. It never appears in this library's
  timeline, and it does appear on album rows of the owner's own albums, so it is read from timeline
  rows only. Editing an item owned by someone else is caught by the read-back.

**Consequences.**

+ A name's date is not always right: a copy edited later may carry the later time. The review list
  shows both dates, and items are moved only after the user confirms them.
- Undo ends when the scan closes. The old dates stay in the job record, but no page reads them yet.
- The saved old dates hold item keys and file names, in this browser only.
