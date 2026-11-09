# ADR-0008: Duplicates by looks, with a similarity the user chooses

**Status:** accepted (2026-11-05)

**Context.** Google Photos has no image-based de-dup where the user chooses how similar photos
must be. The owner wants one, including a 100% setting that is not a byte match, with the best
photo selected automatically and everything else going to trash, never a permanent delete.

**Decision.**

1. *A scan detector*, `DuplicatesDetector`, next to panoramas and wrong dates: same scopes,
   progress and tabs. It compares only the photos in scope, so copies with other dates are only
   found when the scope includes them.
2. *`blockhash-core` (MIT) on a 64 x 64 copy, 256 bits.* No browser library does the whole job.
   Measured against a hand-written 256-bit gradient hash and 64-bit DCT pHash, it separated the
   same picture from unrelated photos best (table below). The 128 px rendition costs about 5 KB.
   The browser's high-quality resize is required: a plain canvas downscale changed the hash.
3. *A pixel check on every match.* Hashes also match by accident: real pairs at distance 20 were
   52 apart in pixels. 16 x 16 RGB is saved with the hash, so this needs no download.
4. *Scale.* `similarity = 100 x (1 - distance / 128)`, 75 to 99, where 128 is what unrelated photos
   measure. Distance at most 16 and pixels at most 3 apart gives 100 before the fine check (11),
   which then decides. Links from prints are only made between photos of the same shape; crops come
   from (12).
5. *The slider lives in the results.* The detector emits one index of all links at the loosest
   setting; regrouping is instant and reads nothing.
6. *Groups cannot chain.* Each group is its best photo plus what is similar enough to that photo.
7. *Best copy.* Yours first, then most pixels, largest file (`EWgK9e` `[1][9]`, equal to `fDcn4b`
   `[0][5]` on 10 of 10 real items), a location, the oldest. The reason is on the Best pill.
8. *What a copy leaves behind.* Trash removes a copy from its albums, so the kept photo first joins
   them and takes a description it lacks, and that is read back. A group with a copy in a shared
   album is left alone, because shared-album adds are not verified. A kept photo that would lose
   a location gets a warning pill: setting one on an existing item is not implemented.
9. *Trash* goes through `TrashMover`, shared with panorama originals: a move counts once the trash
   lists it. Someone else's photo is never moved, and a group always keeps a photo.

10. *A closer look (2026-11-07), replaced by (11) the next day.* The owner's rule: everything visible must match, whatever the size.
   The prints above compare whole pictures, so a small change passes. Each pair at 88% or more now
   compares the worst cell of a 32 x 32 grid (`DetailComparer`, read from the 256 px rendition and
   saved, so only those photos are read, and only once). At most 34 keeps the score; beyond that it
   falls by 1% per 2. A pair that could not be read stops at 99%. Prints saved earlier stay valid.
   The results also stopped dimming a photo ticked for trash: at 65% opacity a true copy looked like
   a different picture beside its best copy, which is how the owner first reported this.

11. *The fine check (2026-11-08).* The owner's rule, made precise: 100% is the same image, at any
   size, possibly cropped, never edited; burst shots a second apart must score less, like 95%. Their
   own pair at 1600 x 1198 had reached 100%. The closer look (10) let 19 of 278 close burst pairs
   through. Each pair at 88% or more is now compared at Google's rendition of up to 1024 px, in
   brightness, square by square (`FineComparer`, 64 squares across, at least 8 px): no square more
   than 35 apart keeps the score; beyond that it falls by 1% per 2, down to 75%. The larger photo is
   resized to the smaller one's rendition, so both show the same detail. The pixels are too large to
   save, so each pair's result is saved instead, and a photo is read once while its pairs are compared.
   A pair that could not be read stops at 99%.
12. *Crops (2026-11-08).* The owner counts an unedited crop as 100%. Prints cannot match a crop, so
   photos saved within 2 s of each other, smaller on a side, are lined up: a correlation search over
   every scale down to 30% of the width and every place at 64 px, refined at 256 px, accepted at 0.9 or
   more (`CropLocator`); then moved and scaled in four steps up to 1024 px to where it matches best,
   and given the fine check on the part it covers. Where it sits is saved, as is the check. A crop shows "crop" beside its percentage, and the uncropped photo
   is kept. Photos with more than 5 others within 2 s are skipped: imports often share one time.

**Fine check, measured** (2026-11-08, read-only, numbers only; `/u/1`, 108,202 items; the production
code; worst square, 0 to 255; 35 is the limit). Burst pairs are two shots of the same size taken
0.2 to 10 s apart, so certainly different exposures. Copies are made in the browser from Google's
2048 px rendition and compared with Google's 1024 px rendition, a harder case than two of Google's.

| Pair | n | min | p5 | p50 | p95 | max | Over 35 |
|---|---|---|---|---|---|---|---|
| Close burst shots (88% or more by prints) | 153 | 13.9 | 80.8 | 146.6 | 208.3 | 227.4 | 151 |
| Copy at 800 px, JPEG 80% | 120 | 2.8 | 5 | 10.3 | 28.4 | 51.4 | 2 |
| Copy recompressed at JPEG 60% | 120 | 3.8 | 7.7 | 12.3 | 21 | 49.6 | 2 |
| Copy at half size | 120 | 3.9 | 6.7 | 9.8 | 15.8 | 27.5 | 0 |
| A crop of the other burst shot, lined up with this one | 114 of 153 found | 9.7 | 62.4 | 126.6 | 186.8 | 208.8 | 112 |

**Crops, measured** (same day; 80 photos of `/u/1`; a crop cut from Google's 2048 px rendition, saved as
JPEG 85%, against Google's 1024 px rendition of the photo, after the four-step refinement).

| Crop | Found | min | p5 | p50 | p95 | max | Over 35 |
|---|---|---|---|---|---|---|---|
| 80% of the photo, centred, 1000 px | 78 | 2.7 | 5.9 | 14.5 | 31.5 | 46.2 | 1 |
| 55%, off centre, 900 px | 77 | 3.4 | 4.5 | 13.5 | 33.3 | 117.2 | 2 |
| 60% x 50%, another shape, 700 px | 76 | 5 | 6.5 | 17.4 | 72.8 | 91.6 | 17 |

9 of 240 crops were not found. With one refinement step at 1024 px only, 14, 21 and 47 of the crops
were over 35. On the library, 400 random candidates gave 2 crops (one under 35); with the limit of 5
neighbours there are 3,393 candidates. Lining one up took 0.28 s at p50 in the page (1.2 s worst);
the check of a found crop took 2.4 s at p50.

The first measurement, before the code was written (browser resize at 1024 px, same limit), had
276 of 278 close bursts over and 0 of 360 copies. Of 300 random burst pairs, 1 reached 100% by prints
and 45 were linked at all.

**Measured on the owner's library** (2026-11-05,, read-only, numbers only; 120 photos of `/u/1`; worst cell, 0 to
255). A label is drawn on a recompressed copy; each copy goes through a 256 px rendition.

| Against the same photo's 256 px rendition | min | p5 | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|
| Google's own 1024 px rendition | 3.3 | 5.7 | 22.2 | 33.8 | 61.3 | 100.9 |
| Recompressed at JPEG 50% | 4.8 | 6.1 | 19.8 | 30.7 | 59.8 | 101 |
| 10% brighter | 17.6 | 19.2 | 27.3 | 37.9 | 63.3 | 96.9 |
| A label 8% x 3% of the picture | 17 | 52.4 | 95.6 | 132.3 | 145.8 | 149.4 |
| A label 4% x 3% | 33.8 | 37.8 | 51.3 | 59.8 | 65.5 | 100.8 |
| A blurred patch 12% x 12% | 5.3 | 14.3 | 30.3 | 51.7 | 66 | 107.1 |
| The next photo in the timeline | 56.3 | 83.4 | 163.7 | 202.8 | 224.9 | 228.3 |

Worst cell at 16 x 16, which needs no new read, was tried first and separated less: a 4% x 3% label
had p50 16.7 against 11.7 for a recompressed copy. Abs difference per pixel, with or without a one-pixel
shift, separated less than the mean of each cell.

**Measured on the owner's library** (2026-11-05, read-only, numbers only; 2,496 photos, 120 sampled
for the controls; distance in bits of 256).

| Pair | Hash distance (p50, p99) | 16 px difference (p50, p99, max) |
|---|---|---|
| Same picture, Google's 256 px rendition | 8, 22 | 1.6, 3.2, 4.2 |
| Same picture, 512 px recompressed at JPEG 50% | 10, 22 | 4.6, 8.4, 12.4 |
| 10% brighter | 10, 31 | 11.6, 17.3, 18.8 |
| Cropped 3% | 32, 58 | 9.8, 15.6, 19.6 |
| Neighbours within 30 s (lowest 1%, 5%, 25%) | 6, 17, 44 | 2.6, 5.3, 13.4 |
| Unrelated (lowest 0.05%, 1%, 5%) | 50, 80, 96 | 11.7 at 64 px |

Other hashes on the same control and random pairs: gradient, same picture up to 74, unrelated from
71, so no gap; pHash 64-bit, same picture up to 12, unrelated from 16, too coarse for a slider.

| Setting | Groups | Photos | Pairs more than an hour apart |
|---|---|---|---|
| 100% | 19 | 42 | 11 of 28 |
| 95% (default) | 28 | 61 | 11 of 40 |
| 90% | 52 | 112 | 11 of 73 |
| 85% | 90 | 199 | 11 of 149 |
| 80% | 149 | 343 | 20 of 293 |
| 75% | 196 | 455 | 40 of 459 |

Reading 128 px renditions took 132 s for 2,496 photos (8 at once; 8 s once cached). Comparing all
pairs took 0.25 s.

**Consequences.**

− These figures come from controls and counts, not from anyone looking at the groups: the controls
  simulate a second copy, and this library has few real ones. Limits may need adjusting.
− About 1 in 60 copies in the controls is over the fine check's limit and shows less than 100%; 2 of
  153 close burst pairs stay under it. These are controls: real pairs have not been judged by anyone.
− An edit of the whole picture, such as 3% brighter or a little more colour, cannot be told from
  recompression this way, so it can still show 100%. A signed brightness difference was not measured.
− The first scan after this change reads every photo in a close pair at 1024 px: many times the 128 px
  prints. How long that takes on a large library was not timed.
− Crops saved more than 2 s from their photo are not found, nor crops in batches sharing one time.
  A crop of another shape shows less than 100% about 1 time in 5; about 1 crop in 25 is not found.
− The first scan lines up every crop candidate: about 3,400 on the owner's library at 0.28 s each, so
  roughly a quarter of an hour of work in the page, estimated, not timed. Results are saved.
− A rotated copy has another shape, so it is not found. Videos are not compared.
− About 1% of same-picture controls landed beyond distance 32 (worst 64), so some copies are missed even at 75%.
− Comparing grows with the square of the photos: about 7 minutes at 100,000 by extrapolation, untimed.
− Restoring is by Google's Trash page; Pixlixir has no restore call yet (G-13).
