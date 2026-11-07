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
not. A full cap stores the provider take at
`audiobooks/<jobId>/raw/NNNN.<ext>` and leaves the section `mastering`.
It does not write `sections/NNNN.mp3` and it does not mark the section
ready. The next tick claims the same task. No resynthesis.

## App

| | |
|--|--|
| File | `modal/cpu_worker.py` |
| Image | `workers/cpu/Dockerfile` (ffmpeg, Node, faster-whisper package only) |
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

## Knobs

Read at deploy time from the environment of `modal deploy`. They are
billing dimensions, not a measurement of this workload. Modal's current
CPU price is on their pricing page. This repo does not copy a dollar
figure for it.

| Env | Default | Effect |
|--|--|--|
| `CPU_FUNCTION_CPU` | 2 | CPUs per container |
| `CPU_FUNCTION_MEMORY_MB` | 4096 | Memory per container |
| `CPU_FUNCTION_TIMEOUT_S` | 900 | Wall clock for one task. The child is killed at timeout−30s. |
| `CPU_MAX_CONTAINERS` | 4 | Fleet cap. This is the spend ceiling. |
| `CPU_SCALEDOWN_SECONDS` | 60 | How long an idle container stays up. |
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
modal deploy modal/cpu_worker.py
```

Copy the endpoint URL Modal prints. It is the host only, no path.

On the take-home VM, after that deploy:

```bash
CPU_RUNNER=modal
MODAL_CPU_URL=https://<workspace>--echomancer-cpu-run.modal.run
MODAL_CPU_TOKEN=<same value as the secret>
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

Until that smoke passes, leave `CPU_RUNNER` unset and leave
`WORKER_CONCURRENCY=1`.

## Rollback

Unset `CPU_RUNNER` and `MODAL_CPU_URL` on the VM and restart the worker.
Tasks then run locally again. The `cpu_tasks` table can stay. Do not
drop it. A queued master task still publishes the same section key, so
a book that was mid-master continues without a new synthesis.

Leaving the Modal app deployed with `min_containers=0` and no caller
costs nothing once the last container has scaled down. To remove it:

```bash
modal app stop echomancer-cpu
```

Stopping the CPU app does not stop `echomancer-s2-clone`.
