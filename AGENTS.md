# Echomancer v2 — Agent Guide

> PDF → audiobook with MOSS-TTS voice cloning on Modal.

## Stack

- **Frontend:** Next.js 16, React 19, TypeScript, Tailwind 4, shadcn/ui
- **API:** Vercel serverless (`src/app/api/`)
- **DB:** Turso (`src/lib/turso.ts`)
- **Storage:** Cloudflare R2 (`src/lib/storage.ts`)
- **TTS:** MOSS-TTS on Modal — variant selected by `MOSS_AB_VARIANT`

## TTS routing (`src/lib/tts-config.ts`)

| `MOSS_AB_VARIANT` | Modal app | Env URL |
|-------------------|-----------|---------|
| `sglang` (prod default) | `sglang_tts_server.py` | `MODAL_MOSS_SGLANG_TTS_URL` |
| `delay` (rollback) | `moss_tts_server.py` | `MODAL_MOSS_TTS_URL` |
| `local` (rollback) | `moss_local_tts_server.py` | `MODAL_MOSS_LOCAL_TTS_URL` |
| `api` (rollback) | `mosi_api_tts_server.py` | `MODAL_MOSS_API_TTS_URL` |

Unset / unknown / `openmoss` → `sglang`. Quantized OpenMOSS is not used for new jobs.

`MODAL_TTS_URL` — fallback for preview/warmup. Job trigger: `src/lib/trigger-generation.ts`.

## Modal deploy scripts

```powershell
.\deploy-sglang.ps1      # production default
.\deploy-moss-tts.ps1      # delay + local
.\deploy-mosi-api-tts.ps1  # hosted MOSI API
```

## Key paths

```
modal/
  sglang_tts_server.py    # SGLang-Omni MOSS (A100-80GB)
  moss_tts_server.py        # Delay-8B
  moss_local_tts_server.py  # Local-Transformer
  mosi_api_tts_server.py    # MOSI Studio proxy
  tts_shared.py             # R2, ffmpeg, webhooks
  emotion_instruct.py         # pacing hints
src/lib/
  tts-config.ts
  trigger-generation.ts
  modal-client.ts           # warmupModal() only
```

## Job flow

1. `POST /api/jobs` creates Turso job, uploads to R2
2. `triggerAudiobookGeneration()` → Modal `/generate_audiobook`
3. Modal workers synthesize, upload MP3, POST webhook
4. Frontend polls `GET /api/jobs/[id]` every 3s

## Vercel env (production)

```
MOSS_AB_VARIANT=sglang
MODAL_MOSS_SGLANG_TTS_URL=https://...--echomancer-sglang-tts-fastapi-app.modal.run/generate_batch
MODAL_TTS_URL=<same>
TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...
R2_* ...
WEBHOOK_SECRET=...
NEXT_PUBLIC_APP_URL=https://echomancer-v2.vercel.app
```

Rollback: `MOSS_AB_VARIANT=delay` + delay Modal URL.

## Docs

- `README.md` — overview
- `TURSO_R2_SETUP.md` — infra
- `MOSI_API_SETUP.md` — API + SGLang details
- `DEPLOYMENT.md` — Vercel deploy