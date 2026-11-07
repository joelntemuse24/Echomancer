# Modal CPU workers

Extract, section mastering, local Whisper QA, and the final concat are
rows in `cpu_tasks`. The take-home VM orchestrates. A CPU container does
the ffmpeg and Whisper work. The S2 GPU app is a different Modal app and
is not changed by this deploy.

This runbook was not executed in the change that added it. No image was
built, no container was started, and no dollar amount was measured.
`WORKER_CONCURRENCY` stays 1 until the smoke below has been run on a
staging book and the master step did not OOM.

## What is already true without a deploy

`CPU_RUNNER` unset (the default) claims `cpu_tasks` on the take-home VM.
Permits are per host (`CPU_HOST_ID`, default the machine hostname), so
two processes on that machine share one cap and a second machine does
not. The process orchestrates one book. `WORKER_CONCURRENCY` above 1 is
clamped unless `WORKER_LOCAL_MULTIBOOK=1`. A full cap stores the
provider take at `audiobooks/<jobId>/raw/NNNN.<ext>` and leaves the
section `mastering`. It does not write `sections/NNNN.mp3` and it does
not mark the section ready. The next tick claims the same task. No
resynthesis. A raw object with no segment row is recovered the same way.

## Dispatch

The orchestrator claims the row, then POSTs `{ taskId, ownerToken }`.
It waits `CPU_DISPATCH_ACCEPT_MS` (default 20s) for the HTTP result.
That is not the container budget.

| Response | Placement | Next caller |
|--|--|--|
| timeout, reset, or live lease | kept | does not POST |
| 200/202 and the row is not `done` yet | kept | does not POST |
| 429, 400, 401 | released | may POST |
| `ECONNREFUSED` / `ENOTFOUND` | released | may POST |
| row `done` and the object exists | finished | does not run again |

The container adopts `CPU_TASK_OWNER`. It does not claim a second token.
It does not return until the child exits, so the orchestrator hanging up
does not cancel the task. A late completion with any other token does
not publish. `placed_at`, `started_at`, `finished_at` are the queue-wait
and active-time columns. Dispatch and completion log one `[cpu]` JSON line.

A book whose remaining work is CPU goes back to `queued` with
`sched_not_before` (`CPU_YIELD_SEC`, default 3). Another book can take
the orchestrator slot. `TAKEHOME_GLOBAL_ACTIVE` (default 16) is the
cluster lease cap. `TAKEHOME_MAX_INFLIGHT_PER_USER` (default 1) is the
per-user cap. Both are enforced on the claim, not only on the list.

With `CPU_RUNNER=modal` and `WORKER_CONCURRENCY` unset, each VM opens
`ORCH_CONCURRENCY` slots (default 8). An explicit `WORKER_CONCURRENCY`
still wins. Replicas share the database caps. The S2 GPU pool is a
different app and stays scale-to-zero.

## What the offline tests prove

They do not call Modal, a paid TTS API, or a GPU.

- 200 fake-provider books finish with at most two ticks in flight and
  more than one user in the first claims. That is fair queue progress,
  not 200 simultaneous provider calls.
- Two worker loops, `TAKEHOME_GLOBAL_ACTIVE=2`, finish 8 books. Overlapping
  synthesis stays at or under 2. Each book gets its own `full.mp3`.
- A third `claimTakehomeLease` returns null while two leases are live.
- A generated tone is mastered and joined by the local ffmpeg path, and
  a raw object left without a segment row is mastered without a second
  synthesis.
- A caller that times out does not POST again. A late `completeCpuTask`
  with the placement token is kept. A different token cannot complete it.
- Two overlapping callers produce one POST. A 500 that leaves the lease
  live is `accepted`, not a failed task. A 429 releases the placement.

The three-section join check on main passes. The old 1638-count step
was the MP3 decoder delay being crossfaded into the book. It is not an
expected failure of this deploy.

## App

| | |
|--|--|
| File | `modal/cpu_worker.py` |
| Image | `workers/cpu/Dockerfile` (Node 22, ffmpeg, apt `python3` + `faster-whisper`) plus `Image.pip_install("fastapi[standard]==0.115.6")` |
| App | `echomancer-cpu` (`CPU_APP_NAME` overrides) |
| Endpoint | `POST` body `{ "taskId": "master:<jobId>:<index>" }` |
| Secret | `echomancer-cpu` |

The endpoint host is `MODAL_CPU_URL`. A URL with a path is rejected.
The container runs `src/worker/cpu-once.ts`, which claims the row and
reads and writes object storage. It does not use the VM's temp directory.

Create the secret in the Modal dashboard. Do not commit the values.

```
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
MODAL_CPU_TOKEN
WORKER=1
CPU_RUNNER=local
```

`MODAL_CPU_TOKEN` is the bearer the orchestrator sends and the endpoint
requires. An empty token answers 401.

Modal rejected the first image with `unable to determine the version of
Python installed in the Image provided for the run Function`. It learns
that version by running `python -VV`, and it also requires `pip` on
`PATH`. The Node base image's apt Python is only `python3` / `pip3`, so
the Dockerfile installs `python-is-python3` and links `pip`. Do not pass
`add_python` on `Image.from_dockerfile`. That installs a second
interpreter in `/usr/local` and the QA child would stop seeing
`faster-whisper`.

The endpoint's FastAPI does not come from `pip3` in the Dockerfile.
Modal runs the Function in its own image interpreter, and a package
installed into apt Python is not importable there. The first deploy
needed a manual install into that environment. The app definition now
calls `.pip_install("fastapi[standard]==0.115.6")` after the Dockerfile,
the same pin as the S2 web image. Do not pip-install FastAPI by hand on
a container.

## Knobs

Read at deploy time from the environment of `modal deploy`. They are
billing dimensions, not a measurement of this workload. Modal's current
CPU price is on their pricing page. This repo does not copy a dollar
figure for it.

| Env | Default | Effect |
|--|--|--|
| `CPU_FUNCTION_CPU` | 2 | CPUs per container |
| `CPU_FUNCTION_MEMORY_MB` | 4096 | Memory per container |
| `CPU_FUNCTION_TIMEOUT_S` | 900 | Master, whisper, extract. The child is killed at timeout−30s. |
| `CPU_CONCAT_TIMEOUT_S` | 3600 | Concat only. The function timeout is `max` of this and the section budget. |
| `CPU_MAX_CONTAINERS` | 4 | How many containers may exist. Not a dollar cap. |
| `CPU_SCALEDOWN_SECONDS` | 60 | How long an idle container stays up. That idle time is billed. |
| `CPU_DISPATCH_ACCEPT_MS` | 20000 | Orchestrator HTTP wait. Set on the VM, not on this image. |
| `CPU_PLACEMENT_LEASE_S` | 180 | VM lease covering cold start until the child heartbeats. |
| `min_containers` | 0 | Idle is zero containers. Not an env override. |

A container runs one task at a time. A second request gets HTTP 429 and
the row stays queued. `CPU_HOST_ID` inside the container is
`MODAL_TASK_ID`, so each container's permit cap is its own.

The image installs the faster-whisper package and does not download
weights. The first QA task on a new container fetches the `base` model.
That fetch is part of the smoke, not of `git push`.

GPU lanes stay on `echomancer-s2-clone`. Deploying this app does not
reset that autoscaler. Do not `modal deploy` the S2 app as part of this
rollout.

## Deploy

From the repo root, with the Modal CLI logged in and the secret saved:

```bash
CPU_MAX_CONTAINERS=4 \
CPU_FUNCTION_CPU=2 \
CPU_FUNCTION_MEMORY_MB=4096 \
CPU_SCALEDOWN_SECONDS=60 \
CPU_FUNCTION_TIMEOUT_S=900 \
CPU_CONCAT_TIMEOUT_S=3600 \
modal deploy modal/cpu_worker.py
```

Copy the endpoint URL Modal prints. It is the host only, no path.

On the take-home VM, after that deploy:

```bash
CPU_RUNNER=modal
MODAL_CPU_URL=https://<workspace>--echomancer-cpu-run.modal.run
MODAL_CPU_TOKEN=<same value as the secret>
CPU_DISPATCH_ACCEPT_MS=20000
CPU_PLACEMENT_LEASE_S=180
# Leave WORKER_CONCURRENCY unset so ORCH_CONCURRENCY (default 8) applies.
ORCH_CONCURRENCY=8
TAKEHOME_GLOBAL_ACTIVE=16
TAKEHOME_MAX_INFLIGHT_PER_USER=1
```

Restart the worker so it reads the env. Restart is an operational step.
It was not done with this change.

```bash
pm2 restart echomancer-takehome --update-env
```

## Smoke

Use a short synthetic file, not a customer book. Confirm, in order:

1. `GET` the worker `/ready` still returns ok. The GPU `/ready` is a
   different host and should be unchanged.
2. One take-home with mastering on. The raw key appears before the
   section key. The section row is `ready` only after
   `sections/NNNN.mp3` exists, and `mastered` is true.
3. A second book started while the first container is busy either waits
   (`429`, section stays `mastering`) or runs on a second container, and
   never exceeds `CPU_MAX_CONTAINERS`.
4. Cancel mid-task. The section does not become `ready`.
5. `modal app stop echomancer-cpu` is not required: `min_containers=0`
   scales the container down after `CPU_SCALEDOWN_SECONDS`.

Until that smoke passes, leave `CPU_RUNNER` unset. Local CPU then stays
one orchestrator slot even if `WORKER_CONCURRENCY` is raised.

## Rollback

Unset `CPU_RUNNER` and `MODAL_CPU_URL` on the VM and restart the worker.
Tasks then run locally again, one book at a time. The `cpu_tasks` table
and `sched_not_before` can stay. Do not drop them. A queued master task
still publishes the same section key, so a book that was mid-master
continues without a new synthesis. `TAKEHOME_GLOBAL_ACTIVE=0` disables
the cluster lease cap without a schema change.

Leaving the Modal app deployed with `min_containers=0` and no caller
costs nothing once the last container has scaled down. To remove it:

```bash
modal app stop echomancer-cpu
```

Stopping the CPU app does not stop `echomancer-s2-clone`.
