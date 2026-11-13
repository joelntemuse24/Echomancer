# S2-Pro Modal: staging runbook

The self-hosted clone path (`modal/s2_clone_service.py`) was proven on staging
on build `2c43f284208e` (commit `e4e2d54`): **one-GPU restore** and **4-GPU
fanout** both passed, which is the snapshot/restore and lane evidence from steps
3–6 of that older image. Staging did **not** run an end-to-end book through the
worker. That staging build is not the current production recipe.

As of 2026-11-07 the fingerprint of the current source defaults
(`snapshot_fingerprint`: `S2C_VERSION` 9, unit ceiling 560, merge 260, history
anchor first, pauses 0.22/0.4/0.96) is `aa02126d8267`. Operators reported the
live app still on that id, unchanged since #246, with a runtime autoscaler of
`min_containers=0`, `max_containers=4`, `scaledown_window=180`. This file does
not prove the live `/ready` body. Cover calls that answer from an already-warm
container id do not prove that every GPU type has a snapshot of this recipe.
There are no always-on GPUs.

The live cap matches `MODAL_S2_MAX_GPUS` (default **20**): one container per
active clone book, and one call in flight per book. The code default is
`max_containers=1`, so a plain `modal deploy` does not open that fleet by
itself. Step 8c sets the live cap after every production deploy and checks
the printed settings. `min_containers` stays 0. The deployed
`echomancer-s2-clone` image already has `@modal.concurrent(max_inputs=1)`
on `S2CloneWorker`, so a second book's POST is placed on another container
(that container restores its own snapshot) rather than queued onto the busy
one. A 429 `lane_busy` answer is a backstop for an older image and is busy,
not cold. Do not redeploy to change that: a redeploy wipes GPU snapshots.

Target shape. The table is the intended shape, not a record that every box
was ticked for the current image:

| Property | Target |
|---|---|
| App | one frozen deployment (`echomancer-s2-clone`) |
| Containers | one GPU per active clone book, up to `MODAL_S2_MAX_GPUS` (default 20) |
| `min_containers` | `0` (scale to zero when idle) |
| `max_containers` | live override N = `MODAL_S2_MAX_GPUS` after each deploy (the deploy-time env stays 1) |
| Cold start | snapshot restore. ~90 s is a planning figure, not a measured duration of every cold start. A measured restore cited for the 2026-11-06 books was ~57 s. |
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

**`MODAL_S2_READY_URL` is not optional on Vercel.** It is what lets a saved
clone's preview tell "a container is warm" from "nothing is running" without
opening a 150 s restore wait inside a 60 s function. On 2026-11-06 production had
`MODAL_S2_TTS_URL` and `MODAL_S2_TOKEN` but not the ready URL, so
`synthesizeModalClonePreview` treated the pool as unprovably cold. Operators
reported on 2026-11-07 that Vercel production has `MODAL_S2_READY_URL` and
`MODAL_S2_SYNTHESIZE_URL` set. This repo does not store those hostnames, and
this audit did not read the Vercel dashboard. The ready URL must still be set
on Production and Preview or the preview path reports `503 PREVIEW_ENGINE_COLD`
and starts a restore instead of blocking. Read the hostname from
`modal app list` / the deploy output and set it in the dashboard; nothing in
this repo can, and no config is changed by code.

`MODAL_S2_SYNTHESIZE_URL` stays optional: with no single-section host the
preview renders through the batch contract as a one-row payload, which is correct
on every deploy. Pointing `MODAL_S2_READY_URL` at the synthesize host is rejected
loudly, because it is a guaranteed 404.

**Production rule:** a bare `modal deploy` now targets
`echomancer-s2-clone-staging`, because a deploy *invalidates every GPU snapshot
for its app* and a branch under review must not be able to evict production's.

**`S2C_ALLOW_PRODUCTION=1` is required, and it is required even when
`S2C_APP_NAME=echomancer-s2-clone` is spelled out.** Typing a name is not a
decision about snapshots, and deploy commands get copy-pasted out of docs and PR
descriptions. Without the opt-in, either form is redirected to staging.

One resolver decides this for **all three** entry points — the service, the warm
script, and `scripts/s2/check-input-queue.py`
(`s2_contract.resolve_app_name`) — so a warm cannot land on a different app from
the one just deployed. The heartbeat registry follows the same name
(`s2_contract.heartbeat_dict_name`), so staging never reads production's
containers as warm.

Never export a staging `S2C_APP_NAME` when deploying production, and
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
# The warm script refuses to start if the input queue still has PENDING calls.
python3 scripts/s2/check-input-queue.py
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


### Input queue, the compile brake, and safe draining

Warm (`::warm`), cover (`::cover`), fanout (`::fanout`), and
`scripts/s2/staging-smoke.mjs` all check the function's recent inputs before
they start, and **refuse** if any FunctionCall is still `PENDING` or otherwise
unfinished:

```bash
python3 scripts/s2/check-input-queue.py
# or against staging:
S2C_APP_NAME=echomancer-s2-clone-staging python3 scripts/s2/check-input-queue.py
```

Do **not** try to clear that queue with `FunctionCall.cancel()` or
`modal container stop` while a container is in `@modal.enter` or compiling a
GPU snapshot.

- `FunctionCall.cancel()` (including `modal`-SDK cancel after a first-light
  abort) is **not** a reliable drain. `FunctionCall.get()` may raise NotFound
  while `modal function calls` still lists the input as PENDING. Those
  leftovers are served after the next enter finishes, which interrupts
  snapshot publish: the container can finish selftest and still never log
  `Snapshot created`.
- `modal container stop` (even with `-y`) does not drop the input. Modal
  reschedules the still-pending status onto a new container, which is how a
  stopped compile turns into a compile loop.
- A disconnected warm client also does **not** always cancel the input. If a
  compile is already running, leave it attached, or at most walk away; do not
  cancel the FunctionCall and do not stop the container. Let enter finish and
  publish the snapshot.

To stop **new** placements without touching an in-flight compile, apply a
brake, then restore the production cap after the snapshot is published:

```bash
# brake: max_containers=0, min stays 0. This is not a drain.
python3 scripts/s2/set-live-autoscaler.py --brake --scaledown-window 45

# after 'Snapshot created' (or a proved publish) and the container has scaled
# down, restore production:
python3 scripts/s2/set-live-autoscaler.py --max-containers 1 --scaledown-window 45
```

**Safe drain** of leftover PENDING inputs: wait until a container has already
finished enter (selftest / `[S2C]` has landed, snapshot work is done), let
those leftovers be dispatched onto that already-ready container, and let each
call reach a **terminal** state (`success`, `failure`, or `terminated`). Confirm
with `modal function calls 'echomancer-s2-clone/S2CloneWorker.*' --all-variants --tail 200 --json`
that nothing is still `pending` before starting the next warm or probe.

The take-home worker cancels **its own** Modal FunctionCall when a first-light
HTTP wait aborts, but only if that call is still an *unstarted* PENDING input.
It never cancels a call that has already started enter or compile.

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
MODAL_S2_SECTION_CONCURRENCY=4     # slot cap; one book still sends one call at a time
MODAL_S2_BATCH_SIZE=24             # largest warm call, only once the buffer covers it
MODAL_S2_COLD_WAIT_MS=150000       # restore-sized; hard ceiling 180s, never a compile
MODAL_S2_FIRST_LIGHT_WAIT_MS=75000 # section 0 only; gives up before a compile
MODAL_S2_FIRST_LIGHT=1             # section 0 alone first, then the playback ramp
MODAL_S2_DEFER_MS=1500000          # 25 min of parking before any fallback
```

3. Upload the synthetic book as a throwaway anonymous session and make one
   whole-book job with a **test clone** (train a clone from
   `/tmp/s2-staging-ref.wav` in that session).

4. Watch, and record:

- [ ] the job leaves `queued` and the **browser is not waiting** on any request
- [ ] `pm2 logs echomancer-takehome` shows `clone provider pinned to modal`
- [ ] a `[modal-clone] pre-warm started` line appears before the book is packed
- [ ] `S2 lanes=4 batch=24 staged=N/M cacheSkip=K containers=… builds=… boot=… gen=… first=0:staged@Ns`
      (`cacheSkip` is indexes already in the section cache and not sent again;
      `S2 lane staged` is a GPU row, not a cache hit)
- [ ] the **first** batch call carried section 0 alone (`[S2 lanes] first light
      section 0 staged in Ns`), and it arrived before any other lane opened
- [ ] the calls after section 0 grow (`warm:1`, then a larger prefix). A
      `warm:24` on the call immediately after section 0 means the ramp is
      not running. `warm:24` is the steady state only once the buffer is deep
- [ ] from a scaled-to-zero pool, an anonymous book (this checklist) is playable
      in roughly one restore plus one section (~68s: ~57s restore + ~14s
      synthesis + loudnorm). A signed-in `user_*` who already has a trained
      clone, and who spends about a minute on the file or the voice list
      first, should land in the warm window instead (~16–20s). A fast click
      stays on the cold figure: a restore still in progress does not take the
      HTTP call
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

Once the budget is gone, and `FISH_API_KEY` is set, the book is pinned to
direct **Fish** for the rest of the book — the same reference, not a different
narrator — and `CLONE_COLD_TIMEOUT_WARNING` is written so the person sees why
the engine changed. A hard provider fault uses `CLONE_PROVIDER_FAULT_WARNING`
instead. Drama 3 is not called. With no Fish key the book parks again rather
than substituting a voice.

---

## 8. Set the live cap to one GPU per book

**Set the live cap to `MODAL_S2_MAX_GPUS` (default 20).** Each active clone
book sends one `synthesize_batch` at a time on its own H100 (see
`docs/s2-lane-budget.md`). The worker will not start a 21st GPU; the
autoscaler has to allow the ones it does start. `min_containers` stays 0.
`scaledown_window` is 15s (`scripts/s2/set-live-autoscaler.py`). The worker
treats the pool as warm for 10s after the last answer
(`MODAL_S2_WARM_HOLD_MS`), which is under that window. Restart the worker
before lowering the live window. The script does not deploy. A 10s hold is
safe under a window that is still 45s; the live window stays at its
previous value until this script is run.

**Do not redeploy for concurrency.** The live `echomancer-s2-clone` image
already has `@modal.concurrent(max_inputs=1)` on `S2CloneWorker`. A second
book's POST is placed on another container. It is not queued onto the busy
one, and it is not answered 429. A 429 `lane_busy` body is only the
backstop if an older image is still serving, and the worker treats it as
busy, not cold. A `modal deploy` wipes the GPU memory snapshots. This
runbook does not deploy.

8a deploys with the baked cap at 1. 8b warms snapshots while that cap is
still 1. 8c then raises the live cap. The `max_containers=4` command further
down is the old four-lane promote. Do not run it.

Only with every box above ticked and evidence pasted into the PR.

**The primary path raises the cap at runtime, after the deploy.** Staging
proved a runtime override on `2c43f284208e` (`e4e2d54`): the app was deployed
with `S2C_MAX_CONTAINERS=1`, and `update_autoscaler` changed the live cap
without another deploy, with the GPU memory snapshots surviving it. The
deploy still does **not** bake `S2C_MAX_CONTAINERS` above 1. The number 8c
applies is `MODAL_S2_MAX_GPUS`.

Order matters: deploy → warm the new production snapshots → raise the cap. Each
step is below.

### 8a. Deploy production at one lane

Production is a **different Modal app** from staging (`echomancer-s2-clone` vs
`echomancer-s2-clone-staging`), and snapshots do not transfer between apps. A
promote is therefore a fresh deploy plus a fresh snapshot build, not a promotion
of staging's snapshots.

```bash
cd <repo>
unset S2C_APP_NAME               # production app, named explicitly below
export S2C_ALLOW_PRODUCTION=1    # required: a bare deploy goes to staging
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

### 8c. Set the live cap to `MODAL_S2_MAX_GPUS`

Do this after every production deploy, including a deploy that left
`S2C_MAX_CONTAINERS` unset, and only after the image with
`@modal.concurrent(max_inputs=1)` is the one that was just deployed. A plain
`modal deploy` resets the live autoscaler to the baked env (1). `/ready`
still reports that deploy-time value either way. The printout from
`update_autoscaler` is the live cap.

Run this from a checkout with the Modal client configured for the Echomancer
workspace. It talks to the deployed app; it does not deploy or rebuild
anything. **Do not run it from CI or from this change.** N is the worker's
`MODAL_S2_MAX_GPUS` (default 20). `min_containers` stays 0. Pass the same N
the worker is configured with; a higher autoscaler cap does not raise the
worker's lease ceiling, and a lower one 429s books the worker already leased.

```bash
cd <repo> && python3 - <<'PY'
import modal

worker = modal.Cls.from_name("echomancer-s2-clone", "S2CloneWorker")()
settings = worker.update_autoscaler(
    min_containers=0,        # scale to zero when idle; do not leave GPUs up
    max_containers=20,       # MODAL_S2_MAX_GPUS; one H100 per active clone book
    scaledown_window=15,     # 15 s idle before a container is released
)
print("live autoscaler now:", settings)
assert settings.max_containers == 20, settings
assert settings.min_containers == 0, settings
assert settings.scaledown_window == 15, settings
PY
```

The same call is `python3 scripts/s2/set-live-autoscaler.py --max-containers 20 --scaledown-window 15`.
Restart the take-home worker before this, so its 10s warm hold is already
under 15s. This does not deploy and does not wipe snapshots. Scaledown
applies once the container has no input. It does not cancel a call that is
still restoring or compiling.

Pass condition: the printed settings show `max_containers` 20 (or whatever
`MODAL_S2_MAX_GPUS` is on the worker), `scaledown_window` 15, and
`min_containers` 0. A book wave still posts one call. A second book posts
on a second container. After the last book, the container releases in about
15s. A gap longer than 15s mid-book costs one restore.

#### Historical — do not run

An older promote raised the live cap after the deploy. That command started
four H100s for a book that only ever has one call in flight. It is recorded
here so a search for it does not look like the current step. Do not run it.

```bash
# DO NOT RUN. Historical four-lane promote, superseded by 8c above.
# worker.update_autoscaler(min_containers=0, max_containers=4, scaledown_window=180)
```

### 8d. Cold first audio, from a scaled-to-zero pool

Section 0 is the only section the player can start with, so it is rendered
alone on one lane and published before the rest of the book starts
(`MODAL_S2_FIRST_LIGHT`, default on). Each later call is the largest prefix
that fits the warm wait, the response body, and the proxy ceiling. It is
not grown so a 1.5× listener stays ahead. A container still answers every
row of a call together, which is why the planner counts the whole call as
the wait. A wide page on the call after section 0 is the schedule. The
5-section row below is the old one-call measurement, kept as a GPU rate.

| | Budget |
|--|--|
| one snapshot restore | ~57s measured (`db10a6d6` direct smoke, 2026-11-06); ~90s class |
| section 0 synthesis (41s of audio, 1-row call at 2.9x) | ~14s |
| section loudnorm (measure, then apply) | ~2s |
| **cold → first playable audio** (restore starts at the synth call) | **~68s** |
| **warm → first playable audio** (restore finished before the synth call) | **~16–20s** |
| the rest of a 5-section book (old one-call shape, one 5-row call) | ~24s GPU |
| cold → `ready` | ~90–100s |
| warm → `ready` | ~40–50s |

**Throughput, in the right units.** Realtime is *audio seconds per wall second*.
At 900 characters per audio minute, a **one-row** call at 2.9x produces about
**50 chars/s** of generation, and a row renders its paragraph units **in
sequence**, so more text in one row means proportionally more time. The
2026-11-11 HTTPS smoke measured the listener-facing row at **~33 chars/s**
(1,300 characters in 39.85s) and a 24-row call at 528 chars/s end to end.
The in-book ramp plans from those numbers, 15% slower on wide calls. A
**full batch** is faster because rows run in parallel — not because a row
gets faster. A call's wall time is set by its longest row, so section size
is a hard bound, not a tuning preference. Clone section 0 is 1,000
characters. Later sections are 4,000. A piece whose rows add no generation
beyond that opening is one call. A longer second section waits so first
audio stays the opening.

That is what `job 7e4a8b48` (2026-11-06) broke. See `docs/s2-lane-budget.md`.

**Unit size and pause density.** The first post-#244 book (`job 1f0137a1`) had
7–13 gaps ≥ 0.35 s per minute against ~6.5 before. Two rounds of tuning blamed
the gap width; Joel's report was *"it stops and starts every time"*, and the real
cause was the **count** of splices. There is now one width authority,
`UNIT_MAX_CHARS = 560`, and **no packing target**: a paragraph under the ceiling
is a single generation, and a longer one is cut into the fewest, most even
sentence-aligned takes. On job-sized real prose the splices go 68/67 (#244) →
47/48 (#245) → **33** and forced mid-sentence breaks 30/13 → **8/3**. The pause
ladder (0.22 clause / 0.40 sentence / 0.96 paragraph) is unchanged, and a row's
last take gets no inserted pause at all.

The ceiling is a model limit, not a preference: `MAX_NEW_FRAMES` (1,024) at
~21.5 frames/s caps one take at ~47.6 s, and a take that hits it is `truncated`,
so the section is retried and then fails. `modal/test_s2_contract.py` reads that
constant out of source and fails if `UNIT_MAX_CHARS` stops fitting at 13 chars/s.

Verify a deploy with:

```bash
pm2 logs echomancer-takehome --lines 300 \
  | grep -E 'S2 lanes=|could not be narrated|section .* 422'
```

- no `422 … unit of N chars was not split` (the splitter is total)
- no `N sections could not be narrated` warning on a finished book
- `S2C_BUILD` reflects `S2C_VERSION=9`

`GET /ready` (and a container's `status()`) now return the whole `recipe` next
to the build id — `unit_max_chars`, `max_new_frames`, `merge_para_max_chars`,
`history`, `pause_s` — so a book's `x-s2-build` can be mapped back to the width
it was actually rendered with. `build` alone is an opaque hash; that mapping is
how "the fix is deployed" is told apart from "this book was made with the fix".
Each batch row also carries `unit_shape` (`count`, `mean_chars`, `max_chars`,
`pause_kinds`), so one book's real unit width is a number in the response rather
than an inference from listening.

## Book-path acceptance — required, and separate from the endpoint smoke

`job 75944dc9` (2026-11-06) passed every check above and still shipped a book
with **5 of 11** sections. The deploy reported the new build, the direct batch
smoke returned 4/4 MP3s with `truncated_units: 0`, `/ready` reported version 9,
and the worker was on the right SHA with the right env names. None of those
touches the path a book takes, so none could see:

- a generation-allowance refusal reported as *"Clone provider modal failed"*,
  with **zero** requests in Modal's access log for the whole failure window;
- five "ready" sections that were byte-identical to takes from builds
  `1e9a10bbf103` (S2C8) and `f55abd34001a` (S2C7), so no second of the book came
  from the new runtime;
- assembly publishing that state as a finished audiobook.

**Free check, run on every clone roll** (no Modal, no GPU, no network, no paid
API):

```bash
npx vitest run src/test/acceptance/book-path.acceptance.test.ts --reporter=verbose
```

It drives the real orchestration — engine selection, lane staging, content cache,
per-section retry, assembly, publish — and reports coverage rather than a status
code:

- **100% coverage** on a healthy book, ending `ready`;
- a book that renders only some sections ends **not `ready`**, with the shortfall
  in `error_message`;
- an account with **far more prior usage than the old 500,000-character daily
  allowance** still renders the whole book: requests are made, coverage is 100%,
  and no allowance wording appears in any log. There is no per-account or global
  character cap any more (removed 2026-11-07); `MODAL_S2_USER_DAILY_CHARS` and
  `MODAL_S2_GLOBAL_DAILY_CHARS` are inert even if an old `.env` still sets them.
  Usage is still recorded to `usage_logs` for cost reporting, non-blocking.

**Then one real bounded book render**, which the free check cannot replace
because it cannot tell you the narration sounds right:

1. Render one book of 10–15 sections on the target build at
   `UNIT_MAX_CHARS=560`, using a clone you are allowed to spend GPU on.
2. Assert `delivered == planned` from the job row, and `unit_shape.count` per
   section matches the splitter's plan. A book whose sections all report a mean
   under ~300 characters did **not** use the long-unit recipe.
3. Assert `truncated_units: 0` on every row. Non-zero means the ceiling is too
   wide for the frame cap — drop to 520 rather than touching the splitter.
4. Grep for `S2 lanes=… builds=<expected>` on the book, not just on the smoke.
   Absent means the book never reached the pool.
5. Listen to the first minute, one paragraph boundary, and one section join.
6. Confirm `warning` is empty and `status` is `ready` — not `failed` with a
   shortfall, which is now how an incomplete book reports itself.

**~57s of the cold figure is the Modal restore, and it is the floor when the
restore starts at the synth call.** A side `modal run …::cover` is not used
for that. With `max_inputs=1` the cover is a second container the book's
POST does not join, and that container then idles for `scaledown_window`.
Extract, the voice list, and the tick do not start one. The book's
`/synthesize_batch` is the container. The first call pays about 68s. Later
calls stay on it while the worker posts them back to back. A gap longer
than the 15s window costs one restore, then full batches resume. Stock-only
accounts never start a GPU. A placement that already missed its restore
budget still kicks `::cover` off the book path.

Section 0 is not held for transcript QA. That check spawns a fresh Whisper
process, and the model load sat between the GPU and `first_section_at`. Later
sections are still checked, and the section 0 file is not replaced afterwards.
The reference sample downloads beside packing, not after it. Section 0 stays
~800 characters: the container returns the whole batch at once, so a shorter
first section underruns playback while the rest of the book is still in that
one call. Switching the audio call itself from the HTTP gateway to RPC does
not skip the restore — the 57s smoke was already an HTTP call.

**Cost, so the floor can be beaten on purpose.** H100 is $0.001097/s
($3.95/hr) in `modal/s2_batch.py`.

| Option | What it buys | Cost |
|--|--|--|
| No side cover; the synthesize call restores the container | one H100 per book, no spare | the cold first call, about 68s of GPU |
| `scaledown_window=15` after the last book (runtime `update_autoscaler`, no redeploy) | the idle tail drops from ~180s (~$0.20) through the previous 45s (~$0.05) to ~15s (~$0.016) | a mid-book gap past 15s pays one more restore |
| Longer `scaledown_window` (same runtime call, no redeploy) | more room for a stall between batches | about $0.0011 per extra idle second, on the book that was last |
| `min_containers=1` | the restore is gone for every book, including a fast click | **$3.95/hr**, about $2,840/mo continuous, or ~$870/mo for a 10-hour weekday |

Before first light and the batching fix the same book spent **~4m38s** getting
to ready and **~141s** to first audio. The cause was not the restore: five
sections were planned as four **one-row** calls which all landed on one
container, so 246s of audio took 84s of GPU wall at **2.93x** — the documented
one-row rate, when a full batch reaches 35–65x.

Confirm on the worker log after a scale-to-zero:

```bash
pm2 logs echomancer-takehome --lines 200 | grep -E 'first light|S2 lanes=|pre-warm'
```

- `[modal-clone] pre-warm started` appears when extract is accepted or the
  voice list is built, for a `user_*` with a trained clone, and again near
  the top of the tick (before `listen-prep` / `pack`) when that earlier start
  is outside the 3-minute cooldown. `section 0 published before transcript QA`
  is the first-light line
- `[S2 lanes] first light section 0 staged in Ns` appears **before** any
  `page of N rendered` line for another lane
- `first=0:staged@Ns` on the `S2 lanes=` line is the section-0 wall clock
- the calls after section 0 follow the book's length. A short book is
  one warm call. A long book is a 1–2 minute page, then a 5–6 minute
  page, then even pages: `warm:24` of about 3,910 characters once
  `/ready` reports `audio_transport: r2` (the MP3s are objects, the JSON
  is keys), or `warm:22` of about 2,559 characters until that deploy
  (the inline 80 MiB body). A book already frozen at 4,000 characters
  still ramps, then sends the widest even page that body allows
  (`warm:24` on r2, `warm:13` inline for a 10-hour outline). One row per
  page (`page of 1 rendered 1/1` for every section) is the old
  round-robin split. The deploy that adds `audio_transport` wipes GPU
  snapshots and is a separate step from this worker. The container reads
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and
  `R2_BUCKET_NAME` from the `echomancer-secrets` Modal secret. Without
  those, `/ready` stays `inline` and the body ceiling stays in force.
  Do not set `MODAL_S2_AUDIO_TRANSPORT=r2` on the worker before that
  deploy.
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

- `/ready` still answers `max_containers: 1` (the deploy-time env)
- `status()` on a container still reports `max_containers: 1`
- the live cap is the 8c printout (default 20). Trust that printout and the
  Modal dashboard's Containers tab, not the label.

This is expected, not a failed override. Do not "fix" it by calling
`update_autoscaler` again.

### Re-apply after every deploy

A plain `modal deploy` resets the live autoscaler to the values baked into the
deployment environment. Production's baked env stays at 1. The live cap
this schedule uses is `MODAL_S2_MAX_GPUS` (default 20), applied again after
the deploy. After each production deploy, in this order:

1. `modal run modal/s2_clone_warm.py --verify --containers 3` (the deploy
   invalidated the snapshots — 8b)
2. re-run the 8c `update_autoscaler(min_containers=0, max_containers=N, …)`
   call and read the printed settings. N is `MODAL_S2_MAX_GPUS`. If
   `max_containers` is anything else, 8c is what sets it.

Treat step 2 as part of the deploy, not as an optional follow-up. `/ready`
will not tell you the live cap.

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
the single cap. The one-GPU schedule does not raise it again. The historical
four-lane call is under 8c and is not a current step.

### Alternate: bake `S2C_MAX_CONTAINERS=4` into the deploy

Only if you want the health labels to be correct, or want the cap to survive a
deploy without a manual step. Slower and more expensive than 8a–8c, and 8c is
not needed on this path because the cap is already in the deployment env:

```bash
unset S2C_APP_NAME               # production app, named explicitly below
export S2C_ALLOW_PRODUCTION=1    # required: a bare deploy goes to staging
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
| Clone audio is wrong / silent | `CLONE_TTS_PROVIDER=fish` on the worker. A leftover `openrouter` value is read as `fish` (`resolveCloneProviderPin`). It does not select Drama 3. No deploy needed. |
| Clone path errors | remove `MODAL_S2_TTS_URL` → a book that is not already pinned uses direct Fish. An existing `modal` pin is kept. |
| Cost or container runaway | live: `update_autoscaler(max_containers=1)` on `echomancer-s2-clone.S2CloneWorker` (see "Rolling the lane count back") — no redeploy, snapshots survive. The dashboard's autoscaler panel does the same thing. |
| Books stuck parked | `MODAL_S2_DEFER_MS=0` skips the park and continues the tick. It does not rewrite `provider_pin` on that branch and it does not call Drama 3. After the normal defer budget, with `FISH_API_KEY` set, the rest of the book is pinned to direct Fish (the same voice). With no Fish key the book stays parked. |
| Bad deploy | redeploy the previous commit; **the snapshot is rebuilt**, so re-run steps 3–4, then re-apply the runtime override (or redeploy with the env you want). |

A book that is already `ready` is never re-synthesized by any of these.

---

## 9a. The v10 engine: staged A/B, and how to promote it

`S2C_ENGINE` selects the decode path. It defaults to **`v9`**, which is
byte-for-byte the behaviour of the app running today, so a plain `modal deploy`
changes nothing about how a book sounds. `v10` is the speedup work in this
branch, and it is only ever switched on deliberately.

`S2C_ENGINE` is read **at deploy time** and pinned into the container env (it is
in `_BUILD_ENV`, hence in `S2C_BUILD`). A runtime override cannot move a restored
container onto a decode path its snapshot never compiled.

```bash
# 1. Staging app, v10 engine. Separate app, separate heartbeat dict.
source scripts/s2/staging-env.sh          # S2C_APP_NAME=…-staging, S2C_ENGINE=v10
python3 scripts/s2/check-input-queue.py --app echomancer-s2-clone-staging
modal deploy modal/s2_clone_service.py
modal run modal/s2_clone_warm.py::warm --no-verify --no-synth
python3 scripts/s2/set-live-autoscaler.py --app echomancer-s2-clone-staging \
  --max-containers 1 --scaledown-window 30
```

**Never** export `S2C_APP_NAME` for a production deploy, and never set
`S2C_ENGINE=v10` on production until the numbers below exist.

### A matched A/B, not two different jobs

Run this on the **same staging app**, once per build. The corpus, the seed and
the widths are fixed, so the only variable is the engine.

```bash
export MODAL_S2_TTS_URL=<synthesize_batch host>
export MODAL_S2_READY_URL=<ready host>
export MODAL_S2_TOKEN=…                  # never echo this

# a. the **unmodified PR 283 code**, recorded as the baseline.
#    Not this branch with S2C_ENGINE=v9: the point of a baseline is that it is
#    the code running in production, and a branch's "v9 mode" is a claim about
#    that code, not the code. The identity test below is what backs the claim,
#    but the recorded numbers should still come from the real thing.
git checkout origin/cursor/longer-clone-sections-4994 -- modal/
S2C_APP_NAME=echomancer-s2-clone-staging modal deploy modal/s2_clone_service.py && \
  S2C_APP_NAME=echomancer-s2-clone-staging \
  modal run modal/s2_clone_warm.py::warm --no-verify --no-synth
node scripts/s2/bench-ab.mjs --record /tmp/s2-ab/before --reference-audio <clip>

# b. the candidate, back on this branch
git checkout HEAD -- modal/
S2C_APP_NAME=echomancer-s2-clone-staging S2C_ENGINE=v10 \
  modal deploy modal/s2_clone_service.py && \
  S2C_APP_NAME=echomancer-s2-clone-staging \
  modal run modal/s2_clone_warm.py::warm --no-verify --no-synth
# gate the graphs before spending GPU time on the numbers
S2C_APP_NAME=echomancer-s2-clone-staging \
  python3 scripts/s2/check-cudagraphs.py --since 20m --expect-shapes 24
node scripts/s2/bench-ab.mjs --record /tmp/s2-ab/after --reference-audio <clip>

# c. latency and audio, side by side. Exits non-zero on a regression.
npx tsx scripts/s2/qa-compare.ts /tmp/s2-ab/before /tmp/s2-ab/after
```

`bench-ab.mjs` records wall time, the server's own `performance` breakdown, and
every section's MP3. `qa-compare.ts` prints per-width throughput and gates on
**deltas against the baseline** — which is what makes a candidate that is
slightly worse but still above a fixed floor fail:

| Gate | Rule |
|---|---|
| Completeness | every section present, decodable, `truncated_units == 0` |
| Duration | within ±7% of the baseline, per section |
| Speaker similarity | ≥ baseline − 0.01, and ≥ 0.80 absolute |
| Intra-section drift | `last 15 s − first 15 s` ≥ −0.05 |
| DNSMOS SIG / BAK / OVRL | each ≥ baseline − 0.05, and OVRL ≥ 3.0 absolute |
| Pacing | silence ratio within ±2 points of the baseline |
| Splice hygiene | no sample step past 40× the take's own p99.9 |
| ASR | ≤ baseline + 0.5 points, and < 5% absolute; no repeated/missing 6-word run |

`generate_s` in the server's `performance` is **AR only** now; the codec has its
own `codec_s` and `codec_tail_s` columns, and `generate_and_codec_s` is the sum so
the two can be checked against each other.

A **placeholder reference tone is not a quality measurement.** Pass
`--reference-audio <16–20 s public-domain reading>` (with `<path>.txt` beside it)
for the similarity and WER gates to mean anything. The script says so, and
`qa-compare.ts` lists every gate it could not run: a run that measured no quality
must not look like a pass.

### What to expect, and what must be measured

The plan's model is ~45–50x realtime before the AR changes and ~70x+ after, from
a measured 33x baseline (24 rows, 43,907 characters, 83.18 s). **None of that is
in the worker's planner yet.** `MODAL_CLONE_FULL_BATCH_CHARS_PER_SECOND` stays at
the measured 528, so a page is *over*-estimated in wall time until staging
replaces it with a number this engine actually produced. Calibrate it, with a
~15% safety margin, only after the A/B is green.

The two switches that are a measurement rather than a known win are off in v10
and should be tried on their own:

| Switch | What it changes |
|---|---|
| `S2B_SDPA_DECODE=1` | folded-GQA SDPA for the slow decode attention. Wins or loses by KV length; measure at 512/1024/2048/4096 |
| `S2B_TOPK_FAST_SAMPLE=1` | sample over the top-k block instead of the full vocabulary. Same distribution, different rounding |

And each v10 change can be isolated off, which is what a targeted A/B needs:

| Switch | v9 behaviour it restores |
|---|---|
| `S2B_WORK_STEAL=0` | one unit at a time per section |
| `S2B_BUCKET=0` | step `S2B_BATCH` rows per call |
| `S2B_PIPELINE_CODEC=0` | serial codec → encode → upload |
| `S2B_CODEC_TUNING=0` | keep `weight_norm` and rebuild the codec's causal mask |
| `S2B_FAST_DECODE=0` | call upstream's fast-transformer step and sampler |
| `S2B_BATCHED_PREFILL=0` | prefill one lane at a time |

### One bucket rule this deploy depends on

An `r2` page writes each section to `s2-takes/<job>/<call>/<key>.mp3`, and the
worker deletes each object after reading it. That delete is deliberately not
awaited (an awaited DELETE is a round trip of idle GPU time between batches), so
a worker that crashes mid-page leaves objects behind, and a failed upload leaves
one that was never read.

Add a **free** lifecycle rule on the bucket rather than relying on the worker:

```
Cloudflare dashboard → R2 → echomancer-audio → Settings → Object lifecycle rules
  Name:        expire-s2-takes
  Prefix:      s2-takes/
  Action:      Delete objects after 1 day
```

One day is far longer than any call (the longest is minutes) and short enough
that a forgotten staging run cannot accumulate. Nothing else in the bucket uses
the `s2-takes/` prefix, so the rule cannot touch a book's audio.

Check it took effect by listing a prefix that should have expired:

```bash
# after a staging run and ~24h
python3 scripts/s2/check-input-queue.py --app echomancer-s2-clone-staging   # unrelated but cheap
# then confirm in the dashboard: R2 → echomancer-audio → s2-takes/ is empty
```

### Hard checks before promoting

One command runs the graph checks, and it **fails** rather than reporting:

```bash
S2C_APP_NAME=echomancer-s2-clone-staging \
  python3 scripts/s2/check-cudagraphs.py --since 30m --expect-shapes 24
```

It exits non-zero on any `skipping cudagraphs` line, any recompilation, any
missing warm-up record, or a post-restore replay that came back short. A call
still *succeeds* with the graphs skipped — about twice as slowly — which is why
this has to be a gate and not a symptom anybody would notice.

Then read the rest of the log for the qualitative facts:

```bash
modal app logs echomancer-s2-clone-staging --since 20m \
  | grep -E 'S2B|S2C|Snapshot created'
```

- `[S2B] warm decode shapes: 24` — six width buckets × four KV buckets. A
  smaller number means some call will record a graph on the request path;
- `[S2B] selftest: {... 'ok': True ...}` and
  `[S2C] ... graphs=ok(N)` — the step replayed after the restore, on the GPU
  thread, before the first heartbeat;
- `/ready` reports `version=10`, `audio_transport=r2`, `max_batch_items=32`,
  and `cpu` (the container's real CPU count — `S2C_CPU=8` on staging);
- after ~30 s idle, `/ready` returns 503 with `warm_containers: 0`
  (`min_containers` is still 0). That 503 body also carries
  `audio_transport` and `max_batch_items`, because the worker sizes its next
  page from them.

Then the cold-HTTP proof from §5a: a first `POST /synthesize` after
scale-to-zero must be **200**, not 500 `CUBLAS_STATUS_ALLOC_FAILED`.

### Cost of the v10 A/B

At H100 $0.001097/s plus ~$0.0001/s for 8 vCPU, about **$0.0012/s**. v10 changes
two things that move this: the snapshot warms **24 decode shapes** (6 width
buckets × 4 KV buckets) instead of a handful, and every container replays them
once after a restore before its first heartbeat.

| Phase | What changed vs the v9 estimate | H100-seconds | est. |
|---|---|---:|---:|
| Baseline deploy + compile (PR 283 code) | unchanged | ~720 | $0.86 |
| Baseline 1/4/24-wide capture | unchanged | ~150 | $0.18 |
| Candidate deploy + compile | 24 warmed shapes: roughly +30–60 s of capture, once | ~820 | $0.98 |
| Graph gate | free (reads logs) | 0 | — |
| Cold restore + replay proof | `selftest` replays 6 shapes at boot: a few hundred ms | ~70 | $0.08 |
| Candidate 1/4/24/32-wide + SDPA A/B | unchanged | ~260 | $0.31 |
| 2-container fanout smoke | unchanged | ~240–960 | $0.29–1.15 |
| Contingency redeploy | unchanged | ~840 | $1.01 |
| **Total** | | **~52–64 H100-min** | **$2.7–$4.6** |

The boot replay is the only recurring cost: a few hundred milliseconds per
container start, which is far cheaper than one section rendered at half speed
because a graph was recorded on the request path.

### Order matters for the worker

The worker widens a steady page to 32 rows only once `/ready` reports **both**
`audio_transport: "r2"` **and** `max_batch_items >= 32`. Against the live v9
container it plans ≤ 24 inline rows, which is exactly what that container
accepts. So the worker may be deployed before the Modal app; a worker that
guessed 32 would collect `422 batch_too_large` on every full page.

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
Runtime override:   update_autoscaler(max_containers=N, scaledown_window=15, min_containers=0)
Live cap printed:   max_containers=N (N = MODAL_S2_MAX_GPUS, default 20; not the /ready label)
Health labels:      /ready max_containers still ____ (deploy-time env; live cap is the 8c printout)
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
