# Echomancer v2 — Agent Guide

> PDF → audiobook. **Default:** cheap high-quality stock TTS APIs (Google / Gemini 2.5 / Grok). **Premium:** MOSS custom voice clone on Modal.

## Product pricing

- **Target:** ~**€4.50** per typical take-home book (not a hard ceiling).
- **Dynamic pricing:** `src/lib/tts/pricing.ts` → `estimatePriceEur({ charCount, voice })`.
- Stream listen is capped (~1 hour audio) for cost control; take-home is a separate job.

## Dual generation paths

| Path | `generation_mode` | `job_kind` | Backend |
|------|-------------------|------------|---------|
| Live listen | `stock` | `stream` | Provider stream → `GET /api/jobs/[id]/stream` |
| Full download | `stock` | `takehome` | Section worker → R2 segments |
| Custom clone | `clone` | `clone` | Modal MOSS GPU (premium soft-gate) |

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

## Premium clone gate

```
PREMIUM_CLONE_ENABLED=true   # or
PREMIUM_CLONE_ALLOWLIST=ip,userId
```

When off: clone upload + clone jobs return **403**. Stock path always available.

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

## Job flow (clone / premium)

Unchanged Modal path: `triggerAudiobookGeneration` → `/generate_audiobook` · webhooks.

## Key paths

```
src/lib/tts/
  types.ts, pricing.ts, premium.ts, split-text.ts
  catalog/voices.json
  providers/{google,grok,gemini}.ts
  process-job.ts, stream-session.ts, schema-migrate.ts
src/app/api/tts/voices/
src/app/api/jobs/[id]/{stream,process,takehome}/
src/app/dashboard/voice/          # Browse / Saved / Clone
```

## Env (stock + pricing)

```
GOOGLE_TTS_API_KEY=...
GEMINI_API_KEY=...
XAI_API_KEY=...
PREMIUM_CLONE_ENABLED=false
INTERNAL_JOB_SECRET=...
STREAM_MAX_AUDIO_SECONDS=3600
TTS_PRICE_MARKUP=2.0
TTS_PRICE_FIXED_EUR=0.5
TTS_USD_TO_EUR=0.92
```

Plus existing Turso / R2 / Modal MOSS vars for clone.

## Docs

- `README.md` — overview
- `TURSO_R2_SETUP.md` — infra
- `MOSI_API_SETUP.md` — MOSS / Modal
- `DEPLOYMENT.md` — Vercel
