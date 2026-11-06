# S2-Pro Modal: staging runbook

The self-hosted clone path (`modal/s2_clone_service.py`) was proven on staging
on build `2c43f284208e` (commit `e4e2d54`): **one-GPU restore** and **4-GPU
fanout** both passed, which is the snapshot/restore and lane evidence from steps
3–6. Staging did **not** run an end-to-end book through the worker, so step 7's
checklist is still the thing to record before sending real books down this path.

Production promotes the same build, but its lane count is raised **at runtime**
after the deploy — see step 8. The code default stays `max_containers=1`, and
every production deploy leaves it there.

Target shape, and the thing this runbook proves:

| Property | Target |
|---|---|
| App | one frozen deployment (`echomancer-s2-clone`) |
| Containers | up to 4 independent **one-GPU** containers |
| `min_containers` | `0` (scale to zero when idle) |
| `max_containers` | 4 in production, raised by a **runtime override** after each deploy (the deploy-time env stays 1) |
| Cold start | snapshot restore, ~90 s |
| User-facing | book generation is asynchronous; the browser never waits |

Multi-GPU inside one container is deliberately not used. Modal documents GPU
memory snapshots as generally incompatible with multi-GPU programs, and the
snapshot is the whole point — without it every cold container spends ~15 min
compiling.

**Nothing in this file spends GPU money by itself.** Steps 1–2 are local and
free; steps 3–7 cost money and are run by the parent assistant. Step 8 deploys
production and spends GPU time (warm, fanout), but 8c itself only changes the
live autoscaler.

---

## 0. What is already verified (no GPU needed)

```bash
python3 -m pytest modal -q            # offline contract tests (no GPU)
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

## 0a. Retest the four defects staging found

Each of these was hit on build `c0794f02b142` and each now has an offline guard.
Run them in this order after deploying a new build; every one of them fails
loudly rather than degrading quietly.

| # | Defect found on staging | Offline guard | Live retest |
|---|---|---|---|
| 1 | `POST /synthesize_batch` → 500 `CUBLAS_STATUS_ALLOC_FAILED when calling cublasCreate(handle)` in `_qkv` → `wqkv`, while `.remote()` worked in the same container | `modal/test_s2_service_import.py::test_batch_handler_runs_every_gpu_call_on_the_owner_thread` and `…single_section_handler…` record the thread id of every engine call | step 5a — one HTTP `/synthesize` on a restored container |
| 2 | `restored_s` measured from `compiled_at`, which is frozen in the snapshot, so restores looked huge and compiles small. The first fix used the process id, which staging also disproved: Modal runs the app as **pid 2** both before and after a restore, so real restores reported `compiled` | `…::test_boot_kind_only_claims_restore_when_provable`, `…::test_boot_kind_never_reports_compiled` and `…::test_no_metric_called_restored_s_is_derived_from_the_snapshot_mark` | step 4 — record each container's `boot`, and rely on Modal's log line for the authoritative verdict |
| 3 | smoke + client built `${baseUrl}/ready` and `${baseUrl}/synthesize_batch`, which 404 because each endpoint is its own hostname | `src/lib/tts/providers/modal-endpoints.test.ts` (asserts the exact URL per endpoint) and `modal/test_s2_endpoints.py` | step 5 — the smoke script refuses a URL with a path |
| 4 | a fresh (non-restored) container was never checked against defect 1 | the selftest runs inside `@modal.enter(snap=True)`, i.e. on the compile path too, and the fix is thread-affinity rather than snapshot-specific | step 0a **twice**: once on a brand-new deploy, once after scale-to-zero |

If the HTTP call still fails after this change, capture:

```bash
modal app logs echomancer-s2-clone-staging --since 15m | grep -E 'S2C|selftest|CUBLAS|gpu_thread'
```

The boot line now prints `pid` and `gpu_thread`; the two must differ from the
`pid` in the HTTP error, or the handler is still running on the owner thread.

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

These are **three different hostnames**. There is no `/ready` route on the
synthesize host and no `/synthesize_batch` route on the ready host, so record
each full URL and set one env var per endpoint. The client and the smoke script
both reject a URL that carries a path.

Modal prints one URL per web endpoint. Put the `/synthesize*` one in
`MODAL_S2_TTS_URL` and the `ready` one in `MODAL_S2_READY_URL` when testing the
worker against staging.

**Production rule:** never export `S2C_APP_NAME` when deploying production, and
deploy with `S2C_MAX_CONTAINERS` unset (i.e. 1). Keep it at 1 through step 7;
once step 7 passes and production has been deployed and warmed, the four lanes
come from the **runtime** `update_autoscaler` call in step 8 — not from a
redeploy with `S2C_MAX_CONTAINERS=4`.

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
| duration | ≥ 0.30 s |
| RMS | ≥ 1e-4 (−80 dBFS) |
| distinct samples | ≥ 8 (not a flat line) |
| transcript | non-empty, not a placeholder like `.` / `n/a` / `none` |

Duration, RMS and flat-line apply to **every** container, not just WAV.
`decoded_reference_stats` decodes a non-WAV clip through ffmpeg first, so an
MP3/M4A/WebM reference is measured rather than waved through as `"opaque"` with
`seconds: None`. WAV still uses the standard-library reader and no subprocess.

Reference decoding never goes through `torchaudio.load` or `av.open`.
`torchaudio.load` is PyAV-backed on this image, and the PyAV under
fish-speech's lockfile predates the `metadata_errors` kwarg that current
`faster-whisper` passes to `av.open` — on 2026-11-06 that made every non-WAV
reference raise `TypeError: open() got an unexpected keyword argument
'metadata_errors'` and answer HTTP 500 on all four lanes (`job 5f09ee0e`).
`modal/test_s2_reference_decode.py` decodes real MP3/M4A/OGG/FLAC/WebM/WAV
fixtures and fails if either library reappears on that path.

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

A customer book never runs this. Its HTTP wait is the restore budget (default
150 s, hard ceiling 180 s). A compile that a book abandons is finished by
`::cover` below, which is the same RPC and has no proxy limit.

What to look for:

- step 1 takes **~15 min** the first time (it is compiling), seconds later on
- `build=` prints a 12-character id — record it, every later check compares to it
- `boot=` is `restored` only when a restore is **provable**, and `unknown`
  otherwise. There is no `compiled` value, because a container cannot prove it
  compiled. Two earlier attempts to infer it were wrong: `now - compiled_at`
  (that mark is frozen inside the snapshot, so it was inverted), then the
  process id (Modal runs the app as **pid 2** both before and after a restore,
  so every real restore reported `compiled`).
  The surviving signal is the host **monotonic clock going backwards**, which
  can only happen when the image resumed on a different, younger worker. That is
  one-directional, so a forward clock proves nothing and is reported as
  `unknown`.
- **The authoritative verdict is Modal's own log line**, not anything the
  container prints:
  ```bash
  modal app logs echomancer-s2-clone-staging --since 15m \
    | grep -E 'Restoring Function from memory snapshot|Snapshot created'
  ```
- Restore **duration** is not observable from inside the container at all, on
  any boot. Time the first cold HTTP call from outside (step 5a).
- `snapshot_age=` says how old the captured snapshot is, and is only reported
  when the boot was a proved restore — on an `unknown` boot the subtraction could
  mix two hosts' wall clocks, so it is left blank rather than guessed. It is
  never a restore time.

### Why 2–3 snapshots, not one per replica

Modal's docs: *"GPU Functions need 2-3 snapshots per GPU type"*, because
snapshots are specific to the underlying worker type (CPU flags) and functions
run across a handful of variants. Scale-to-zero does **not** invalidate them, but
a redeploy does. So:

- one snapshot does not mean "all four containers restore"
- run step 4 until consecutive calls **restore by wall time**, not until
  `boot=restored` (that label is often `unknown` on a real restore)
- after any redeploy, assume zero coverage until re-verified
- a book is never the process that builds the missing snapshot

---

## 4. Verify restores on every worker variant

```bash
export S2C_APP_NAME=echomancer-s2-clone-staging
# Spaced past scaledown_window, so each call gets a distinct container.
modal run modal/s2_clone_warm.py::warm --verify --containers 3 --scaledown 300 --no-synth
```

(Boolean flags are click options: use `--no-synth` / `--no-verify` to turn one off.)

Or start them all at once, which is the real four-lane question:

```bash
modal run modal/s2_clone_warm.py::fanout --containers 4 --scaledown 300
```

Keep going until consecutive placements restore. `cover` scales to zero
between rounds (so the next fan-out can hit a different worker variant) and
stops only when `streak` calls in a row finish inside the restore budget.
`kind` is wall time. `boot=` is printed and is not the pass/fail.

```bash
# Default: 3 containers, 6 rounds, streak 3, 300s scale-to-zero between rounds.
modal run modal/s2_clone_warm.py::cover --containers 3 --rounds 6 --streak 3 --scaledown 300
```

| `kind` | Wall time | What it means |
|---|---|---|
| `restore` | ≤ 150 s | This variant already has a snapshot. A book may wait this long. |
| `slow` | 150–300 s | Not a proved restore. Keep covering. |
| `compile` | ≥ 300 s | This RPC built a snapshot. A book must never be the caller. |

The worker kicks `::cover --containers 1 --rounds 1 --scaledown 0` when a book
placement misses the restore budget, so a compile the HTTP proxy would have
killed can finish. That kick needs `MODAL_TOKEN_ID` on the worker.
`MODAL_S2_WARM_HOOK=0` turns it off. The book does not wait for it.

Record for each container:

- [ ] `boot=restored` **or** `boot=unknown`, and which one Modal's log says —
      `unknown` is normal and not a failure; see step 3
- [ ] `build=` matches the id from step 3
- [ ] `container_id` values are distinct (four calls → four containers)
- [ ] `wall=` per call, which is the closest proxy for restore cost
- [ ] the age is reported as `snapshot_age`, never as a restore duration

`boot=unknown` does not mean "no snapshot". It means the container could not
prove a restore from inside, which is the common case: the proof requires the
restored host's monotonic clock to be younger than the builder's. Confirm with
Modal's log line and the wall clock instead:

| Evidence | Build | Restore |
|---|---|---|
| Modal log | `Snapshot created` | `Restoring Function from memory snapshot` |
| `wall=` for the first call | minutes | tens of seconds |
| Container tab icon | snapshot icon | restore icon |

Check the Modal dashboard → app → **Containers** tab: restored containers are
marked with the restore icon, snapshotted ones with the snapshot icon.

---

## 5. Short synthesis correctness over HTTP

`--synth` in step 3 proves the model works over `.remote()`. That is **not** the
worker's path. Staging found `.remote()` succeeding while
`POST /synthesize_batch` returned 500 `CUBLAS_STATUS_ALLOC_FAILED`, because the
sync FastAPI endpoint ran the engine on a fresh thread with no cuBLAS handle for
the restored context. `--synth` would have passed straight through it.

**Does a freshly compiled container have the same bug?** Yes, in principle, and
the fix covers both. CUDA state belongs to the thread that created it, and the
context was always created off the request thread — the snapshot merely makes
the mismatch reliably fatal instead of intermittently survivable. So step 0a
must be run **twice**: once on a brand-new deploy before any snapshot exists
(whatever `boot` says), and again after scale-to-zero. Both must
return 200. If only the compile path 500s, the handler is still running inline;
if only the restore path 500s, the snapshot is pinning a thread other than the
one `GpuExecutor` starts.

So the HTTP checks come from the smoke script, which takes **one absolute URL
per endpoint** (Modal serves each `@modal.fastapi_endpoint` at the root of its
own hostname; there is no base to append paths to):

```bash
MODAL_S2_TTS_URL=https://<synthesize_batch-host> \
MODAL_S2_SYNTHESIZE_URL=https://<synthesize-host> \
MODAL_S2_READY_URL=https://<ready-host> \
MODAL_S2_TOKEN=<token> \
node scripts/s2/staging-smoke.mjs --lanes 4 --sections-per-lane 2
```

The script refuses a URL that carries a path, and refuses a ready URL equal to
the batch host, because both are the mistake that produced the 404s.

Hard checks it makes:

| Check | Pass condition |
|---|---|
| `/ready` | HTTP 200, `ready:true`, a `build` |
| HTTP `/synthesize` | decodable MP3, `truncated_units == 0`, no 500 |
| batch rows | one row per section, all with decodable MP3 in `audio_b64` |
| truncation | `truncated_units == 0` on every row |
| containers | ≥ `--lanes` distinct `container_id`s |
| build | one build id across all lanes |
| boot | every answer reports a `boot` value; `restored` only when provable |
| throughput | prints measured audio-seconds per wall-second |
| consistency | a second identical call still returns rows |

The `/synthesize` check exists specifically to catch the thread-affinity bug: it
is a single HTTP call made *before* the batch fan-out, so a 500 there names the
cause instead of hiding behind a batch failure.

Record:

- [ ] distinct container count
- [ ] per-lane `audio_s` / `wall_s` and the realtime multiple
- [ ] `performance.prepare_s`, `generate_s`, `codec_s`, `encode_s`
- [ ] a `boot` value on both HTTP paths, cross-checked against Modal's log
- [ ] `snapshot_age_s`, labelled as an age and not a restore time

A WER check on a synthetic clip is not meaningful — the clip is a tone, not
speech. WER is measured on a real voice in step 7 only, on a **synthetic book**.

### 5a. The specific staging regression: HTTP after a restore

Do this **first**, on a scaled-to-zero app, because it is the one that blocked
the Contabo path.

```bash
# 1. Scale to zero. Wait past scaledown_window.
sleep 360

# 2. Time the FIRST cold HTTP call. This wall clock is the restore time.
export MODAL_S2_SYNTHESIZE_URL=https://<synthesize-host>
export MODAL_S2_TOKEN=<token>
python3 - > /tmp/s2-ref.json <<'PY'
import base64, json, sys
sys.path.insert(0, "modal")
from s2_contract import WARM_REFERENCE_TEXT, warm_reference_wav
print(json.dumps({
    "text": "The river had not moved for three days.",
    "reference_audio_base64": base64.b64encode(warm_reference_wav()).decode(),
    "reference_text": WARM_REFERENCE_TEXT,
    "sampling": "0.9,0.9",
    "job_id": "staging-cold-http",
    "seed_epoch": 0,
    "json": True,
}))
PY
time curl -sS -X POST "$MODAL_S2_SYNTHESIZE_URL" \
  -H "Content-Type: application/json" \
  -H "x-echomancer-token: $MODAL_S2_TOKEN" \
  --data @/tmp/s2-ref.json \
  -o /tmp/s2-cold.json -w 'http=%{http_code}\n'
python3 -c "
import json
d = json.load(open('/tmp/s2-cold.json'))
print({k: d.get(k) for k in ('duration_s','truncated_units','boot','snapshot_age_s','build','container_id')})
print('audio bytes:', len(d.get('audio_b64') or ''))
"
```

Pass conditions:

- [ ] `http=200`, not `500 CUBLAS_STATUS_ALLOC_FAILED`
- [ ] `duration_s > 0`, `truncated_units == 0`, `audio bytes > 0`
- [ ] this call answered without a 500; `boot` plus Modal's log say whether it
      restored
- [ ] the `time` output is the restore duration — target ~90 s

Then let the container go warm and repeat immediately: the second call should
be a few seconds and report the same `build` and `container_id`.

**If it 500s**, that is defect 1 still present. Check in this order:

```bash
# (a) did the handler run off the owner thread?
modal app logs echomancer-s2-clone-staging --since 10m | grep -E 'gpu_thread|CUBLAS'
# (b) was the boot selftest skipped or did it fail?
modal app logs echomancer-s2-clone-staging --since 10m | grep -E 'selftest|warm-up render'
```

If `selftest` never printed, the compile path never exercised the allocator and
step 3 above is the thing to re-run. If it printed on boot but the HTTP call
still fails, the handler is not submitting through `GpuExecutor` — which is what
`test_batch_handler_runs_every_gpu_call_on_the_owner_thread` guards.

**If a container never becomes ready at all**, check the boot log for a
`selftest` exception. The probe allocates the same tensors the endpoint does, so
a wrong shape there kills every start before any snapshot exists — that is what
happened on `ac93f4f`:

```
# RuntimeError: torch.cat(): expected a non-empty list of Tensors
modal app logs echomancer-s2-clone-staging --since 15m | grep -B2 -A2 'selftest'
```

The codec probe must hand `decode_codes` one `(num_codebooks, T)` unit —
`codec_probe_codes()` in `s2_batch.py`. A `(1, num_codebooks)` dummy passes the
look test and dies inside the codec; `modal/test_s2_codec_probe.py` asserts the
shape at the `decode_codes` boundary without a GPU.

---

## 6. Four simultaneous one-GPU containers

This is the scale check. Cost is four H100s for the duration.

```bash
MODAL_S2_TTS_URL=https://<synthesize_batch-host> \
MODAL_S2_SYNTHESIZE_URL=https://<synthesize-host> \
MODAL_S2_READY_URL=https://<ready-host> \
MODAL_S2_TOKEN=<token> \
node scripts/s2/staging-smoke.mjs --lanes 4 --sections-per-lane 4
```

Expected:

- 4 calls start at once, each on its own container (Modal starts one container
  per concurrent call)
- warm throughput is roughly flat versus one lane, because each container is
  independent — this is the whole reason for replicas instead of multi-GPU
- `perf.generate_s` per lane is comparable, not one lane carrying everything
- every answer reports a `boot` value; cross-check Modal's log for restores

Estimate the cost before running:

```
GPU cost ≈ containers × (restore_s + call_wall_s + scaledown_window_s) × $0.0011/s
```

At `S2C_SCALEDOWN=300`, four lanes idle for one scaledown window is
`4 × 300 × 0.0011 ≈ $1.32` on top of the work. Lower `S2C_SCALEDOWN` for the
staging run if you do not need the observation window.

Then prove **scale to zero**. The probe is its own endpoint, so pass that
host — never the batch host with `/ready` appended:

```bash
sleep 360   # past scaledown_window
MODAL_S2_READY_URL=https://<ready-host> MODAL_S2_TOKEN=… node -e '
const r = await fetch(process.env.MODAL_S2_READY_URL, {
  headers: { "x-echomancer-token": process.env.MODAL_S2_TOKEN },
});
console.log(r.status, await r.text());
'
```

- [ ] `/ready` now reports `ready:false`, `warm_containers:0`
- [ ] the Modal dashboard shows no running containers for the app
- [ ] the next real call restores: Modal logs the restore line, and the wall
      clock of that first cold HTTP call is the restore time

### `warm_containers` can briefly exceed `max_containers` — known, and why

This is real and bounded, not a rounding error:

1. A container that is **starting** has not been counted yet, and one that is
   **stopping** may still be counted for a moment. During a replace there are
   genuinely two live containers, so `/ready` reporting 2 with
   `max_containers=1` is telling the truth.
2. On an **ungraceful kill** (OOM, preemption without a teardown) the entry has
   no chance to be removed and lingers until `S2C_HEARTBEAT_TTL` (90 s) expires.
   No in-container code can prevent that; only the TTL bounds it.

What is *not* acceptable, and is now fixed:

| Cause | Before | Now |
|---|---|---|
| A container only heartbeat when it served a call, so the TTL had to be long (420 s) or a warm-but-idle container would vanish | scaled-down containers counted for **7 minutes** | live containers refresh on a timer, so the TTL is **90 s** |
| No teardown hook | a scaled-down container waited out the TTL | `@modal.exit()` removes the entry immediately |

`/ready` is advisory: the app treats a cold answer as "park the book and retry",
never as a hard failure, so an over-count costs at most one wasted probe. Verify
the *steady state* rather than a single sample:

```bash
# Poll three times, 20s apart. The cap should hold in the last two.
for i in 1 2 3; do
  MODAL_S2_READY_URL=https://<ready-host> MODAL_S2_TOKEN=… node -e '
  const r = await fetch(process.env.MODAL_S2_READY_URL, {
    headers: {"x-echomancer-token": process.env.MODAL_S2_TOKEN}});
  const b = await r.json().catch(() => ({}));
  console.log(new Date().toISOString(), r.status, "warm=" + b.warm_containers,
              "max=" + b.max_containers);'
  sleep 20
done
```

Record `warm_containers`, `max_containers` and `heartbeat_ttl_s` from the same
response, and note whether any overshoot was during a replace (expected) or
persisted past ~90 s idle (would be a bug — report it with the log lines).

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
# One absolute URL per endpoint; nothing is appended to them.
MODAL_S2_TTS_URL=https://<staging-synthesize-batch-host>
MODAL_S2_SYNTHESIZE_URL=https://<staging-synthesize-host>
MODAL_S2_READY_URL=https://<staging-ready-host>
MODAL_S2_TOKEN=<token>
MODAL_S2_SECTION_CONCURRENCY=4     # caps concurrent CALLS; a 5-section book is one call
MODAL_S2_BATCH_SIZE=24             # rows per call: this is the throughput knob
MODAL_S2_COLD_WAIT_MS=150000       # restore-sized; hard ceiling 180s, never a compile
MODAL_S2_FIRST_LIGHT_WAIT_MS=75000 # section 0 only; gives up before a compile
MODAL_S2_FIRST_LIGHT=1             # section 0 alone first, then one batched call
MODAL_S2_DEFER_MS=1500000          # 25 min of parking before any fallback
```

3. Upload the synthetic book as a throwaway anonymous session and make one
   whole-book job with a **test clone** (train a clone from
   `/tmp/s2-staging-ref.wav` in that session).

4. Watch, and record:

- [ ] the job leaves `queued` and the **browser is not waiting** on any request
- [ ] `pm2 logs echomancer-takehome` shows `clone provider pinned to modal`
- [ ] a `[modal-clone] pre-warm started` line appears before the book is packed
- [ ] `S2 lanes=4 batch=24 staged=N/M containers=… builds=… boot=… gen=… first=0:staged@Ns`
- [ ] the **first** batch call carried section 0 alone (`[S2 lanes] first light
      section 0 staged in Ns`), and it arrived before any other lane opened
- [ ] every remaining section rode **one** page — not one page per section
- [ ] from a scaled-to-zero pool, section 0 is playable in roughly one restore
      plus one section (~57s restore + ~14s synthesis)
- [ ] the whole book is `ready`, and `provider_pin` on the row is still `modal`
- [ ] no section fell back (the job has no `warning`, and `GET /api/jobs/<id>`
      never showed a narrator switch)
- [ ] total Modal spend is in the expected band for the synthetic book's size

5. Deliberately scale to zero and re-run a **second** synthetic book: it should
   park briefly (`GPU pool cold … parking`) and then finish on Modal, still with
   a single narrator.

### Cold-start behaviour to confirm

While the pool is cold, a tick must:

- **render section 0 alone first** and publish it before opening the other
  lanes, so time-to-first-audio is one restore plus one section rather than a
  full fan-out of cold wall clock. Section 0 batched beside a neighbour is
  exactly as late as that neighbour, because a container answers the whole batch
  together.
- skip the remaining lanes when section 0 could not be placed, instead of
  opening three more calls on a pool that just missed one
- drop a placement that is still cold at `MODAL_S2_COLD_WAIT_MS` (never sit
  for an 8–16 min compile)
- retry that placement once on another container when a lane is free
- release the lease and set the row back to `queued` when nothing was staged
- set `clone_wait_started_at`
- **not** consume one of the section's two attempts
- **not** switch engine until `MODAL_S2_DEFER_MS` has passed
- kick `modal run …::cover` (RPC) when a token is configured, and not wait for it

Once the budget is gone it pins the book to `drama3` for the rest of the book and
writes `CLONE_COLD_TIMEOUT_WARNING` onto the job, so the person sees why the
voice changed.

---

## 8. Promote to four lanes in production

Only with every box above ticked and evidence pasted into the PR.

**The primary path raises the cap at runtime, after the deploy.** Staging proved
this on `2c43f284208e` (`e4e2d54`): it was deployed with `S2C_MAX_CONTAINERS=1`,
and an `update_autoscaler(max_containers=4, …)` call raised the live cap to 4
**without a redeploy**, with the GPU memory snapshots surviving it. Four
containers then ran. Joel chose this path for production, so the first promote
deploy does **not** bake `S2C_MAX_CONTAINERS=4` into the environment.

Order matters: deploy → warm the new production snapshots → raise the cap. Each
step is below.

### 8a. Deploy production at one lane

Production is a **different Modal app** from staging (`echomancer-s2-clone` vs
`echomancer-s2-clone-staging`), and snapshots do not transfer between apps. A
promote is therefore a fresh deploy plus a fresh snapshot build, not a promotion
of staging's snapshots.

```bash
cd <repo>
unset S2C_APP_NAME               # production app
unset S2C_MAX_CONTAINERS         # deploy-time env stays 1, deliberately
modal deploy modal/s2_clone_service.py
```

`S2C_LANES` can be left alone: it defaults to 4 and is only reported in
`/ready` / `status()`. It does not cap containers — the live autoscaler does.

Record the printed `synthesize` / `synthesize_batch` / `ready` hostnames as in
step 1. The `build=` id comes from the warm run in 8b.

### 8b. Warm and verify the new production snapshots

Do this **before** raising the cap, while the app is still one lane: the first
call on a fresh deploy is the one that compiles (`~15 min`), and a fanout over
unbuilt snapshots is how four simultaneous compiles exhausted the budget on
25 Oct.

```bash
# Still production (S2C_APP_NAME unset).
modal run modal/s2_clone_warm.py --verify --containers 3
```

- [ ] the warm run printed a `build=` id (12 hex chars) — record it
- [ ] each verified container reported `boot=restored` or `boot=unknown` with
      Modal's `Restoring Function from memory snapshot` line
- [ ] `scripts/s2/staging-smoke.mjs` passes against the production `ready` and
      `synthesize_batch` hosts (same checks as step 5)

### 8c. Raise the live cap to four containers

Run this from a checkout with the Modal client configured for the Echomancer
workspace. It talks to the deployed app; it does not deploy or rebuild anything.

```bash
cd <repo> && python3 - <<'PY'
import modal

worker = modal.Cls.from_name("echomancer-s2-clone", "S2CloneWorker")()
settings = worker.update_autoscaler(
    min_containers=0,        # scale to zero when idle
    max_containers=4,        # four independent one-GPU containers
    scaledown_window=180,    # 180 s idle before a container is released
)
print("live autoscaler now:", settings)
PY
```

`update_autoscaler` is a runtime call on a deployed `Cls` instance: no redeploy,
and the snapshots already built stay valid. It returns the autoscaler settings
**as they now stand on the server** — that printout is the only reliable
confirmation, because `/ready` and `status()` keep reporting the deploy-time
value (see below). Once it returns, up to four concurrent batch calls start
four containers.

Then on the worker:

```bash
MODAL_S2_SECTION_CONCURRENCY=4
MODAL_S2_BATCH_SIZE=24
```

Confirm with a fanout against production — the same command as step 4/6, with
no `S2C_APP_NAME`:

```bash
modal run modal/s2_clone_warm.py::fanout --containers 4 --scaledown 180
```

Pass condition: four distinct `container_id`s across four calls. Then
`node scripts/s2/staging-smoke.mjs --lanes 4 --sections-per-lane 2` should
report ≥ 4 distinct containers.

### 8d. Cold first audio, from a scaled-to-zero pool

Section 0 is the only section the player can start with, so it is rendered
alone on one lane and published before the rest of the book fans out
(`MODAL_S2_FIRST_LIGHT`, default on). Everything after it rides **one** call,
because a container decodes every row of a call in one batch.

| | Budget |
|--|--|
| one snapshot restore | ~57s measured (`db10a6d6` direct smoke, 2026-11-06); ~90s class |
| section 0 synthesis (41s of audio, 1-row call at 2.9x) | ~14s |
| **cold → first playable audio** | **~70s** |
| the rest of a 5-section book (one 5-row call) | ~24s GPU |
| cold → `ready` | ~90–100s |

**~57s of that ~70s is the Modal restore.** Nothing in the book path can remove
it; only `min_containers=1` can, at ~$3.95/hr. Do not chase the ~70s figure
with tuning — check the two phases separately.

Before first light and the batching fix the same book spent **~4m38s** getting
to ready and **~141s** to first audio. The cause was not the restore: five
sections were planned as four **one-row** calls which all landed on one
container, so 246s of audio took 84s of GPU wall at **2.93x** — the documented
one-row rate, when a full batch reaches 35–65x.

Confirm on the worker log after a scale-to-zero:

```bash
pm2 logs echomancer-takehome --lines 200 | grep -E 'first light|S2 lanes=|pre-warm'
```

- `[modal-clone] pre-warm started` appears near the top of the tick, before
  `listen-prep` / `pack`, so the restore overlapped them
- `[S2 lanes] first light section 0 staged in Ns` appears **before** any
  `page of N rendered` line for another lane
- `first=0:staged@Ns` on the `S2 lanes=` line is the section-0 wall clock
- `staged=N/M` should be one page carrying every remaining section
  (`page of 4 rendered 4/4`), **not** four pages of one
- `boot=restored` (or `unknown`) says whether that time was a restore or a
  compile. A long first light that reports `unknown` and then succeeds is a
  warm compile; the off-path `::cover` is what prevents it.

If a book must reach `ready` as fast as possible and first audio does not
matter (a batch backfill, not a person waiting), `MODAL_S2_FIRST_LIGHT=0`
restores the old all-lanes-at-once wave.

### Health labels stay wrong until an env redeploy

`/ready` and `status()` both compute `max_containers` from `_LIMITS`, which is
read from the `S2C_*` environment at **deploy** time. A runtime override does
not change that environment, so after 8c:

- `/ready` still answers `max_containers: 1`
- `status()` on a container still reports `max_containers: 1`
- **four containers still run.** Trust the fanout's distinct-container count
  and the Modal dashboard's Containers tab, not the label.

This is expected, not a failed override. Do not "fix" it by calling
`update_autoscaler` again.

### Re-apply after every deploy

A plain `modal deploy` resets the live autoscaler to the values baked into the
deployment environment. While production's env stays at 1, that means the cap
silently drops back to **one container** on every deploy. After each production
deploy, in this order:

1. `modal run modal/s2_clone_warm.py --verify --containers 3` (the deploy
   invalidated the snapshots — 8b)
2. re-run the `update_autoscaler(max_containers=4, …)` call from 8c
3. optionally re-check the fanout

Treat step 2 as part of the deploy, not as an optional follow-up. A deploy that
skips it leaves production at one lane and nothing in the health output says so.

### Rolling the lane count back

The lane count rolls back the same way it was raised — no redeploy, no snapshot
invalidation, no dropped book:

```bash
python3 - <<'PY'
import modal
modal.Cls.from_name("echomancer-s2-clone", "S2CloneWorker")().update_autoscaler(
    max_containers=1,
)
PY
```

Existing containers finish the calls in flight and drain; new calls queue behind
the single cap. Raising it again is the same call with `max_containers=4`.

### Alternate: bake `S2C_MAX_CONTAINERS=4` into the deploy

Only if you want the health labels to be correct, or want the cap to survive a
deploy without a manual step. Slower and more expensive than 8a–8c, and 8c is
not needed on this path because the cap is already in the deployment env:

```bash
unset S2C_APP_NAME               # production app
export S2C_MAX_CONTAINERS=4
export S2C_LANES=4
modal deploy modal/s2_clone_service.py
modal run modal/s2_clone_warm.py --verify --containers 3
```

- `/ready` and `status()` now report `max_containers: 4`, because the value is
  in the deployed environment.
- **The deploy rebuilds the snapshots**, so the warm/verify run is mandatory
  again before any book is dispatched — a fanout over unbuilt snapshots starts
  four compiles at once.
- A later deploy with `S2C_MAX_CONTAINERS` unset drops the cap back to 1, and
  that is again invisible in health output. Pick one env setting and keep it
  consistent across deploys.

### Rollback, in order of blast radius

| Symptom | Action |
|---|---|
| Clone audio is wrong / silent | `CLONE_TTS_PROVIDER=openrouter` on the worker → Drama 3 only. No deploy needed. |
| Clone path errors | remove `MODAL_S2_TTS_URL` → clones use Drama 3 automatically. |
| Cost or container runaway | live: `update_autoscaler(max_containers=1)` on `echomancer-s2-clone.S2CloneWorker` (see "Rolling the lane count back") — no redeploy, snapshots survive. The dashboard's autoscaler panel does the same thing. |
| Books stuck parked | `MODAL_S2_DEFER_MS=0` → old fail-fast behaviour (switches to Drama 3 on the first cold answer). |
| Bad deploy | redeploy the previous commit; **the snapshot is rebuilt**, so re-run steps 3–4, then re-apply the runtime override (or redeploy with the env you want). |

A book that is already `ready` is never re-synthesized by any of these.

---

## 9. Evidence checklist for the PR

Copy this into the PR description, filled in.

```
Staging app:        echomancer-s2-clone-staging
Build id:           __________
Snapshot build:     built in ____ s on ____-__-__ (ISO date)
Boots observed:     __ restored (proved), __ unknown — Modal log: __ restores
First cold HTTP:    ____ s wall for the first POST after scale-to-zero
Four-lane fanout:   __ distinct containers, wall ____ s
Throughput:         ____ s audio / ____ s wall = ____ x realtime (4 lanes)
Per-lane generate:  lane0 __ s, lane1 __ s, lane2 __ s, lane3 __ s
HTTP paths:         /synthesize boot=____ , /synthesize_batch boot=____
Scale to zero:      /ready ready:false after ____ s idle; dashboard containers = 0
E2E synthetic book: job ______ → ready; provider_pin=modal throughout; warning=null
Cold-pool parking:  observed __ times; sections retried __ ; attempts burned 0
Cost:               $____ for the synthetic book (____ chars, ____ h audio)
```

Note what is deliberately absent: a container cannot report its own restore
duration, because it did not exist for most of the restore. `boot` says *whether*
it restored; the wall clock of the first cold call says *how long* that took.

Production promote (step 8) is recorded separately:

```
Production app:     echomancer-s2-clone
Build id:           __________  (same build validated on staging)
Deploy env:         S2C_MAX_CONTAINERS unset (1)
Prod snapshots:     __ containers warmed; boots __ restored / __ unknown
Runtime override:   update_autoscaler(max_containers=4, scaledown_window=180, min_containers=0)
Fanout after 8c:    __ distinct containers across __ calls
Health labels:      /ready max_containers still ____ (expected: 1 until an env redeploy)
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
| **CUDA off the owner thread** | a restored context has no cuBLAS handle for a fresh FastAPI worker thread, so the first `wqkv` dies with `CUBLAS_STATUS_ALLOC_FAILED` while `.remote()` still works | all GPU work goes through `GpuExecutor`; `engine.selftest()` at boot |
| **`restored_s` from the snapshot mark** | `compiled_at` is frozen in the snapshot, so restores looked huge and compiles small — exactly inverted | no in-process restore number at all: `boot` from the host monotonic clock, cold-call wall clock from outside |
| **Appending a route to a Modal URL** | each `@modal.fastapi_endpoint` is its own hostname; `${base}/ready` 404s | one absolute URL per endpoint, validated as a bare origin |
| **Wrong codec probe shape** | `decode_codes` wants a `(num_codebooks, T)` unit; a `(1, num_codebooks)` dummy looks fine and dies in `torch.cat` on every start | `codec_probe_codes()`; `modal/test_s2_codec_probe.py` asserts it without a GPU |
| **`TypeError: ... metadata_errors` on every lane** | the reference decoder went through PyAV: `torchaudio.load` (and `faster-whisper`'s file decoder) reach `av.open`, and the PyAV under fish-speech's lockfile predates the `metadata_errors` kwarg current `faster-whisper` passes. A WAV probe still passes, so the pool looks healthy — only a non-WAV reference fails (`job 5f09ee0e`, 2026-11-06) | decode through ffmpeg (`s2_contract.decode_reference_samples` / `reference_float_samples`); WAV stays stdlib. `modal/test_s2_reference_decode.py` decodes real MP3/M4A/OGG/FLAC/WebM/WAV clips and fails if `torchaudio` or `av.open` reappears on that path |
| **`Section 0: Modal clone already retried`** | a bare HTTP 500 was retried like a transient blip, spending the section's attempt ledger, so the retry policy became the error message | a 5xx is `ModalCloneProviderError`, gets one extra take, then surfaces the provider's own text; the tick parks on the defer clock and takes the documented fallback instead of failing the book |
| **Inferring a restore from a pid** | Modal runs the app as **pid 2** both before and after a restore, so pid equality reported every real restore as `compiled` | `boot` is `restored` only on a backwards host monotonic clock, else `unknown`; Modal's log line is authoritative |
| **`warm_containers` > `max_containers`** | an entry outlived its container; the old 420 s TTL was needed because heartbeats only happened on a call | timer refresh + `@modal.exit()` removal, TTL 90 s; a brief overshoot during a replace is genuine and documented |
| **Health label disagrees with the live cap** | `max_containers` in `/ready` and `status()` is read from the deploy-time `S2C_*` env, so a runtime `update_autoscaler` leaves it at the old value | expected; confirm lanes from the fanout's distinct-container count and the dashboard. A plain `modal deploy` resets the live cap too, so re-apply the override after every deploy |
| **Promoting by copying staging's snapshots** | staging and production are separate Modal apps | deploy the validated build to `echomancer-s2-clone` and warm its own snapshots (8a–8b) before raising the cap |
