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
   measure. 100% means distance at most 16 and pixels at most 3 apart, the same picture once at the
   same size. Links are only made between photos of the same shape.
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
− "100%" compares at thumbnail size: burst shots that differ in a small detail can reach it.
− A rotated copy has another shape, so it is not found. Videos are not compared.
− About 1% of same-picture controls landed beyond distance 32 (worst 64), so some copies are missed even at 75%.
− Comparing grows with the square of the photos: about 7 minutes at 100,000 by extrapolation, untimed.
− Restoring is by Google's Trash page; Pixlixir has no restore call yet (G-13).
