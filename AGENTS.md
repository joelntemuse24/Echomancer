# Echomancer v2 — Agent Guide

> PDF → audiobook. **All voices via OpenRouter** — stock TTS APIs (Google / Gemini / Grok) + premium HD models (Minimax Speech-02 HD). No self-hosted TTS, no voice cloning.

## Product pricing

- **Target:** ~**€4.50** per typical take-home book (not a hard ceiling).
- **Dynamic pricing:** `src/lib/tts/pricing.ts` → `estimatePriceEur({ charCount, voice })`.
- Stream listen is capped (~1 hour audio) for cost control; take-home is a separate job.

## Generation paths

| Path | `generation_mode` | `job_kind` | Backend |
|------|-------------------|------------|---------|
| Live listen | `stock` | `stream` | Provider stream → `GET /api/jobs/[id]/stream` |
| Full download | `stock` | `takehome` | Section worker → R2 segments |

All voices come from OpenRouter. Premium HD models (Minimax etc.) are soft-gated.

## Stock providers (`src/lib/tts/`)

**Preferred: OpenRouter (one key, all speech models)**

| | |
|--|--|
| Env | `OPENROUTER_API_KEY` |
| Catalog | Live `GET openrouter.ai/api/v1/models?output_modalities=speech` → expand `supported_voices` |
| Synth | `POST openrouter.ai/api/v1/audio/speech` (OpenAI-compatible stream) |
| Code | `providers/openrouter.ts`, `catalog/openrouter-catalog.ts` |

Direct fallbacks (optional): google / gemini / grok with their own keys.

Catalog API: `GET /api/tts/voices` · `source: "openrouter" | "static"`

## Premium HD voice gate

```
PREMIUM_HD_ENABLED=true   # or
PREMIUM_HD_ALLOWLIST=ip,userId
```

When off: HD voices are hidden in the UI. All voices still use the stock pipeline.

## Job flow (stock take-home)

1. `POST /api/jobs` `{ mode: "stock", jobKind: "takehome", catalogVoiceId, pdfStoragePath }`
2. `POST /api/jobs/[id]/process` (internal secret) synthesizes next K sections
3. Self-chains until `ready`; segments in `segments_json`
4. Frontend polls; can play ready sections early

## Job flow (stock stream)

1. `POST /api/jobs` `{ mode: "stock", jobKind: "stream", catalogVoiceId, ... }`
2. Player opens `GET /api/jobs/[id]/stream` — pipes provider audio
3. Cap via `STREAM_MAX_AUDIO_SECONDS` / char budget
4. Optional `POST /api/jobs/[id]/takehome` for full offline copy

## Key paths

```
src/lib/tts/
  types.ts, pricing.ts, premium.ts, split-text.ts
  catalog/voices.json
  providers/{google,grok,gemini}.ts
  process-job.ts, stream-session.ts, schema-migrate.ts
src/app/api/tts/voices/
src/app/api/jobs/[id]/{stream,process,takehome}/
src/app/dashboard/voice/          # Browse / HD Premium
```

## Env (stock + pricing)

```
OPENROUTER_API_KEY=...
GOOGLE_TTS_API_KEY=...
GEMINI_API_KEY=...
XAI_API_KEY=...
PREMIUM_HD_ENABLED=false
INTERNAL_JOB_SECRET=...
STREAM_MAX_AUDIO_SECONDS=3600
TTS_PRICE_MARKUP=2.0
TTS_PRICE_FIXED_EUR=0.5
TTS_USD_TO_EUR=0.92
```

Plus existing Turso / R2 vars.

## Docs

- `README.md` — overview
- `TURSO_R2_SETUP.md` — infra
- `DEPLOYMENT.md` — Vercel
