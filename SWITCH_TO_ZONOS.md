# Switch to Zonos - Quick Start Guide

## 🚀 One-Command Deployment

```bash
# Make the script executable and run it
chmod +x deploy-zonos.sh
./deploy-zonos.sh
```

This will:
1. Deploy Zonos to Modal
2. Get the deployment URL
3. Update your `.env.local` file
4. Test the deployment

---

## 📋 Manual Steps (if script fails)

### Step 1: Deploy Zonos Server

```bash
cd modal
modal deploy zonos_server.py
```

Wait for deployment to complete (5-10 minutes for first build).

### Step 2: Get Deployment URL

After deployment, get your URL from:
```bash
modal app list
```

Or check the Modal dashboard: https://modal.com/apps

### Step 3: Update Environment

Edit `.env.local`:
```bash
# Old F5-TTS URL (save this if you want to rollback)
# MODAL_TTS_URL=https://your-old-url.modal.run

# New Zonos URL
MODAL_TTS_URL=https://yourname--zonos-tts-zonoserver.modal.run
```

### Step 4: Restart Next.js

```bash
npm run dev
```

---

## ✅ Verification

### Test the endpoint:

```bash
curl -X POST $MODAL_TTS_URL \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, this is a test of the Zonos text to speech system.",
    "reference_audio_base64": "",
    "format": "mp3"
  }'
```

### Test through your app:

1. Go to http://localhost:3000/dashboard
2. Upload a PDF
3. Upload a voice sample (up to 30 seconds!)
4. Create an audiobook
5. Check the queue for progress

---

## 📊 What Changed

| File | Change |
|------|--------|
| `modal/zonos_server.py` | **NEW** - Zonos TTS server |
| `src/lib/generate-audiobook.ts` | Updated for Zonos (2000 char chunks, faster) |
| `src/lib/validation.ts` | Allow longer voice samples (30s vs 15s) |
| `.env.local` | New MODAL_TTS_URL |

---

## 🔙 Rollback to F5-TTS

If you need to switch back:

```bash
# 1. Restore old URL in .env.local
MODAL_TTS_URL=your-old-f5-tts-url

# 2. Restore old generator (if you kept a backup)
cp src/lib/generate-audiobook.ts.backup src/lib/generate-audiobook.ts

# 3. Restart
npm run dev
```

---

## 💰 Expected Savings

| Metric | Before (F5-TTS) | After (Zonos) |
|--------|-----------------|---------------|
| Cost per book | ~$0.07 | ~$0.03 |
| Time per book | ~3.5 min | ~2 min |
| Max chunk size | 1000 chars | 2000 chars |
| Voice sample | 15s max | 30s max |
| Quality | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

---

## 🐛 Troubleshooting

### "Modal not found"
```bash
pip install modal
modal token new
```

### "GPU out of memory"
Zonos uses less memory than F5-TTS. If you see OOM errors:
- Check no other apps are using the GPU
- Try reducing BATCH_SIZE in `generate-audiobook.ts` from 4 to 2

### "Voice sample too short"
Zonos requires at least 3 seconds of audio. Upload a longer sample.

### "Generation slower than expected"
- First request has cold start (~30s)
- Subsequent requests are fast
- Check Modal dashboard for GPU utilization

### "Quality not as good"
- Make sure voice sample is clean (no background noise)
- Try different sections of the voice sample
- Zonos works best with 10-20s of clear speech

---

## 📞 Support

- Modal docs: https://modal.com/docs
- Zonos repo: https://github.com/Zyphra/Zonos
- Your code: Check `modal/zonos_server.py` for configuration
