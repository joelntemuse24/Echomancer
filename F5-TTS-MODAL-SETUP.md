# F5-TTS on Modal - Setup Guide

This guide explains how to deploy F5-TTS to Modal.com for audiobook generation in Echomancer.

## Overview

**F5-TTS** is a fast, high-quality text-to-speech model using flow-matching. It's optimized for:
- Fast generation (RTF ~0.15-0.2 on A10G)
- Consistent voice cloning with a single reference
- 24kHz output quality

## Deployment Steps

### 1. Install Modal CLI

```bash
pip install modal
```

### 2. Authenticate with Modal

```bash
modal token new
```

This will open a browser to authenticate with your Modal account (ntemusejoel@gmail.com).

### 3. Deploy the Servers

**Windows:**
```powershell
.\deploy-f5-tts.ps1
```

**Linux/Mac:**
```bash
chmod +x deploy-f5-tts.sh
./deploy-f5-tts.sh
```

Or manually:
```bash
cd modal
modal deploy f5_tts_server.py
modal deploy audio_cleaner.py
```

The first deployment will take **10-15 minutes** as it:
- Downloads F5-TTS model weights (~2GB)
- Installs dependencies
- Runs torch.compile warmup
- Caches compiled kernels to persistent volume

### 4. Get Deployment URLs

After deployment, get your URLs:

```bash
modal app list
```

Or check: https://modal.com/apps

### 5. Update Environment

Edit `.env.local`:

```bash
# F5-TTS on Modal
MODAL_TTS_URL=https://yourname--echomancer-f5-tts-fastapi-app.modal.run/generate_batch
MODAL_AUDIO_CLEANER_URL=https://yourname--echomancer-audio-cleaner-fastapi-app.modal.run/clean

# Optional: Keep these for fallback
REPLICATE_API_TOKEN=your_token_here
```

### 6. Test the Deployment

```bash
# Health check
curl https://yourname--echomancer-f5-tts-fastapi-app.modal.run/health

# Single generation test
curl -X POST https://yourname--echomancer-f5-tts-fastapi-app.modal.run/generate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, this is a test of the F5-TTS system.",
    "reference_audio_base64": "'$(base64 -w 0 sample.wav)'"
  }'

# Batch generation test
curl -X POST https://yourname--echomancer-f5-tts-fastapi-app.modal.run/generate_batch \
  -H "Content-Type: application/json" \
  -d '{
    "texts": ["First sentence.", "Second sentence.", "Third sentence."],
    "reference_audio_base64": "'$(base64 -w 0 sample.wav)'",
    "nfe_step": 32
  }'
```

## Configuration

### GPU Options

Edit `modal/f5_tts_server.py` and change `GPU_CONFIG`:

| GPU | Speed | Cost/hr | Best For |
|-----|-------|---------|----------|
| `L4` | Baseline | $0.50 | Development, testing |
| `A10G` | 1.5× faster | $0.60 | **Production (recommended)** |
| `A100` | 3× faster | $1.50 | High volume, speed priority |

### Quality vs Speed

Edit `F5_TTS_CONFIG` in `src/lib/generate-audiobook-f5-modal.ts`:

```typescript
const F5_TTS_CONFIG = {
  NFE_STEP: 32,      // 16 = fast, 32 = balanced, 64 = best quality
  CFG_STRENGTH: 2.0, // 1.5-2.5 range
  SPEED: 1.0,        // 0.8 = slower/natural, 1.0 = normal, 1.2 = faster
  BATCH_SIZE: 8,     // 4-16 range
};
```

### Cold Start Optimization

The server is already optimized for fast cold starts:
- `container_idle_timeout=300` (5 min) - keeps container warm
- Model weights cached on persistent volume
- torch.compile kernels cached
- Warmup generation on startup

**First request after idle:** ~30-60s (cold start)
**Subsequent requests:** ~2-5s per batch

## Architecture

```
Echomancer App
     │
     ├──► F5-TTS Modal Server (GPU)
     │     - Batch generation
     │     - Shared reference audio
     │     - 24kHz output
     │
     └──► Audio Cleaner Modal Server (T4)
           - Vocal isolation (Demucs)
           - Silence trimming
           - Loudness normalization
```

## Key Features

### 1. Batch Processing
All text sections in a batch share the same reference audio decode:
- Consistent voice across all sections
- Faster processing (no redundant decoding)
- Better GPU utilization

### 2. Checkpoint System
- Resume from partial failures
- No lost progress
- Automatic checkpoint uploads

### 3. Voice Consistency
- Single reference audio for entire audiobook
- Proper audio format (24kHz mono)
- No voice drift between sections

### 4. Audio Concatenation
- 50ms crossfade between sections (not 150ms)
- Prevents jarring transitions
- Preserves speech naturalness

## Cost Estimates

| Metric | Value |
|--------|-------|
| A10G GPU | ~$0.60/hr |
| Cold start | ~$0.01 (1 min compile) |
| 1000 char book | ~$0.02-0.03 |
| 10,000 char book | ~$0.20-0.30 |
| 50,000 char book | ~$1.00-1.50 |

## Troubleshooting

### "Modal not found"
```bash
pip install modal
modal token new
```

### "GPU out of memory"
- Reduce `BATCH_SIZE` to 4
- Use L4 GPU instead of A10G
- Check no other apps running on GPU

### "Cold start too slow"
- This is normal for first deployment
- Subsequent cold starts use cached kernels (~30s)
- Consider `scaledown_window` > 300 for always-warm

### "Voice quality inconsistent"
- Ensure voice sample is 5-15 seconds
- Use clean audio (no background music)
- Check `MODAL_AUDIO_CLEANER_URL` is set

### "Generation too slow"
- Reduce `NFE_STEP` to 16
- Use A10G or A100 GPU
- Increase `BATCH_SIZE`

## Monitoring

Check Modal dashboard for:
- GPU utilization
- Request latency
- Error rates
- Cost tracking

```bash
# View logs
modal app logs echomancer-f5-tts

# Stop app
modal app stop echomancer-f5-tts
```

## Migration from Smallest AI/MiniMax

The new system uses F5-TTS on Modal instead of external APIs:

| Before | After |
|--------|-------|
| MiniMax voice cloning | F5-TTS zero-shot cloning |
| Smallest AI TTS | F5-TTS generation |
| External API calls | Modal GPU inference |
| ~$0.07/book | ~$0.02-0.03/book |
| 44.1kHz output | 24kHz output (still high quality) |

## Support

- Modal docs: https://modal.com/docs
- F5-TTS repo: https://github.com/SWivid/F5-TTS
- Issues: Check `modal/f5_tts_server.py` logs
