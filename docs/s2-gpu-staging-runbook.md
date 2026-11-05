# S2-Pro Modal: staging runbook

The self-hosted clone path (`modal/s2_clone_service.py`) is deployed but has
**never been proven end to end on the real worker**. Production stays at
`max_containers=1` until every step below has been run and its evidence
recorded here.

Target shape, and the thing this runbook proves:

| Property | Target |
|---|---|
| App | one frozen deployment (`echomancer-s2-clone`) |
| Containers | up to 4 independent **one-GPU** containers |
| `min_containers` | `0` (scale to zero when idle) |
| `max_containers` | 4 after staging sign-off, **1 in production until then** |
| Cold start | snapshot restore, ~90 s |
| User-facing | book generation is asynchronous; the browser never waits |

Multi-GPU inside one container is deliberately not used. Modal documents GPU
memory snapshots as generally incompatible with multi-GPU programs, and the
snapshot is the whole point — without it every cold container spends ~15 min
compiling.

**Nothing in this file spends GPU money by itself.** Steps 1–2 are local and
free; steps 3–7 cost money and are run by the parent assistant.

---

## 0. What is already verified (no GPU needed)

```bash
python3 -m pytest modal -q            # 44 offline contract tests
npm run typecheck && npm run lint
npm run test:run                      # includes the batch-contract and lane suites
```

These cover, without a container:

- the `audio_b64` batch contract against real-server-shaped fixtures
  (`src/lib/tts/providers/modal-clone-contract.test.ts`)
- empty / silent / flat-line reference clips and empty transcripts
  (`modal/test_s2_contract.py`)
- lane planning, batching and deferral arithmetic
  (`src/lib/tts/providers/modal-clone-lanes.test.ts`)
- provider pinning and the cold-pool defer policy

What they cannot cover: that a snapshot actually restores on a GPU, that four
lanes really start four containers, and that a whole book finishes through the
worker.

---

## 1. Deploy a dedicated staging app

The app name comes from `S2C_APP_NAME`, so staging is a **separate Modal app**
with its own snapshots and its own containers. Production is untouched: no
endpoint, secret or autoscaler setting is shared.

```bash
cd <repo>
# A distinct heartbeat dict too, so staging /ready cannot read production's.
export S2C_APP_NAME=echomancer-s2-clone-staging
export S2C_HEARTBEAT_DICT=echomancer-s2-clone-heartbeats-staging
export S2C_MAX_CONTAINERS=4        # the staging target
export S2C_LANES=4
export S2C_SCALEDOWN=300           # long enough to observe a container between steps

modal deploy modal/s2_clone_service.py
```

Record:

- [ ] printed web endpoint URL for `synthesize`
- [ ] printed web endpoint URL for `synthesize_batch`
- [ ] printed web endpoint URL for `ready`
- [ ] the `build=` value printed by the warm script (step 3)

Modal prints one URL per web endpoint. Put the `/synthesize*` one in
`MODAL_S2_TTS_URL` and the `ready` one in `MODAL_S2_READY_URL` when testing the
worker against staging.

**Production rule:** never export `S2C_APP_NAME` when deploying production, and
keep `S2C_MAX_CONTAINERS=1` there until step 7 passes.

---

## 2. Generate the test reference clip

Never use a customer clip for staging. Both generators make the same
deterministic, non-silent 6 s WAV:

```bash
# Python (used by the warm script's default path)
cd modal && python3 -c "
from s2_contract import warm_reference_wav
open('/tmp/s2-staging-ref.wav','wb').write(warm_reference_wav())
"
```

The clip is validated **before** it reaches a GPU. A 0-byte file is exactly what
failed the October snapshot:
`ReferenceClipError: reference clip is empty (0 bytes)`.

Rules a clip must pass (`s2_contract.validate_reference_audio`):

| Rule | Value |
|---|---|
| size | ≥ 4,000 bytes, ≤ 15 MiB |
| first 4 KiB | not all zero |
| duration (WAV only) | ≥ 0.30 s |
| RMS (WAV only) | ≥ 1e-4 (−80 dBFS) |
| distinct samples (WAV only) | ≥ 8 (not a flat line) |
| transcript | non-empty, not a placeholder like `.` / `n/a` / `none` |

---

## 3. Build the snapshot by direct invocation

The Modal web proxy drops a request at ~542 s, so an HTTP call **cannot** build
a snapshot: it 502s and the container dies mid-compile, leaving nothing. Build
it over the client RPC instead, which has no proxy limit.

```bash
cd <repo>
export S2C_APP_NAME=echomancer-s2-clone-staging

# Build + verify + a short synthesis through the clone path.
modal run modal/s2_clone_warm.py --verify --synth --containers 1
```

What to look for:

- step 1 takes **~15 min** the first time (it is compiling), seconds later on
- `build=` prints a 12-character id — record it, every later check compares to it
- the `status()` output includes `restored_s`; a build shows minutes, a restore
  shows tens of seconds

### Why 2–3 snapshots, not one per replica

Modal's docs: *"GPU Functions need 2-3 snapshots per GPU type"*, because
snapshots are specific to the underlying worker type (CPU flags) and functions
run across a handful of variants. Scale-to-zero does **not** invalidate them, but
a redeploy does. So:

- one snapshot does not mean "all four containers restore"
- run step 4 until every container reports `restored`
- after any redeploy, assume zero coverage until re-verified

---

## 4. Verify restores on every worker variant

```bash
export S2C_APP_NAME=echomancer-s2-clone-staging
# Spaced past scaledown_window, so each call gets a distinct container.
modal run modal/s2_clone_warm.py::warm --verify --containers 3 --scaledown 300 --synth false
```

Or start them all at once, which is the real four-lane question:

```bash
modal run modal/s2_clone_warm.py::fanout --containers 4 --scaledown 300
```

Record for each container:

- [ ] `verdict=restored` (not `COMPILED`), and `restored_s` ≈ 60 s or less
- [ ] `build=` matches the id from step 3
- [ ] `container_id` values are distinct (four calls → four containers)
- [ ] `restore time: min / median / max` from the fanout summary

If a container says `COMPILED`, that worker variant has no snapshot yet: re-run
until all are `restored`, or accept 2–3 slow first calls per GPU type.

Check the Modal dashboard → app → **Containers** tab: restored containers are
marked with the restore icon, snapshotted ones with the snapshot icon.

---

## 5. Short synthesis correctness

`--synth` in step 3 already covers the single-section path. For the batch
contract, use the HTTP smoke script (this is the path the worker actually uses):

```bash
MODAL_S2_TTS_URL=https://<synthesize_batch-endpoint> \
MODAL_S2_TOKEN=<token> \
node scripts/s2/staging-smoke.mjs --lanes 4 --sections-per-lane 2
```

Hard checks it makes:

| Check | Pass condition |
|---|---|
| `/ready` | HTTP 200, `ready:true`, a `build` |
| batch rows | one row per section, all with decodable MP3 in `audio_b64` |
| truncation | `truncated_units == 0` on every row |
| containers | ≥ `--lanes` distinct `container_id`s |
| build | one build id across all lanes |
| throughput | prints measured audio-seconds per wall-second |
| consistency | a second identical call still returns rows |

Record:

- [ ] distinct container count
- [ ] per-lane `audio_s` / `wall_s` and the realtime multiple
- [ ] `performance.prepare_s`, `generate_s`, `codec_s`, `encode_s`
- [ ] `performance.restored_s` (proves the call ran on a restore, not a compile)

A WER check on a synthetic clip is not meaningful — the clip is a tone, not
speech. WER is measured on a real voice in step 7 only, on a **synthetic book**.

---

## 6. Four simultaneous one-GPU containers

This is the scale check. Cost is four H100s for the duration.

```bash
MODAL_S2_TTS_URL=https://<synthesize_batch-endpoint> \
MODAL_S2_TOKEN=<token> \
node scripts/s2/staging-smoke.mjs --lanes 4 --sections-per-lane 4
```

Expected:

- 4 calls start at once, each on its own container (Modal starts one container
  per concurrent call)
- warm throughput is roughly flat versus one lane, because each container is
  independent — this is the whole reason for replicas instead of multi-GPU
- `perf.generate_s` per lane is comparable, not one lane carrying everything

Estimate the cost before running:

```
GPU cost ≈ containers × (restore_s + call_wall_s + scaledown_window_s) × $0.0011/s
```

At `S2C_SCALEDOWN=300`, four lanes idle for one scaledown window is
`4 × 300 × 0.0011 ≈ $1.32` on top of the work. Lower `S2C_SCALEDOWN` for the
staging run if you do not need the observation window.

Then prove **scale to zero**:

```bash
sleep 360   # past scaledown_window
MODAL_S2_TTS_URL=… MODAL_S2_TOKEN=… node -e '
const r = await fetch(process.env.MODAL_S2_TTS_URL.replace(/\/synthesize.*$/, "") + "/ready", {
  headers: { "x-echomancer-token": process.env.MODAL_S2_TOKEN },
});
console.log(r.status, await r.text());
'
```

- [ ] `/ready` now reports `ready:false`, `warm_containers:0`
- [ ] the Modal dashboard shows no running containers for the app
- [ ] the next real call restores (not compiles): `restored_s` stays small

---

## 7. End-to-end through the worker, with a synthetic book

Only after 3–6 pass. This is the run that has never been done.

1. Build a synthetic book (no real user book, no real upload):

```bash
python3 - <<'PY' > /tmp/s2-staging-book.txt
for chapter in range(1, 4):
    print(f"Chapter {chapter}.\n")
    for para in range(20):
        print(
            "The river had not moved for three days, and the light on the water "
            f"was a colour nobody in the village had a name for. Paragraph {para} of chapter {chapter}.\n"
        )
PY
wc -c /tmp/s2-staging-book.txt
```

2. Point a **staging** worker at the staging endpoint (never production):

```bash
CLONE_TTS_PROVIDER=modal
MODAL_S2_TTS_URL=https://<staging-synthesize_batch-endpoint>
MODAL_S2_READY_URL=https://<staging-ready-endpoint>
MODAL_S2_TOKEN=<token>
MODAL_S2_SECTION_CONCURRENCY=4     # four lanes
MODAL_S2_BATCH_SIZE=24
MODAL_S2_COLD_WAIT_MS=150000       # restore-sized, not compile-sized
MODAL_S2_DEFER_MS=1500000          # 25 min of parking before any fallback
```

3. Upload the synthetic book as a throwaway anonymous session and make one
   whole-book job with a **test clone** (train a clone from
   `/tmp/s2-staging-ref.wav` in that session).

4. Watch, and record:

- [ ] the job leaves `queued` and the **browser is not waiting** on any request
- [ ] `pm2 logs echomancer-takehome` shows `clone provider pinned to modal`
- [ ] `S2 lanes=4 batch=24 staged=N/M containers=… builds=…`
- [ ] the whole book is `ready`, and `provider_pin` on the row is still `modal`
- [ ] no section fell back (the job has no `warning`, and `GET /api/jobs/<id>`
      never showed a narrator switch)
- [ ] total Modal spend is in the expected band for the synthetic book's size

5. Deliberately scale to zero and re-run a **second** synthetic book: it should
   park briefly (`GPU pool cold … parking`) and then finish on Modal, still with
   a single narrator.

### Cold-start behaviour to confirm

While the pool is cold, a tick must:

- release the lease and set the row back to `queued`
- set `clone_wait_started_at`
- **not** consume one of the section's two attempts
- **not** switch engine until `MODAL_S2_DEFER_MS` has passed

Once the budget is gone it pins the book to `drama3` for the rest of the book and
writes `CLONE_COLD_TIMEOUT_WARNING` onto the job, so the person sees why the
voice changed.

---

## 8. Promote to four lanes in production

Only with every box above ticked and evidence pasted into the PR.

```bash
unset S2C_APP_NAME               # production app
export S2C_MAX_CONTAINERS=4
export S2C_LANES=4
modal deploy modal/s2_clone_service.py
modal run modal/s2_clone_warm.py --verify --containers 3
```

Then on the worker:

```bash
MODAL_S2_SECTION_CONCURRENCY=4
MODAL_S2_BATCH_SIZE=24
```

### Rollback, in order of blast radius

| Symptom | Action |
|---|---|
| Clone audio is wrong / silent | `CLONE_TTS_PROVIDER=openrouter` on the worker → Drama 3 only. No deploy needed. |
| Clone path errors | remove `MODAL_S2_TTS_URL` → clones use Drama 3 automatically. |
| Cost or container runaway | `S2C_MAX_CONTAINERS=1`, redeploy. Or live: `modal run -m …` is not needed — use the dashboard's autoscaler panel, or `f.autoscaler.update(max_containers=1)`. |
| Books stuck parked | `MODAL_S2_DEFER_MS=0` → old fail-fast behaviour (switches to Drama 3 on the first cold answer). |
| Bad deploy | redeploy the previous commit; **the snapshot is rebuilt**, so re-run step 3–4. |

A book that is already `ready` is never re-synthesized by any of these.

---

## 9. Evidence checklist for the PR

Copy this into the PR description, filled in.

```
Staging app:        echomancer-s2-clone-staging
Build id:           __________
Snapshot build:     built in ____ s on ____-__-__ (ISO date)
Restores observed:  __ / __ containers restored (restored_s: min __ median __ max __)
Four-lane fanout:   __ distinct containers, wall ____ s
Throughput:         ____ s audio / ____ s wall = ____ x realtime (4 lanes)
Per-lane generate:  lane0 __ s, lane1 __ s, lane2 __ s, lane3 __ s
Scale to zero:      /ready ready:false after ____ s idle; dashboard containers = 0
Re-restore:         restored_s = ____ s (not a compile)
E2E synthetic book: job ______ → ready; provider_pin=modal throughout; warning=null
Cold-pool parking:  observed __ times; sections retried __ ; attempts burned 0
Cost:               $____ for the synthetic book (____ chars, ____ h audio)
```

---

## Known traps

| Trap | Why | Fix |
|---|---|---|
| HTTP call to build the snapshot | web proxy ~542 s limit kills it mid-compile | always `modal run modal/s2_clone_warm.py` |
| One snapshot per desired replica | snapshots are per **worker type**, not per container | 2–3 per GPU type, verify each |
| Multi-GPU container | documented incompatible with GPU snapshots | one GPU per container, scale with replicas |
| Snapshot holds customer audio | KV cache + `_last_audio` are one book's speech | `engine.reset_state()` before the snapshot mark |
| Restored snapshot replays a take | RNG state is captured | seed from `(job, section, epoch)` every call |
| `/ready` says ready while compiling | a compiling container is already a runner | heartbeat after the post-restore hook only |
| A 3rd `enter()` method | `@modal.enter()` takes no args; `snap=` only | at most one `snap=True` plus one plain |
| Silent narrator switch | per-section fallback | pin on `jobs.provider_pin`, warn on change |
| Duplicate charge on retry | retry re-renders | `seed_epoch` + section cache + lease |
