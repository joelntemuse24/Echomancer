# Echomancer Deployment Guide

Documents → audiobook on **Vercel** + **Turso** + **Cloudflare R2**. All TTS goes through **OpenRouter**.

## Architecture

```
Browser → Vercel (Next.js)
            ├── Turso (jobs, uploads, usage, rate limits)
            ├── R2 (uploaded text + audio sections + full book)
            ├── Fish Audio (Live Listen / Live Stream)
            └── Trigger.dev Cloud (Whole book)
                    ├── same Turso + R2 + FISH_API_KEY
                    └── takehome.advance → runTakehomeUntilSettled
```

| Path | Flow |
|------|------|
| Live Listen | Vercel `GET/POST /api/tts/live` → Fish HTTP chunked |
| Live Stream | `POST /api/jobs` → player → `GET /api/jobs/[id]/stream` (Vercel) |
| Whole book | `POST /api/jobs` (enqueue + `tasks.trigger`) → Trigger `takehome.advance` → sections on R2 → `full.*` |

Job creation never synthesizes. Trigger.dev is the durable worker. Vercel
`/api/cron/process-jobs` and `/api/jobs/[id]/process` remain operator fallbacks.

## Prerequisites

1. Vercel account
2. Turso database (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`)
3. Cloudflare R2 bucket + API tokens
4. OpenRouter API key with speech model access

## Environment variables

### Required

```bash
SESSION_SECRET=...               # Signs session cookies — see "Sessions" below
INTERNAL_JOB_SECRET=...          # Protects /api/jobs/[id]/process
CRON_SECRET=...                  # Protects /api/cron/process-jobs
OPENROUTER_API_KEY=...
FISH_API_KEY=...                 # Clones, Live Listen, direct Fish take-home
TRIGGER_SECRET_KEY=...           # Dispatch Whole book to Trigger.dev
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
# Direct provider fallbacks (OpenRouter is primary)
GOOGLE_TTS_API_KEY=...
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

# Trigger.dev (Whole book)
TRIGGER_SECRET_KEY=tr_...         # Same key on Vercel and in the Trigger dashboard
TRIGGER_PROJECT_ID=proj_...       # Project ref from Trigger → Settings

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

Echomancer has no login, but every job, upload and audio object belongs to a
signed anonymous session so one visitor cannot read or delete another's book.
`SESSION_SECRET` (falling back to `INTERNAL_JOB_SECRET`) signs those cookies.

**Production refuses to sign sessions without a secret** — uploads return 503 and
owned routes return 401 — rather than inventing a per-instance key, which would
give each serverless instance a different notion of identity and lose people
their libraries at random.

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
| `/api/pdf/upload/[id]` | 60 | Complete / poll; extraction is Trigger |
| `/api/tts/preview` | 30 | One short line |

Worker waves stop `TTS_WORKER_WAVE_BUDGET_MS` (default 240s) into a 300s limit so
there is room to persist progress before the platform kills the invocation.

## Trigger.dev (Whole book)

1. Create a project at [cloud.trigger.dev](https://cloud.trigger.dev).
2. Put the project ref in `TRIGGER_PROJECT_ID` / `trigger.config.ts`.
3. Set `TRIGGER_SECRET_KEY` on **Vercel** and in the Trigger dashboard.
4. In Trigger, also set `FISH_API_KEY`, `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, R2 credentials, and `INTERNAL_JOB_SECRET`.
   Extraction (`upload.extract`) needs Turso + R2, not Fish.
5. Deploy tasks: `npx trigger.dev@latest deploy` (or `npm run trigger:deploy`).
   Indexing needs `@libsql/linux-x64-gnu` in the worker image —
   `trigger.config.ts` marks `@libsql/client` / `libsql` as `build.external`
   and installs the native binary with `additionalPackages`.
   Whole-book mastering adds debian `ffmpeg` and the rust `deep-filter`
   0.5.6 musl binary (DeepFilterNet3, ~36MB — not Python+torch) to this
   image only. Vercel never gets those binaries.
6. Confirm `takehome.drain` and `upload.drain` are synced on a one-minute schedule.

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

1. Open `/dashboard/voice` — catalog loads
2. Preview a voice — short audio plays
3. Upload a small document → Try a chapter → stream plays
4. Whole book → job appears `queued`, section 0 plays after one Fish call, generation continues after the tab is closed
5. Trigger dashboard shows `takehome.advance` runs; `takehome.drain` every minute
6. Open a job URL in a private window — it must 404, not render

## Troubleshooting

| Issue | Check |
|-------|--------|
| Uploads return 503 | `SESSION_SECRET` is not set |
| Library empty after deploy | Secret rotated → old sessions invalidated |
| Jobs sit at `queued` | `TRIGGER_SECRET_KEY` missing on Vercel, or Trigger deploy/secrets missing (`FISH_API_KEY`, Turso, R2) |
| `GET /api/jobs` 504 | Nudge budget must be `0` in production so polls never synthesize |
| Audio 404s in the player | Session cookie missing, or object belongs to another session |
| Everything 429s | A costly limiter is failing closed — check Turso reachability |
| Empty / silent preview | Provider returned silence; see TDD §13 and the audio guard |
| Process 401 | `INTERNAL_JOB_SECRET` must match the `x-internal-secret` header |
| R2 upload fails | Bucket CORS + credentials |

## Docs

- `TECHNICAL_DESIGN.md` — architecture (update when you change behavior)
- `AGENTS.md` — agent / env quick reference
- `TURSO_R2_SETUP.md` — Turso + R2 details
- `README.md` — product overview
