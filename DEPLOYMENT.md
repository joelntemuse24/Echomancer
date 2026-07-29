# Echomancer Deployment Guide

PDF → audiobook on **Vercel** + **Turso** + **Cloudflare R2**. All TTS goes through **OpenRouter**.

## Architecture

```
Browser → Vercel (Next.js)
            ├── Turso (jobs, segments metadata)
            ├── R2 (PDFs + audio segments)
            └── OpenRouter (speech synthesis)
```

| Path | Flow |
|------|------|
| Try a chapter | `POST /api/jobs` → player → `GET /api/jobs/[id]/stream` |
| Get the whole book | `POST /api/jobs` → `POST /api/jobs/[id]/process` (self-chains) → segments on R2 |

## Prerequisites

1. Vercel account
2. Turso database (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`)
3. Cloudflare R2 bucket + API tokens
4. OpenRouter API key with speech model access

## Environment variables

### Required

```bash
OPENROUTER_API_KEY=...
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
INTERNAL_JOB_SECRET=...          # Protects /api/jobs/[id]/process
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=echomancer-audio
NEXT_PUBLIC_APP_URL=https://your-domain.com
```

### Optional

```bash
# Direct provider fallbacks (OpenRouter is primary)
GOOGLE_TTS_API_KEY=...
GEMINI_API_KEY=...
XAI_API_KEY=...

# Premium HD gate
PREMIUM_HD_ENABLED=false
PREMIUM_HD_ALLOWLIST=

# Job / stream / pricing
TTS_SECTIONS_PER_TICK=3
STREAM_MAX_AUDIO_SECONDS=3600
TTS_PRICE_MARKUP=2.0
TTS_PRICE_FIXED_EUR=0.5
TTS_USD_TO_EUR=0.92
TTS_MIN_PRICE_EUR=1.0

# Storage (local only when R2 unset)
STORAGE_PATH=./data/storage
R2_PUBLIC_URL=...
```

See `AGENTS.md` and `TECHNICAL_DESIGN.md` for the full map.

## Deploy to Vercel

```bash
npm i -g vercel
vercel login
vercel link
vercel env add OPENROUTER_API_KEY
# …add the rest…
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard and set env vars there. Production deploys from `main`.

## Database

Apply `migrate-turso.sql` (or rely on `ensureTtsJobColumns()` / schema migrate at runtime):

```bash
turso db shell <db-name> < migrate-turso.sql
```

## Verify

1. Open `/dashboard/voice` — catalog loads
2. Preview a voice — short audio plays
3. Upload a small PDF → Try a chapter → stream plays
4. Get the whole book → job progresses → Library / Player

## Troubleshooting

| Issue | Check |
|-------|--------|
| Empty / silent preview | OpenRouter + Gemini empty-PCM guard; see TDD §5.3 |
| Catalog empty / Kokoro-era UI | Wrong Production deployment — promote latest `main` |
| Process 401 | `INTERNAL_JOB_SECRET` must match |
| R2 upload fails | Bucket CORS + credentials |
| Turso errors | URL/token + schema migration |

## Docs

- `TECHNICAL_DESIGN.md` — architecture (update when you change behavior)
- `AGENTS.md` — agent / env quick reference
- `TURSO_R2_SETUP.md` — Turso + R2 details
- `README.md` — product overview
