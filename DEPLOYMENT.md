# Echomancer Deployment Guide

Documents → audiobook on **Vercel** + **Turso** + **Cloudflare R2**. All TTS goes through **OpenRouter**.

## Architecture

```
Browser → Vercel (Next.js)
            ├── Turso (jobs, uploads, usage, rate limits)
            ├── R2 (uploaded text + audio sections + full book)
            ├── Fish Audio (Live Listen / Live Stream)
            └── Always-on VM worker (Whole book)
                    ├── same Turso + R2 + FISH / Google keys
                    └── POST /jobs → runTakehomeUntilSettled
```

| Path | Flow |
|------|------|
| Live Listen | Vercel `GET/POST /api/tts/live` → Fish HTTP chunked |
| Live Stream | `POST /api/jobs` → player → `GET /api/jobs/[id]/stream` (Vercel) |
| Whole book | `POST /api/jobs` (enqueue + `POST $WORKER_URL/jobs`) → VM `runTakehomeUntilSettled` → sections on R2 → `full.*` |

Job creation never synthesizes. The VM worker is the durable host. Trigger.dev
is an optional fallback when `WORKER_URL` is unset or
`TAKEHOME_TRIGGER_FALLBACK=1`. Vercel `/api/cron/process-jobs` and
`/api/jobs/[id]/process` remain operator fallbacks. Extract stays on
Cloudflare Workers — do not parse books on the VM. See [WORKER.md](WORKER.md).

## Prerequisites

1. Vercel account
2. Turso database (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`)
3. Cloudflare R2 bucket + API tokens
4. OpenRouter API key with speech model access

## Environment variables

### Required

```bash
SESSION_SECRET=...               # Signs session cookies — see "Sessions" below
AUTH_SECRET=...                  # Optional; Auth.js reuses SESSION_SECRET
AUTH_GOOGLE_ID=...               # Google OAuth client id
AUTH_GOOGLE_SECRET=...           # Google OAuth client secret
AUTH_URL=https://echomancer.xyz  # Canonical origin for Auth.js callbacks
INTERNAL_JOB_SECRET=...          # Protects /api/jobs/[id]/process
CRON_SECRET=...                  # Protects /api/cron/process-jobs
OPENROUTER_API_KEY=...
FISH_API_KEY=...                 # Clones, Live Listen, direct Fish take-home
WORKER_URL=https://worker.example.com  # Always-on Whole-book VM
WORKER_SECRET=...                # Shared with the VM (or reuse INTERNAL_JOB_SECRET)
TRIGGER_SECRET_KEY=...           # Optional Trigger fallback if WORKER_URL is unset
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=echomancer-audio
NEXT_PUBLIC_APP_URL=https://your-domain.com
```

Generate the secrets with `openssl rand -hex 32`.

### Optional

```bash
# Randolph (Google Cloud TTS). Required to preview / generate that voice.
# Also used as a direct fallback for leftover Google catalog ids.
GOOGLE_TTS_API_KEY=...
# GOOGLE_TTS_ACCESS_TOKEN=...
GEMINI_API_KEY=...
XAI_API_KEY=...

# Premium HD gate
PREMIUM_HD_ENABLED=false
PREMIUM_HD_ALLOWLIST=

# MiniMax Free API (optional) — see RESEARCH_PREVIEW.md
# MINIMAX_FREE_API_BASE_URL=http://127.0.0.1:8000
# MINIMAX_FREE_API_TOKEN=…

# Uploads (keep both in sync — the second is what the UI can read)
MAX_UPLOAD_MB=512
NEXT_PUBLIC_MAX_UPLOAD_MB=512

# Workers
TTS_SECTIONS_PER_TICK=6
TTS_WORKER_WAVE_BUDGET_MS=240000
TTS_TRIGGER_WAVE_BUDGET_MS=900000
TTS_CRON_JOBS_PER_RUN=3
TTS_LEASE_TTL_SECONDS=90
TTS_POLL_NUDGE_BUDGET_MS=0        # Production: polls are read-only (hard-capped at 45s if set)

# Always-on VM (Whole book) — see WORKER.md
WORKER_URL=https://worker.example.com
WORKER_SECRET=...
# TAKEHOME_TRIGGER_FALLBACK=1
# TRIGGER_SECRET_KEY=tr_...       # Only if the VM URL is not set yet
# TRIGGER_PROJECT_ID=proj_...

# Stream + pricing
STREAM_MAX_AUDIO_SECONDS=3600
TTS_PRICE_MARKUP=2.0
TTS_PRICE_FIXED_EUR=0.5
TTS_USD_TO_EUR=0.92
TTS_MIN_PRICE_EUR=1.99

# Storage (local only when R2 unset)
STORAGE_PATH=./data/storage
R2_PUBLIC_URL=...
```

## Sessions

Every job, upload and audio object belongs to a signed session so one visitor
cannot read or delete another's book. Signed-out visitors get an `anon_*`
identity; Google sign-in upgrades the same `ec_session` cookie to a durable
`user_*` stored in Turso `users`. `SESSION_SECRET` (falling back to
`INTERNAL_JOB_SECRET`) signs those cookies. Auth.js uses `AUTH_SECRET` when set,
otherwise the same `SESSION_SECRET`.

**Production refuses to sign sessions without a secret** — uploads return 503 and
owned routes return 401 — rather than inventing a per-instance key, which would
give each serverless instance a different notion of identity and lose people
their libraries at random.

Google sign-in additionally requires `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`.
If they are missing, starting sign-in returns 503 (`GOOGLE_AUTH_NOT_CONFIGURED`);
anonymous upload and Live Listen still work.

Authorized redirect URIs in Google Cloud:

- `https://echomancer.xyz/api/auth/callback/google`
- `http://localhost:3000/api/auth/callback/google`

Rotating the secret invalidates every existing session: those visitors keep their
rows in the database but can no longer see them. Treat it as permanent.

## maxDuration

| Route | `maxDuration` | Why |
|-------|---------------|-----|
| `/api/cron/process-jobs` | 300 | Longest worker pass; drains several jobs |
| `/api/jobs/[id]/process` | 300 | One job, many ticks |
| `/api/jobs/[id]/stream` | 300 | Live audio pipe until the player reconnects |
| `/api/jobs/[id]/download` | 300 | Concatenating a full book |
| `/api/jobs`, `/api/jobs/[id]`, `/api/jobs/[id]/takehome` | 60 | User-facing; must not block on synthesis |
| `/api/pdf/upload` | 30 | Presign only (tiny JSON) |
| `/api/pdf/upload/[id]` | 60 | Complete / poll; extraction is Worker or Vercel `after()` |
| `/api/tts/preview` | 30 | One short line |

Worker waves stop `TTS_WORKER_WAVE_BUDGET_MS` (default 240s) into a 300s limit so
there is room to persist progress before the platform kills the invocation.

## Always-on VM (Whole book)

Preferred host. Full runbook: [WORKER.md](WORKER.md).

1. Rent **4 vCPU / 8 GB RAM** (minimum 2 vCPU / 4 GB with
   `WORKER_CONCURRENCY=1`). x86_64.
2. On the VM: `cp env.worker.example .env.worker`, fill Turso / R2 / TTS /
   `WORKER_SECRET`, then `docker compose up -d --build`.
3. Confirm `curl -fsS http://127.0.0.1:8788/health` and `/ready`.
4. Put a public URL in Vercel `WORKER_URL` (TLS proxy on 443 recommended)
   and the same `WORKER_SECRET` (or reuse `INTERNAL_JOB_SECRET`).
5. The image installs debian `ffmpeg` and the rust `deep-filter` 0.5.6 musl
   binary (DeepFilterNet3, SHA-pinned — not Python+torch) and sets
   `WORKER=1` + `DEEP_FILTER_BIN`. Vercel never gets those binaries.
6. Extract stays on Cloudflare Workers — do not point `EXTRACT_WORKER_URL`
   at this VM.

Trigger.dev remains optional: keep `TRIGGER_SECRET_KEY` until the VM is
healthy, or set `TAKEHOME_TRIGGER_FALLBACK=1` during cutover. `npx trigger.dev
deploy` is no longer required for Whole book.

## Cloudflare Worker (document extract)

Parsing is not GPU work. Deploy `workers/extract` next to the R2 bucket so
users are not waiting on a Trigger machine cold start.

1. `cd workers/extract && npm install && npx wrangler login && npx wrangler deploy`
2. Worker secrets: `EXTRACT_WORKER_SECRET`, `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`. R2: bind `BOOKS` to `echomancer-audio` (already in
   `wrangler.toml`) or set `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
   `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME`.
3. On Vercel set `EXTRACT_WORKER_URL` to the Worker URL and the same
   `EXTRACT_WORKER_SECRET` (or reuse `INTERNAL_JOB_SECRET`).
4. Until those env vars are set, production complete extracts small
   documents in-request (≤ 8MB) and uses Next `after()` for larger files
   (GET re-nudges if `after()` does not run).

Stay on **`s2.1-pro-free`**. Fan-out is 4 (5 only when no Live Listen / Live
Stream is using the same Fish key). Playlist order is section index, never
completion order.

`TTS_POLL_NUDGE_BUDGET_MS=0` in production so Library polls do not 504 and do
not synthesize.

## Cron (Vercel fallback)

**Hobby note:** Vercel Hobby rejects any cron that runs more than once per day.
This repo ships **no** `crons` entry in `vercel.json`. Whole book does not
depend on Vercel cron.

Operator fallback:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-domain.com/api/cron/process-jobs
```

Concurrent drains are safe — every job is lease-claimed before any synthesis.

## Deploy to Vercel

```bash
npm i -g vercel
vercel login
vercel link
vercel env add SESSION_SECRET
vercel env add AUTH_GOOGLE_ID
vercel env add AUTH_GOOGLE_SECRET
vercel env add AUTH_URL
# AUTH_SECRET is optional — Auth.js reuses SESSION_SECRET when unset
vercel env add OPENROUTER_API_KEY
# …add the rest…
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard and set env vars there.
Production deploys from `main`.

## Database

The app migrates itself: `ensureTtsJobColumns()` runs on request paths and is
additive only. To pre-create the schema:

```bash
turso db shell <db-name> < migrate-turso.sql
```

`migrate-turso.sql` is safe to re-run against a live database — it contains no
`DROP`. New columns belong in the `JOB_COLUMNS` list in
`src/lib/tts/schema-migrate.ts`, not in the SQL file.

## Verify

1. Open `/` — “Sign in with Google” is in the header
2. Open `/dashboard/voice` — catalog loads
2. Preview a voice — short audio plays
3. Upload a small document → Try a chapter → stream plays
4. Whole book → job appears `queued`, section 0 plays after one Fish call, generation continues after the tab is closed
5. VM `docker compose logs takehome` shows the job accepted / settled
6. Open a job URL in a private window — it must 404, not render

## Troubleshooting

| Issue | Check |
|-------|--------|
| Uploads return 503 | `SESSION_SECRET` is not set |
| Library empty after deploy | Secret rotated → old sessions invalidated |
| Jobs sit at `queued` | `WORKER_URL` unreachable, VM down, or Turso/R2/TTS secrets missing on the VM |
| `GET /api/jobs` 504 | Nudge budget must be `0` in production so polls never synthesize |
| Audio 404s in the player | Session cookie missing, or object belongs to another session |
| Everything 429s | A costly limiter is failing closed — check Turso reachability |
| Empty / silent preview | Provider returned silence; see TDD §13 and the audio guard |
| Process 401 | `INTERNAL_JOB_SECRET` must match the `x-internal-secret` header |
| R2 upload fails | Bucket CORS + credentials |

## Docs

- `TECHNICAL_DESIGN.md` — architecture (update when you change behavior)
- `AGENTS.md` — agent / env quick reference
- `WORKER.md` — always-on Whole-book VM
- `TURSO_R2_SETUP.md` — Turso + R2 details
- `README.md` — product overview
