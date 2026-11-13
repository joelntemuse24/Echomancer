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
- `modalCloneSectionChars` — **4,000** characters after section 0 (~4.2 min).
  Section 0 stays **1,000**. A cold call holds two of the steady rows. A
  warm call carries the largest prefix under the 400s wait and the ~57,000
  character / 80 MiB cap, about twelve or thirteen rows. It is not sized
  so playback at 1.5× stays ahead.

## Current schedule

Section 0 is one quick section. Every later section is the steady width.
The next GPU call is the largest proxy-safe batch, not a page grown so a
1.5× listener cannot catch up. A book of 20,000 characters or less shares
an already-running H100, one call at a time, even when the GPU ceiling
still has room. An idle restored container (`warm_containers` above the
other live leases) is a warm start for the next book. The worker's warm
hold is 10s. The live autoscaler target is `scaledown_window=15`, set by
`scripts/s2/set-live-autoscaler.py` after the worker that holds for 10s is
restarted. That script does not deploy. Until it is run, production stays
at the previous 45s window; a 10s hold is safe under that longer window.

Dollars in `modal-clone-short-book-cost.test.ts` use this planner curve
plus restore and idle at $3.95/h. They are estimates. The curve is ~2.8×
for one row and ~8.8× at four or more rows. The 24-row smoke was ~33×.
A 13-wide page is not that smoke.

## The previous ramp, kept as the measurement it was

The numbers below are the schedule this file described before the
4,000-character width. They are not the current plan.

## The ramp, after the container has answered

The 8,000-character cap assumes the call might still be restoring. Production
runs `MODAL_S2_READY=0`, so every call used to be planned that way and a
restored H100 rendered about four rows of a 24-row batch. Sending all 24
the moment section 0 returns is the other failure: section 0 is about a
minute of audio, the 24 rows come back together, and the listener waits
through the whole call.

`planModalCloneBookWave` keeps the cold cap for the first call and for any
call whose last success is older than `MODAL_S2_WARM_HOLD_MS` (default 30s,
under the 45s autoscaler target). After a successful answer each next
call is the largest prefix that finishes before the buffered audio runs out:

```
one row       = 33 chars/s          (smoke: 1,300 chars in 39.85s)
8 rows        = 28.3 chars/s/row    (15% under the measured 266 chars/s)
14 rows       = 22.5 chars/s/row    (15% under 371)
24 rows       = 21.9 chars/s/row    (15% under 617; measured e2e was 528)
transfer      = 12s per 43,907 characters (58.7MB on that 24-row call)
restore       = 38s on the opening call only (57.05s wall − 18.8s server)
narration     = 15.85 characters per audio second
slack         = max(15s, 10% of the buffer), including a one-row call
warm wait     = 400s (MODAL_S2_WARM_WAIT_MS, ceiling 482s)
warm cap      = min(380s × 150, ~80 MiB of base64) = 57,000 characters
```

The 150 chars/s figure is only that character cap. It is not the listener
wall. A row is also never planned faster than 33 chars/s, so one long row
cannot hide inside a wide call's average.

Clone section 0 is **1,000** characters, not the 800-character opening the
other providers use. The wall includes 3s of publish/loudnorm. Its planned
cold wall is **71,576 ms**, under the 75s first-light wait. Warm first
audio is **33,576 ms**. The planning buffer is wall time left at 1.5×:
`floor(delivered / 1.5) − elapsed`. A call subtracts its wall directly.
A seek ahead of the delivered audio is 0.

The next call is **786** characters (the row that leaves 15s inside the
1,000-character opening played at 1.5×). Its warm wall is **27,033 ms**.
The margin is **15,027 ms** at 1.5× and **36,058 ms** at 1×. The call
after that is **984** characters, wall **33,087 ms**. That is the
tightest 1.5× margin, **15,000 ms**. The ramp then continues at **1,255**
and **1,628** characters, and later sections stay 2,000. A real opening
that closes short of 1,000 recomputes each of those caps from the audio
it actually produced.

A short piece skips the ramp when one call adds no generation beyond
section 0. The listener's extra wait is only the transfer of the rest of
the text. Two rows at the curve above are a little slower per row than one
row at 33 chars/s, so a second section of 1,000 characters already adds
generation. The bound is **1,959 characters** (opening 1,000, second
section 959): about **2.1 minutes** of audio. At that boundary the extra
transfer is **262 ms** (cold wall **71,838 ms**, warm **33,838 ms**),
first audio is still inside the 75s first-light wait, and total time is
one call instead of two. A 786-character second section adds no generation
and can ride in that opening call. A longer second section, or any
2,000-character row, does not. A 5-minute article ramps.

One book does not stall. Time to first audio stays **71,576 ms**
cold and **33,576 ms** warm. The tightest margin at 1× is the second call
(**36,058 ms**). The tightest margin at 1.5× is the third call
(**15,000 ms**). Warm wall is the cold wall minus the 38s restore.

| Piece | Calls | Wall, cold | Wall, warm |
| --- | --- | --- | --- |
| ~5 minutes | 1, 1, 1, 1, 1 | 198,390 ms | 160,390 ms |
| ~10 minutes | 1, 1, 1, 1, 1, 2 | 290,507 ms | 252,507 ms |
| ~40 minutes | 1, 1, 1, 1, 1, 3, 14 | 387,572 ms | 349,572 ms |
| ~2 hours | 1, 1, 1, 1, 1, 3, 16, 24, 12 | 588,152 ms | 550,152 ms |
| ~10 hours | 1, 1, 1, 1, 1, 3, 16, then eleven 24s | 1,576,533 ms | 1,538,533 ms |

Each clone book gets its own H100 until `MODAL_S2_MAX_GPUS` (default 20)
and `MODAL_S2_MAX_GPUS_PER_USER` (default 5). The count is a row in
`modal_gpu_leases`, one per book, renewed with the take-home heartbeat
and expired if that worker dies. A book still sends one call at a time.
Past either ceiling the oldest waiter shares the oldest holder's call
schedule, and younger waiters wait.

Under the ceiling every listener is the single-book ramp. One, two, three,
or ten concurrent 10-hour books (different users, or three from one user)
each finish in **1,576,533 ms**, first audio **71,576 ms**, tightest margin
**36,058 ms** at 1× and **15,000 ms** at 1.5×. Peak GPUs is the book count.

A sixth 10-hour book from the same user shares GPU 1. Peak stays **5**.
That pair is the overflow schedule: **3,056,922 ms**, first audio
**71,576 ms** and **165,272 ms**, tightest margins **−5,356 / −53,121 ms**
and **+29,789 / −23,036 ms**. The other four books keep the 15s floor.
One row is **64,153 ms** of wall and about 84s of audio at 1.5×, so the
overflow scheduler still prefers a wide call. A growth call wider than the
buffer is posted (`committedCall`); planning it again would shrink it to
one row and both listeners would stall for the whole book (the old
**36,439,973 ms** total).

A 10-hour book plus a 40-minute article that starts at 5 minutes uses two
GPUs. The book is unchanged (15s floor, no stall). The article is its own
cold ramp: first audio **371,576 ms**, the same 15s floor, finished at
**687,572 ms**. Fleet wall stays **1,576,533 ms**. Peak GPUs **2**.

Three 10-hour books with the global ceiling set to 2 use **2** GPUs. The
oldest and the third share (the 3,056,922 ms pair above). The middle book
stays on the solo ramp and keeps the 15s floor. Fleet wall is
**3,056,922 ms**.

One `synthesize_batch` still carries one reference and one seed
(`s2_clone_service.synthesize_batch`, `S2Engine.render`). Rows from two
books in that call would be spoken in the top-level voice. Per-item
references need a Modal redeploy and a new snapshot.
`MODAL_S2_MIXED_BOOK_BATCH` defaults off, and the tick does not send that
payload. `planMixedCloneBatch` is the worker side for after that deploy.

24 × 2,000 is 48,000 characters: about 105s at the planning curve, inside
the 400s wait. The 24-row smoke body (43,907 characters, 58.7MB) arrived
whole. `MODAL_S2_WARM_LANE_MAX_CHARS` can only lower the cap; `8000` is the
rollback toward the cold shape.

One book, one call at a time, on its own GPU. A second book gets a second
GPU until the ceiling. The overflow share is one call at a time on the
holder's GPU, and that partner's first call is still one section. A shared
call is the widest feeding call the buffers can hold, and a growth call
when none of those leave the slack. One row is only the last section of a
book.

`MODAL_S2_LANE_MAX_CHARS` can only **lower** the cap. That is deliberate: the
stopgap must not be able to recreate the oversized pack.

## Retry shape

A multi-section call that misses its budget is a **rate miss**, not a restore.
Dispatch retries it **one section per call** and does not kick the snapshot
warm. Only a **single-section** placement that never came back is treated as
cold, which is still the case the off-path `::cover` exists for (#237: a book
never waits on a compile).

A book frozen before this fix is re-packed while section 0 is still
unpublished, when any row is wider than the cold abort or sections 0–2 are
wider than the ramp (1,000 / 786 / 984, then 1,255 and 1,628). After section 0 is published,
only the unpublished tail is re-packed, and only when its next row is over
that cap. Published timestamps are not moved.

## Verifying a deploy

```bash
pm2 logs echomancer-takehome --lines 300 \
  | grep -E 'S2 lanes=|pack evenFanout|re-packing|exceeded its budget'
```

Healthy:

- `pack evenFanout=… target=4000` — the clone width after section 0, not 7797
- `S2 lanes=1 batch=24 …` and `book wave pool=warm cold:1 then warm:N`
  on the first claim, where N is the largest proxy-safe page (about 13
  rows of 4,000 characters). A second runnable book stops the tick after
  one call. A wide page on the call immediately after section 0 is the
  schedule.
  A `cold:` page stays **at or under 8,000** characters. A `warm:` page
  stays at or under `modalWarmLaneCharLimit` (57,000 at the defaults)
  and at or under 24 rows.
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
