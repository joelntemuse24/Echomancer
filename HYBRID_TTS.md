# Hybrid TTS Pipeline (Qwen Reader + MeanVC)

Production-quality audiobook generation using a two-stage pipeline:

1. **Qwen3-TTS CustomVoice** (L4) — instruct-driven prosody with preset speaker `Ryan`
2. **MeanVC** (T4) — zero-shot timbre transfer to the user's reference voice
3. **F5-TTS** (A10G) — per-paragraph fallback if MeanVC fails after one retry

## Architecture

```
User voice clip (Demucs-cleaned)
  └─ per paragraph:
       Qwen CustomVoice + instruct → reader.wav (24 kHz)
       MeanVC(source=reader, target=user ref) → final.wav
       [fallback] F5-TTS if MeanVC fails
  └─ concat → ffmpeg post-process → R2 → webhook
```

Modal app: `echomancer-hybrid-tts` (`modal/hybrid_tts_server.py`)

## Deploy

```bash
cd modal
modal deploy hybrid_tts_server.py
```

First deploy downloads:
- Qwen3-TTS-12Hz-1.7B-CustomVoice (HF cache volume)
- MeanVC checkpoints via `download_ckpt.py`
- WavLM speaker-verification weights (Google Drive via gdown)

Secrets (same as F5):
- `echomancer-secrets` — R2, webhook, `AUDIO_CLEANER_URL`
- `echomancer-f5-tts` — F5 fallback only

## Vercel environment

```bash
# Enable hybrid pipeline for new jobs
TTS_PIPELINE_MODE=hybrid

# Hybrid Modal FastAPI URL (from deploy output)
MODAL_HYBRID_TTS_URL=https://<user>--echomancer-hybrid-tts-fastapi-app.modal.run/generate_batch

# Optional tuning
QWEN_TTS_SPEAKER=Ryan
QWEN_TTS_LANGUAGE=English
```

Keep `MODAL_TTS_URL` pointed at the existing F5 app for rollback (`TTS_PIPELINE_MODE=f5`).

## API

`POST /generate_audiobook` — same contract as F5, plus optional fields:

| Field | Default | Description |
|-------|---------|-------------|
| `pipeline_mode` | `hybrid` | `hybrid` or `f5` (ignored by hybrid server) |
| `qwen_speaker` | `Ryan` | CustomVoice preset |
| `qwen_language` | `English` | Target language |

`POST /generate_batch` — voice preview through the same Qwen → MeanVC chain.

## A/B testing

1. Deploy hybrid Modal app
2. Set `TTS_PIPELINE_MODE=f5` (control) — generate one audiobook
3. Set `TTS_PIPELINE_MODE=hybrid` — same PDF/voice clip
4. Compare timbre match, pacing, and artifact rate

## Files

| File | Role |
|------|------|
| `modal/hybrid_tts_server.py` | Modal app, orchestrator, FastAPI |
| `modal/emotion_instruct.py` | Paragraph → Qwen `instruct` strings |
| `modal/meanvc_wrapper.py` | MeanVC inference wrapper |
| `modal/tts_shared.py` | R2/ffmpeg/text helpers |
| `src/lib/trigger-generation.ts` | Pipeline mode routing |