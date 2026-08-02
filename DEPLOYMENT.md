# Echomancer Deployment Guide

Documents → audiobook on **Vercel** + **Turso** + **Cloudflare R2**. All TTS goes through **OpenRouter**.

## Architecture

```
Browser → Vercel (Next.js)
            ├── Turso (jobs, uploads, usage, rate limits)
            ├── R2 (uploaded text + audio sections + full book)
            └── OpenRouter (speech synthesis)
```

| Path | Flow |
|------|------|
| Try a chapter | `POST /api/jobs` → player → `GET /api/jobs/[id]/stream` |
| Get the whole book | `POST /api/jobs` (enqueue only) → cron drain or `POST /api/jobs/[id]/process` → sections on R2 → `full.*` |

Job creation never synthesizes. The worker is `GET /api/cron/process-jobs`,
scheduled in `vercel.json`, with `POST /api/jobs/[id]/process` available to
advance a single job.

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
MAX_UPLOAD_MB=25
NEXT_PUBLIC_MAX_UPLOAD_MB=25

# Workers
TTS_SECTIONS_PER_TICK=6
TTS_WORKER_WAVE_BUDGET_MS=240000
TTS_CRON_JOBS_PER_RUN=3
TTS_LEASE_TTL_SECONDS=90
TTS_POLL_NUDGE_BUDGET_MS=55000   # 0 once cron runs frequently

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
| `/api/pdf/upload` | 120 | Text extraction on a large document |
| `/api/tts/preview` | 30 | One short line |

Worker waves stop `TTS_WORKER_WAVE_BUDGET_MS` (default 240s) into a 300s limit so
there is room to persist progress before the platform kills the invocation.

## Cron

**Hobby note:** Vercel Hobby rejects any cron that runs more than once per day,
and even a daily cron has been observed to fail the whole deploy before logs
appear. This repo therefore ships **no** `crons` entry in `vercel.json` so
deploys succeed on Hobby.

Job progress still works via `TTS_POLL_NUDGE_BUDGET_MS` (default `55000`): while
the library/player page is open, polls advance queued jobs in short slices.

To run the worker without a browser open, hit it yourself (or from any external
scheduler):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-domain.com/api/cron/process-jobs
```

On **Pro**, you can add a native cron back:

```json
{ "crons": [{ "path": "/api/cron/process-jobs", "schedule": "* * * * *" }] }
```

…and set `TTS_POLL_NUDGE_BUDGET_MS=0` so polls become pure reads.

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
4. Whole book → job appears `queued`, then progresses without you refreshing
5. `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/process-jobs` → `{"ok":true,"picked":n}`
6. Open a job URL in a private window — it must 404, not render

## Troubleshooting

| Issue | Check |
|-------|--------|
| Uploads return 503 | `SESSION_SECRET` is not set |
| Library empty after deploy | Secret rotated → old sessions invalidated |
| Jobs sit at `queued` | Cron not firing (plan limits) or `CRON_SECRET` mismatch; check `TTS_POLL_NUDGE_BUDGET_MS` (needs ≥~30s for Fish; default `55000`) |
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
