# Clone lane budget: one call, one row, one wait

`job 7e4a8b48` (2026-11-06) had **43s to first audio** and then rendered **one of
five sections in nine minutes**. It was not slow. It was a loop that could not
succeed, and it came from a single constant that was wrong about what "realtime"
measures.

This file is the invariant that came out of it, the arithmetic behind it, and
what to check when a clone book stalls again.

## The invariant

> **Never schedule a call that cannot finish inside the wait it can be granted.**
> That applies twice: to the **call** (sum of its rows) and to each **row**
> (one section).

Both bounds are required. Fixing only the call still lets a single oversized
section sit on the critical path forever, because rows render in sequence.

## What actually happened

| | |
|--|--|
| Pack line | `evenFanout=4 sections=5 target=7797 first=797` → four ~7.7k sections, ~31k chars |
| Planned | **one** `synthesize_batch` call holding sections 1–4 |
| Cap it was packed against | `60s × 2,900 chars/s × 0.5` = **87,000** characters |
| Real outcome | 4m03s of H100, never finished; worker aborted at 150s |
| Then | resent the same pack, twice, while two GPUs rendered the same rows |
| Also | marked a *warm* container as a cold placement → kicked a full snapshot compile |

Section 0, by contrast, worked end to end: prewarm, restore, firstLight, cache
key, and skipped Whisper all fired. TTFA was ~43s. The regression was entirely
in `planModalCloneLanes` and the two numbers feeding it.

## The unit error

`2.9x realtime` means **2.9 audio seconds per wall second**. It does not mean
2,900 characters per second. At the product's 900 characters per audio minute
(15 per audio second):

```
2.9 x 15  = 43.5 chars/s   (one row)
```

The old constant was **67x too high**. Everything downstream followed: an
87,000-character cap looked conservative, so first-fit packed the entire
remaining book into one call.

The two measurements from that book:

| Shape | Measured | Implied rate |
|--|--|--|
| one row: 797 chars, 2 paragraph units | 15.9s of generation | **50 chars/s**, ~8s per 400-char unit |
| four rows: ~31k chars | still unfinished after 243s | **≥127 chars/s** aggregate |

A row is *sequential*: each paragraph unit carries the previous one as history.
So a 7.7k section is ~20 units ≈ **154s of generation on its own**, before any
restore. No lane count, retry shape, or packing trick can fix a row that is
larger than a whole call. That is why section size is part of this fix.

## The budget, as implemented

```
generation budget = MODAL_S2_COLD_WAIT_MS - MODAL_LANE_RESTORE_MARGIN_MS
                  = 150s - 70s
                  = 80s

lane cap          = 80s x 100 chars/s
                  = 8,000 characters
```

- `modalLaneCharCap` — per-call bound. **8,000** at production defaults, which
  is exactly the operator's `MODAL_S2_LANE_MAX_CHARS=8000` stopgap, arrived at
  independently.
- `modalLaneCharCeiling` — hard bound even an override cannot cross. The widest
  wait a lane may ever get is `MODAL_CLONE_COLD_WAIT_MAX_MS` (180s), minus prep.
- `modalLaneWorkMs` — the wait handed to the HTTP call, derived from that call's
  own text at the worse of the aggregate and single-row rates. The packer and
  the timeout therefore cannot disagree.
- `modalCloneSectionChars` — **2,000** characters per clone section (~40s as a
  row). Four of them still batch into one 8,000-char call, so batching survives.

`MODAL_S2_LANE_MAX_CHARS` can only **lower** the cap. That is deliberate: the
stopgap must not be able to recreate the oversized pack.

## Retry shape

A multi-section call that misses its budget is a **rate miss**, not a restore.
Dispatch retries it **one section per call** and does not kick the snapshot
warm. Only a **single-section** placement that never came back is treated as
cold, which is still the case the off-path `::cover` exists for (#237: a book
never waits on a compile).

A book frozen before this fix, whose sections are wider than the cap, is
re-packed **once and only while nothing has been published**. Once a section is
stored, the outline is the book someone is hearing and is left alone.

## Verifying a deploy

```bash
pm2 logs echomancer-takehome --lines 300 \
  | grep -E 'S2 lanes=|pack evenFanout|re-packing|exceeded its budget'
```

Healthy:

- `pack evenFanout=… target=2000` — the clone width, not 7797
- `S2 lanes=… batch=24 …` and each `page of N rendered N/N` with the page's
  characters **at or under 8,000**
- no `multi-section call missed its budget` line
- `first=0:staged@Ns` for the first audio

Unhealthy:

- `multi-section call missed its budget; retrying […] one section per call`
  — the rate changed (slower GPU, longer units). Lower
  `MODAL_S2_SECTION_CHARS`, not the lane cap.
- `re-packing before the first section renders` on every tick — the re-pack is
  not persisting, check storage writes.
- `placement missed restore budget` on a pool that answered — a regression in
  the placement classification.

## Why not simply lower the lane cap

Lowering the cap alone fixes the *call* and leaves the *row* broken. With four
7.7k sections and an 8,000 cap, each section rides alone in a 7.7k call, and
7.7k as one row needs ~154s of generation — still more than the budget. The
operator's stopgap buys a correct call shape and nothing more; the book still
cannot finish until its sections are re-packed. That is why this change touches
both the packer and the section width.

## Related

- `docs/s2-gpu-staging-runbook.md` §8d — cold/warm TTFA budgets and prewarm cost
- `modal/s2_batch.py` — `UNIT_TARGET_CHARS=400`, `HISTORY_TURNS=1`, the
  sequential per-slot unit loop that makes a row's time add up
- `modal/s2_clone_service.py` — `_section_units`, one slot per section
