# Model Download Notes

## Local Download (Optional)

The local model download failed due to Windows resource limits with the HuggingFace downloader. **This is NOT a problem** - the models will be downloaded automatically during Modal deployment.

## Recommended Workflow

### Option 1: Let Modal Handle It (Recommended)

Modal's Linux environment handles large model downloads much better than Windows. The models will be:

1. Downloaded during the `modal deploy` build phase
2. Cached to a persistent volume
3. Reused across container restarts

**Just deploy directly:**
```powershell
# Windows
.\deploy-f5-tts.ps1

# Or manually
cd modal
modal deploy f5_tts_server.py
modal deploy audio_cleaner.py
```

### Option 2: Use Git LFS (If you really want local copies)

```bash
# Install git-lfs
git lfs install

# Clone F5-TTS repo with models
git clone https://huggingface.co/SWivid/F5-TTS model_cache/f5-tts-model

# Clone vocoder
git clone https://huggingface.co/charactr/vocos-mel-24khz model_cache/vocoder
```

### Option 3: Manual Download via Browser

Download directly from HuggingFace:

1. **F5-TTS Base Model**: https://huggingface.co/SWivid/F5-TTS/tree/main/F5TTS_Base
   - Download: `model_1200000.pt` (~1.3 GB)
   - Download: `vocab.txt` (~2 KB)

2. **Vocos Vocoder**: https://huggingface.co/charactr/vocos-mel-24khz/tree/main
   - Download: `pytorch_model.bin` (~300 MB)
   - Download: `config.json`

Place them in:
```
model_cache/
  f5-tts-model/
    F5TTS_Base/
      model_1200000.pt
      vocab.txt
  vocoder/
    pytorch_model.bin
    config.json
```

## What Gets Downloaded

| Model | Size | Purpose |
|-------|------|---------|
| F5-TTS Base | ~1.3 GB | Main TTS model |
| Vocos Vocoder | ~300 MB | Audio decoder |
| Demucs | ~150 MB | Vocal isolation (audio cleaner) |

**Total: ~1.75 GB**

## Modal Deployment Cache

During Modal deployment:

1. First deployment: Downloads ~1.75 GB (10-15 minutes)
2. Subsequent deployments: Uses cached volume (~1-2 minutes)
3. Cold start: Loads from volume (~30 seconds)
4. Warm container: Already loaded (~instant)

The models are stored in a Modal persistent volume, so you only pay for the download once.

## Troubleshooting

### "Insufficient system resources" on Windows
This is a known issue with hf-xet downloader on Windows. Use Modal deployment instead.

### Slow downloads
Set a HuggingFace token for faster downloads:
```bash
export HF_TOKEN=your_token_here  # Linux/Mac
$env:HF_TOKEN="your_token_here"  # Windows PowerShell
```

Get token at: https://huggingface.co/settings/tokens

### Disk space
Ensure you have at least 5 GB free for the models and cache.
