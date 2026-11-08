# Modal CPU workers

Extract, section mastering, local Whisper QA, and the final concat are
rows in `cpu_tasks`. The take-home VM orchestrates. A CPU container does
the ffmpeg and Whisper work. The S2 GPU app is a different Modal app and
is not changed by this deploy.

The remote command below is what the executor runs after `modal deploy`.
This change did not build the image and did not call Modal. `--local`
runs in CI against ffmpeg and a temp database. No dollar amount was
measured.
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
| 429, 400, 401 | released, attempt undone | may POST |
| completed 404 / 500 / other HTTP error | rejected, attempt undone, row `failed` | does not POST |
| body says the workspace is disabled | released, attempt undone, book `failed` | does not POST until usage is allowed |
| `ECONNREFUSED` / `ENOTFOUND` | released | may POST |
| row `done` and the object exists | finished | does not run again |

A disabled-workspace body is the platform refusing the deployed hostname.
Our handler does not return it. In November 2026 the budgets tab showed
a user-set workspace budget fully used, with usage stopped. That was not
a payment error. The tab does not name the request that crossed the cap,
and this repo does not invent one. CPU spend on that cycle was $0.31,
so the stop was not the CPU app's own bill. Recovery of raw takes
is `scripts/repair-raw-masters.ts`. It is dry-run unless the operator
passes `--confirm-service-available` or `--approve-local` after a backup.
It does not call Modal and it does not change the budget.

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

`workers/cpu/requirements.txt` is installed with pip's normal resolver.
The 253 image build died in `python3 -c "import faster_whisper"` with
`ModuleNotFoundError: No module named 'requests'`
(`faster_whisper/utils.py`). That file imports `requests`, and
faster-whisper 1.1.1 does not declare it. `huggingface-hub` 1 and later
replaced `requests` with `httpx`, so a bare
`pip install faster-whisper==1.1.1` no longer installs `requests` either.
The requirements file was not installed with `--no-deps`. It now pins
`requests==2.34.2` and `huggingface-hub==0.36.2` (the last 0.x release,
which still depends on `requests` and still accepts this Whisper
release's download kwargs). The image build imports `WhisperModel`, the
same object section QA constructs, so a missing import fails the image
instead of a later book.

`.pip_install("fastapi[standard]==0.115.6")` is the next image layer,
the same pin as the S2 web image. Modal runs it as
`python -m pip install` on the apt interpreter, with no
`--break-system-packages`. Image `im-dGus2sr59aVrvZXCXtfKyK` died there
with Debian's PEP 668 `externally-managed-environment`. Builder 2024.10
also installs Modal's client requirements with `uv pip install --system`,
which ignores `pip.conf` and does not install into a venv. The Dockerfile
removes the `EXTERNALLY-MANAGED` marker and sets
`PIP_BREAK_SYSTEM_PACKAGES=1` and `UV_BREAK_SYSTEM_PACKAGES=1` before any
of those layers. `/etc/pip.conf` is also written, and `pip install`
reads it. `pip config get` does not: without `--global` it reads the
user file, and it never reads `PIP_BREAK_SYSTEM_PACKAGES`. Image
`im-oJzVu85GpcXX53Z5cj9Ob6` died on
`python3 -m pip config get global.break-system-packages` with
`No such key` after the requirements install, the version probe, the
env flags, the marker removal, and the `requests` / `WhisperModel`
imports had already passed. The build check is now a flagless
`python3 -m pip install --dry-run --no-index` of the installed
`requests==2.34.2` pin. That is the same gate as Modal's next layer.
Do not add a venv and do not pass `add_python`. Do not pip-install
FastAPI by hand on a container.

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
| `CPU_SCALEDOWN_SECONDS` | 300 | How long an idle container stays up. That idle time is billed. |
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
CPU_SCALEDOWN_SECONDS=300 \
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

Leave `CPU_RUNNER` unset on the take-home VM until the command below
exits 0. The script sets `CPU_RUNNER=modal` in its own process. It does
not restart pm2 and it does not synthesize speech.

It inserts one job, `cpusmoke` plus 16 hex digits, status `ready` (the
drain does not claim `ready`), two 0.5s generated tones, and the
`cpu_tasks` for those objects. It then:

1. Masters section 0 through `runCpuTask` and waits until the row is
   `done` or `SMOKE_BOUND_MS` (default 240000). The accept wait itself
   cannot exceed 60s; a cold start that outlives that is polled on the row.
2. Dispatches section 1 and, when `started_at` is set, calls `runCpuTask`
   again (must return `accepted` without a new owner) and kills the
   caller. The container is expected to finish that section afterwards.
   If that section reaches `done` before the kill, the same check runs
   once more on section 2. A second `runCpuTask` must not change the
   object hash. Concat still uses sections 0 and 1.
3. Concats the two mastered sections to `full.mp3`.
4. Deletes that job, its `cpu_tasks`, and keys under
   `audiobooks/<id>/` only. A drop in the count of other jobs or tasks
   fails the run.

From the repo root, with the Modal URL and the same token as the secret.
Do not print the token. Do not export these into the worker environment.

```bash
MODAL_CPU_URL='https://<workspace>--echomancer-cpu-run.modal.run' \
MODAL_CPU_TOKEN='<secret value>' \
TURSO_DATABASE_URL='libsql://…' \
TURSO_AUTH_TOKEN='…' \
R2_ACCOUNT_ID='…' \
R2_ACCESS_KEY_ID='…' \
R2_SECRET_ACCESS_KEY='…' \
R2_BUCKET_NAME='echomancer-audio' \
SMOKE_BOUND_MS=240000 \
node --import tsx scripts/cpu/smoke-remote.ts --confirm-synthetic
```

The last stdout line is one JSON object, `event: "summary"`. `ok` is
true only when master, disconnect, single-flight, republish, and concat
all passed and cleanup left no key under that prefix. `checks` includes
each task's status, attempts, lease, and error. Exit 0 is that pass.
Exit 1 still attempts cleanup.

A URL with a path is rejected before any database call. A stranded run,
and nothing else, is removed with:

```bash
node --import tsx scripts/cpu/smoke-remote.ts --confirm-synthetic \
  --cleanup-only cpusmoke<16 hex>
```

`node --import tsx scripts/cpu/smoke-remote.ts --local` is the same
master and concat on ffmpeg, in a temp database, with R2 cleared. It
does not open a Modal URL. Disconnect is `not-applicable` there because
there is no HTTP caller.

`min_containers=0` scales an idle container down after
`CPU_SCALEDOWN_SECONDS` (default 300). A create-flow click can POST
`{"warm": true}` with no task id. That starts one container and returns.
A busy container answers without a second try. `modal app stop echomancer-cpu` is not required
after a passing smoke. The GPU `/ready` host is a different app and is
not called.

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
