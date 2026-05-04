# F5-TTS Modal Deployment Summary

## What Was Created

### 1. Modal Servers (`modal/`)

#### `f5_tts_server.py`
- **F5-TTS server** optimized for audiobook generation
- **GPU**: A10G (configurable: L4, A10G, A100)
- **Features**:
  - Batch generation with shared reference audio (ensures voice consistency)
  - torch.compile with persistent cache for fast warm starts
  - 24kHz output optimized for voice cloning
  - Health check endpoint
  - FastAPI ASGI interface

#### `audio_cleaner.py`
- **Audio preprocessing server** for voice samples
- **GPU**: T4 (cheaper, sufficient for Demucs)
- **Features**:
  - Demucs vocal isolation
  - Silence trimming
  - Loudness normalization
  - 24kHz output

### 2. Deployment Scripts

#### `deploy-f5-tts.ps1` (Windows)
```powershell
.\deploy-f5-tts.ps1
```

#### `deploy-f5-tts.sh` (Mac/Linux)
```bash
./deploy-f5-tts.sh
```

### 3. Updated Application Code

#### `src/lib/generate-audiobook-f5-modal.ts`
- New audiobook generator using F5-TTS on Modal
- Batch processing with configurable batch size
- Checkpoint-based resume capability
- 50ms crossfade for smooth concatenation
- Minimal post-processing (preserves 24kHz quality)

#### `src/lib/env.ts`
- Added `MODAL_TTS_URL` and `MODAL_AUDIO_CLEANER_URL` environment variables

#### `src/app/api/jobs/route.ts`
- Updated to use `generateAudiobookF5Modal`

#### `src/app/api/jobs/[id]/route.ts`
- Updated retry endpoint to use F5-TTS

### 4. Documentation

#### `F5-TTS-MODAL-SETUP.md`
- Complete setup guide
- Configuration options
- Troubleshooting
- Cost estimates

#### `test-f5-modal.py`
- Test script for deployment verification

## Deployment Steps

### Step 1: Install Modal CLI
```bash
pip install modal
```

### Step 2: Authenticate
```bash
modal token new
# Login with: ntemusejoel@gmail.com
```

### Step 3: Deploy
```bash
# Windows
.\deploy-f5-tts.ps1

# Mac/Linux
./deploy-f5-tts.sh
```

**First deployment takes 10-15 minutes** (model download + torch.compile warmup)

### Step 4: Get URLs
```bash
modal app list
```

### Step 5: Update `.env.local`
```bash
MODAL_TTS_URL=https://yourname--echomancer-f5-tts-fastapi-app.modal.run/generate_batch
MODAL_AUDIO_CLEANER_URL=https://yourname--echomancer-audio-cleaner-fastapi-app.modal.run/clean
```

### Step 6: Test
```bash
# Set environment variable first
$env:MODAL_TTS_URL="your-url-here"

# Run test
python test-f5-modal.py
```

## Key Optimizations

### 1. Fast Cold Start
- `container_idle_timeout=300` (5 min warm)
- Model weights cached on persistent volume
- torch.compile kernels cached
- Warmup generation on startup

**Cold start times:**
- First deployment ever: ~10-15 min
- Subsequent cold starts: ~30-60s (cached kernels)
- Warm container: ~2-5s per batch

### 2. Voice Consistency
- Single reference audio decoded ONCE per batch
- All sections use same voice embedding
- 24kHz mono output throughout pipeline
- No voice drift between sections

### 3. Speed
- Batch processing (8 sections at a time)
- A10G GPU (~1.5× faster than L4)
- NFE_STEP=32 (quality/speed balance)
- Expected: ~2-5 seconds per section

### 4. Quality
- F5-TTS native 24kHz (no downsampling)
- Gentle loudnorm only (no destructive EQ)
- 50ms crossfade (not 150ms)
- No lowpass filtering

## Configuration

### GPU Selection
Edit `modal/f5_tts_server.py`:
```python
GPU_CONFIG = "A10G"  # Options: "L4", "A10G", "A100"
```

### Quality vs Speed
Edit `src/lib/generate-audiobook-f5-modal.ts`:
```typescript
const F5_TTS_CONFIG = {
  NFE_STEP: 32,      // 16=fast, 32=balanced, 64=best
  CFG_STRENGTH: 2.0, // 1.5-2.5 range
  SPEED: 1.0,        // 0.8=slower, 1.0=normal, 1.2=faster
  BATCH_SIZE: 8,     // 4-16 range
};
```

## Cost Estimates (A10G GPU)

| Book Size | Sections | Time | Cost |
|-----------|----------|------|------|
| Short (1k chars) | ~5 | ~30s | ~$0.005 |
| Medium (10k chars) | ~15 | ~2 min | ~$0.02 |
| Long (50k chars) | ~70 | ~8 min | ~$0.08 |
| Novel (100k chars) | ~140 | ~15 min | ~$0.15 |

## Troubleshooting

### "Modal not found"
```bash
pip install modal
modal token new
```

### "GPU out of memory"
- Reduce `BATCH_SIZE` to 4
- Use L4 GPU instead of A10G

### "Cold start too slow"
- Normal for first deployment
- Subsequent starts use cached kernels
- Can increase `container_idle_timeout` to keep warm longer

### "Voice quality inconsistent"
- Ensure voice sample is 5-15 seconds
- Use clean audio (no background music)
- Check audio is being clipped correctly (startTime/endTime)

## Files Changed

```
new file:   modal/f5_tts_server.py
new file:   modal/audio_cleaner.py
new file:   deploy-f5-tts.ps1
new file:   deploy-f5-tts.sh
new file:   src/lib/generate-audiobook-f5-modal.ts
new file:   test-f5-modal.py
new file:   F5-TTS-MODAL-SETUP.md
new file:   F5-TTS-DEPLOYMENT-SUMMARY.md

modified:   src/lib/env.ts
modified:   src/app/api/jobs/route.ts
modified:   src/app/api/jobs/[id]/route.ts
modified:   .env.local
modified:   AGENTS.md
```

## Next Steps

1. Run deployment script
2. Get Modal URLs
3. Update `.env.local`
4. Test with `python test-f5-modal.py`
5. Create a test audiobook through the UI

## Monitoring

```bash
# View logs
modal app logs echomancer-f5-tts

# Check status
modal app list

# Stop app
modal app stop echomancer-f5-tts
```

## Support

- Modal docs: https://modal.com/docs
- F5-TTS repo: https://github.com/SWivid/F5-TTS
- Check logs: `modal app logs echomancer-f5-tts`
