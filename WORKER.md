# Always-on Whole-book worker

Trigger.dev used to host Whole-book / take-home narration. That role is now
an always-on Node process Joel can run on a rented VM. **Document extract
stays on Cloudflare Workers** (`workers/extract`) with the Vercel `after()`
fallback. Do not parse books on this VM.

TTS still happens at Fish / Edge / Google. The VM only orchestrates:
enqueue → `process-job` loop → retries → Turso progress → concat / master → R2.

## Recommended VM

| | Minimum | Recommended |
|--|---------|-------------|
| vCPU | 2 | 4 |
| RAM | 4 GB (`WORKER_CONCURRENCY=1`) | **8 GB** (`WORKER_CONCURRENCY=2`) |
| Disk | 20 GB | 40 GB SSD |
| OS | Ubuntu 22.04+ x86_64 | same |

DeepFilterNet3 + a long-book WAV buffer is the RAM hog. On 4 GB leave
concurrency at 1. Do not undersize below 4 GB if mastering is on.

## Ports

| Port | Bind | Purpose |
|------|------|---------|
| **8788** | `0.0.0.0` inside Docker; publish on the VM | Health + enqueue |

Vercel must reach `WORKER_URL` (this port, or a TLS reverse proxy in front
of it). There is no webhook back to Vercel — progress lives in Turso.

Firewall options:

1. **TLS reverse proxy (recommended):** Caddy/nginx on 443 → `127.0.0.1:8788`.
   Set Vercel `WORKER_URL=https://worker.your-domain`.
2. **Raw 8788:** allow `0.0.0.0/0` TCP 8788 and rely on `WORKER_SECRET`.
   Vercel egress IPs are not a stable allowlist.

## Run on the VM

```bash
git clone https://github.com/joelntemuse24/Echomancer.git
cd Echomancer
cp env.worker.example .env.worker
# fill Turso, R2, FISH/GOOGLE, WORKER_SECRET
docker compose up -d --build
curl -fsS http://127.0.0.1:8788/health
# {"ok":true,"service":"echomancer-takehome",...}
```

Without Docker:

```bash
cp env.worker.example .env.worker
npm ci
npm run worker:takehome
```

`restart: unless-stopped` keeps the compose service up across reboots.

## Vercel env (production)

| Variable | Required | Notes |
|----------|----------|--------|
| `WORKER_URL` | **yes** to leave Trigger | `https://worker.example.com` (no trailing slash) |
| `WORKER_SECRET` | recommended | Same value as on the VM. Falls back to `INTERNAL_JOB_SECRET` if unset |
| `TAKEHOME_TRIGGER_FALLBACK` | no | `1` = also fire Trigger if the worker POST fails |
| `TRIGGER_SECRET_KEY` | only if no `WORKER_URL` yet | Existing Trigger path; keep until the VM is healthy |

Once `WORKER_URL` is set, `POST /api/jobs` take-home (and retry /
`/takehome`) POSTs `{ jobId }` to `WORKER_URL/jobs` with
`Authorization: Bearer $WORKER_SECRET`. Missing both `WORKER_URL` and
`TRIGGER_SECRET_KEY` in production is **503** `TAKEHOME_NOT_CONFIGURED`
**before insert**. After insert, a failed worker POST leaves the job
`queued` for the VM drain loop (still HTTP 200).

You can remove `TRIGGER_SECRET_KEY` from Vercel after the VM is taking
jobs. Leave Trigger tasks in the repo as an optional fallback.

## Worker env

See `env.worker.example`. Same Turso + R2 + TTS keys as Vercel, plus:

| Variable | Default | Meaning |
|----------|---------|---------|
| `WORKER_SECRET` | — | Shared with Vercel |
| `WORKER_CONCURRENCY` | 2 | Jobs in flight (1 on 4 GB RAM) |
| `WORKER_DRAIN_INTERVAL_MS` | 15000 | Turso poll (queued + lease-expired) |
| `WORKER_PORT` | 8788 | Listen port |
| `TTS_VM_WAVE_BUDGET_MS` | 900000 | Wave clock (same idea as Trigger) |
| `DEEP_FILTER_BIN` | `/usr/local/bin/deep-filter` | Set by the image |
| `TTS_MASTER_FULL_BOOK` | `1` | Enable DFN 70/30 + loudnorm on this host |

`WORKER=1` marks the process as the Whole-book host (mastering gate,
secrets check). Never set `VERCEL=1` here.

## Endpoints

| Method | Path | Auth | Role |
|--------|------|------|------|
| `GET` | `/health` | none | Liveness for Docker / compose |
| `GET` | `/ready` | none | 200 if Turso answers; 503 otherwise |
| `POST` | `/jobs` | Bearer | `{ "jobId" }` — wake that take-home |

Logs go to stdout (`[takehome-worker] …`). `docker compose logs -f takehome`.

## Cancel and concurrency

Unchanged: `POST /api/jobs/[id]/cancel` sets `cancelled` and clears the
lease. `runTakehomeUntilSettled` stops on `ready` / `failed` / `cancelled`.
Two workers cannot synthesize the same section — lease tokens already
gate every progress write. This process also refuses to start a `jobId`
that is already in flight.

## Migration

1. Build and start the worker on the VM (`docker compose up -d --build`).
2. Confirm `GET /health` and `GET /ready`.
3. Set `WORKER_URL` + `WORKER_SECRET` on Vercel (Production).
4. Create a small Whole-book job. Library should leave `queued` without
   a Trigger run. Worker logs show `enqueued` / `settled`.
5. Optional: `TAKEHOME_TRIGGER_FALLBACK=1` for a week, then drop
   `TRIGGER_SECRET_KEY` on Vercel and stop paying for Trigger.

Extract is unchanged: `EXTRACT_WORKER_URL` still points at Cloudflare.
The Vercel `/api/cron/process-jobs` operator fallback remains.

## Troubleshooting

| Issue | Check |
|-------|--------|
| Jobs sit at `queued` | VM down, `WORKER_URL` unreachable from Vercel, or Turso creds missing on the VM |
| `TAKEHOME_NOT_CONFIGURED` 503 | Production has neither `WORKER_URL` nor `TRIGGER_SECRET_KEY` |
| Worker 401 | `WORKER_SECRET` / `INTERNAL_JOB_SECRET` mismatch |
| `/ready` 503 | `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` on the VM |
| OOM during master | Drop `WORKER_CONCURRENCY` to 1 or use the 8 GB box |
| Extract jobs on this VM | Don't — extract stays on `workers/extract` |
