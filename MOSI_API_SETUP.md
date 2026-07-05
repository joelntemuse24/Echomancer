# MOSI Studio API Setup (hosted MOSS-TTS)

Switches Echomancer from self-hosted MOSS-TTS Delay-8B GPU workers on Modal to
the **official hosted API** for the same MOSS-TTS model family, run by the
model's creators (MOSI.AI / OpenMOSS) at https://studio.mosi.cn.

The Modal app `modal/mosi_api_tts_server.py` stays as a thin CPU-only
orchestrator (PDF extraction, voice clipping/cleaning, R2 uploads, webhooks) —
all synthesis is delegated to the MOSI API. No GPUs, no model cold starts.

## MOSI API endpoints used

| Purpose | Endpoint |
|---|---|
| Upload reference audio | `POST /api/v1/files/upload` (multipart) |
| Register voice clone | `POST /api/v1/voice/clone` → `voice_id` |
| Poll clone status | `GET /api/v1/voices` (wait for `ACTIVE`) |
| Synthesize | `POST /api/v1/audio/speech` (`model: moss-tts`, base64 24 kHz WAV) |

Auth: `Authorization: Bearer <MOSI_TTS_API_KEY>`.

## Setup

1. **Get an API key**: https://studio.mosi.cn → register/login → console → API keys → create.
2. **Add it to the Modal secret** used by the app:
   ```bash
   modal secret create echomancer-secrets MOSI_TTS_API_KEY=sk-... # or add to existing secret in the Modal dashboard
   ```
3. **Deploy the Modal app**:
   ```bash
   cd modal && modal deploy mosi_api_tts_server.py
   # or: .\deploy-mosi-api-tts.ps1
   ```
4. **Set Vercel env vars**:
   ```bash
   TTS_PIPELINE_MODE=moss
   MOSS_AB_VARIANT=api
   MODAL_MOSS_API_TTS_URL=https://<user>--echomancer-mosi-api-tts-fastapi-app.modal.run/generate_batch
   MODAL_TTS_URL=<same URL>   # voice preview + warmup
   ```
5. Verify: `curl https://<user>--echomancer-mosi-api-tts-fastapi-app.modal.run/health`
   — check `"api_key_configured": true`.

## Tuning (Modal env vars)

| Var | Default | Notes |
|---|---|---|
| `MOSI_API_BASE_URL` | `https://studio.mosi.cn` | |
| `MOSI_API_CONCURRENCY` | `2` | Parallel speech requests; raise carefully (rate limits) |
| `MOSI_BATCH_CHARS` | `1000` | Text per request; auto-splits on "text too long" (code 5004) |
| `MOSI_MAX_NEW_TOKENS` | `4096` | |
| `MOSI_TEMPERATURE` | `1.5` | English default (MOSI recommends 1.7 for Chinese) |

Error handling: rate limits (HTTP 429 / code 4029) retry with exponential
backoff; over-long text (code 5004) is split in half and re-synthesized.

## Alternative: SGLang-Omni (self-hosted, faster GPU serving)

`modal/sglang_tts_server.py` serves the same MOSS-TTS-v1.5 model through
[SGLang-Omni](https://github.com/sgl-project/sglang-omni) (continuous batching,
RadixAttention, CUDA graphs) — typically faster and cheaper per audiobook than
the raw transformers loop, with no external API dependency.

```bash
cd modal && modal deploy sglang_tts_server.py
```

Vercel env:
```bash
TTS_PIPELINE_MODE=moss
MOSS_AB_VARIANT=sglang
MODAL_MOSS_SGLANG_TTS_URL=https://<user>--echomancer-sglang-tts-fastapi-app.modal.run/generate_batch
MODAL_TTS_URL=<same URL>
```

Tuning: `SGLANG_MAX_WORKERS` (default 2 GPU containers), `SGLANG_BATCH_CHARS`
(default 2000).

## Rollback

Set `MOSS_AB_VARIANT=delay` (or `local`) to route back to the self-hosted
GPU apps (`modal/moss_tts_server.py`, `modal/moss_local_tts_server.py`).
