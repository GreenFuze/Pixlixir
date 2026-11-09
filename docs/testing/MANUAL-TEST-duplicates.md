# Manual test — Duplicates

Prereqs: `npm ci && npm run build`, reload Pixlixir in `chrome://extensions`, reload the Google
Photos tab. **Moving to trash is real.** Use test copies: upload a photo, and a smaller copy of it.

1. Side panel → **Bulk operations** → tick only **Duplicates** → **Scan**. Expect "Reading photos",
   "Comparing photos", then groups. A later scan skips the reading.
2. Each group's first photo has a **Best** pill; hover it for why. The others show their similarity and are ticked.
3. Move **Similarity**: groups change at once, without reading anything. 100% shows only the same image:
   burst shots taken seconds apart show less. The first scan after updating says "Looking closer" while it
   reads the close pairs at 1024 px; later scans skip that.
   A crop saved at the same time as its photo shows "100% crop" when nothing else changed.
4. Untick a copy: it stays. Tick the Best photo and untick another: that other one stays instead.
   The last photo of a group cannot be ticked.
5. Look through the groups at a low setting. Report any that are not really the same picture.
6. **Trash N** → the dialog names your account and what happens → **Cancel** changes nothing.
7. Put one copy in an album → **Trash N** → **Move to trash**. The copies leave the list. In Google
   Photos, they are in Trash, and the photo that stayed is now in that album.
8. Put a copy in a shared album and scan again: that group is left alone, with a pill saying so.
9. Side panel → **Recent work** lists "Duplicates moved to trash".

Known limits: crops are only found when saved within 2 seconds of the photo; a small brightness or colour
edit can still show 100%; rotated copies and videos are not found; copies are only found among the photos
looked through, so use **Whole library**; restoring is from Google's Trash page.
