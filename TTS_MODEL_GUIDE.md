# TTS Model Comparison & Recommendations for Audiobooks

## Your Current Setup: F5-TTS

| Aspect | Details |
|--------|---------|
| **Max reference audio** | ~15 seconds |
| **Text per request** | ~1000 chars (your current setting) |
| **Quality** | Very good for short clips |
| **Speed** | Moderate |
| **Cost on Modal** | ~$0.07/book |

**F5-TTS Limitations:**
- Reference audio capped at ~15s (quality degrades beyond this)
- No native long-form generation (requires chunking)
- Can have inconsistent prosody across chunks
- Voice cloning quality varies with sample quality

---

## 🏆 Top Recommendations for Audiobooks

### 1. **Zonos** (Recommended Alternative)

```python
# Deployed in modal/f5_tts_server_v2.py as ZonosServer class
```

| Feature | Details |
|---------|---------|
| **Reference audio** | 10-30s (optimal), can use multiple |
| **Text per request** | Up to ~2000 chars |
| **Quality** | Excellent - very natural |
| **Speed** | Fast |
| **Emotion control** | Yes (speaking styles) |
| **License** | Commercial use allowed |

**Pros:**
- Best voice cloning quality currently available
- Handles longer text natively
- More consistent across chunks
- Better intonation/prosody

**Cons:**
- Slightly higher compute cost
- Newer model (less community support)

**When to use:** When voice quality is paramount

---

### 2. **Kokoro** (Speed King)

| Feature | Details |
|---------|---------|
| **Reference audio** | Not a voice cloner (has built-in voices) |
| **Text per request** | Unlimited (streaming) |
| **Quality** | Very good |
| **Speed** | Extremely fast (real-time on CPU) |
| **Cost** | Almost free |

**Pros:**
- Fastest generation available
- Great for long books
- No voice cloning needed (use built-in quality voices)
- Can run on CPU

**Cons:**
- No voice cloning (can't clone from YouTube)
- Limited to built-in voice library

**When to use:** For fast/cheap bulk processing with quality built-in voices

---

### 3. **Orpheus** (Designed for Audiobooks)

| Feature | Details |
|---------|---------|
| **Reference audio** | Voice cloning supported |
| **Text per request** | Very long (designed for books) |
| **Quality** | Excellent for narration |
| **Special features** | Chapter markers, emotion tags |

**Pros:**
- Specifically trained for audiobook narration
- Understands book structure (paragraphs, chapters)
- Better handling of dialogue vs narration

**Cons:**
- Newer, less tested
- Deployment more complex

**When to use:** Pure audiobook use case

---

### 4. **XTTS v2** (Tried & True)

| Feature | Details |
|---------|---------|
| **Reference audio** | 6-30s |
| **Text per request** | ~400 tokens |
| **Quality** | Good, well-established |
| **Community** | Large, mature |

**Pros:**
- Battle-tested
- Good ecosystem
- Decent voice cloning

**Cons:**
- Quality not as good as Zonos/F5
- Requires more chunking

**When to use:** When you need stability and community support

---

## 🎯 Specific Solutions for Your Problems

### Problem 1: Long Text / Audiobooks

**Current:** 1000 char chunks with F5-TTS

**Better approaches:**

#### Option A: Use Zonos (2x longer per request)
```typescript
// In generate-audiobook.ts
const maxCharsPerRequest = 2000; // vs 1000 for F5-TTS
```

#### Option B: Use Kokoro (no chunking needed)
```typescript
// Stream entire book at once
const text = await extractPDFText(...);
const audio = await kokoroTTS(text); // No splitting!
```

#### Option C: Smart chunking with semantic boundaries
```typescript
// Split on paragraph boundaries, not just char count
function splitOnParagraphs(text: string): string[] {
  // Your improved version in generate-audiobook-v2.ts does this
}
```

### Problem 2: Longer Voice Samples

**Current:** Limited to ~15s with F5-TTS

**Solutions:**

#### Solution 1: Smart Segment Extraction (Implemented in v2)
```python
# In modal/f5_tts_server_v2.py
# Automatically extracts the BEST 15s from a longer sample

def _extract_best_segment(y, sr, wav_path):
    """Finds segment with best energy + pitch stability"""
    # Scans entire audio, picks best 15s
```

#### Solution 2: Multiple Reference Samples
```typescript
// Send multiple voice clips, use best or average
const voiceSamples = [
  clip1, // First 15s
  clip2, // Middle 15s  
  clip3  // End 15s
];
```

#### Solution 3: Use Zonos (supports longer references)
```python
# Zonos can use up to 30s effectively
# Quality improves up to ~30s, then plateaus
```

#### Solution 4: Voice Embedding Persistence
```typescript
// Extract voice embedding once, reuse for entire book
// (Saves time + ensures consistency)

// 1. Pre-compute speaker embedding
const speakerEmbedding = await extractSpeakerEmbedding(voiceSample);

// 2. Use for all chunks
for (const chunk of chunks) {
  await generateWithEmbedding(chunk, speakerEmbedding);
}
```

---

## 🔧 Recommended Architecture Changes

### For Better Voice Cloning (Long Samples)

```
┌─────────────────┐
│  User uploads   │
│  5 min audio    │
└────────┬────────┘
         ▼
┌─────────────────────────┐
│  1. Audio Analysis      │
│     - Detect silence    │
│     - Find speech parts │
└────────┬────────────────┘
         ▼
┌─────────────────────────┐
│  2. Extract 3 clips:    │
│     - Start (0-15s)     │
│     - Middle (2:30-2:45)│
│     - End (4:45-5:00)   │
└────────┬────────────────┘
         ▼
┌─────────────────────────┐
│  3. Process each clip:  │
│     - Transcribe        │
│     - Score quality     │
│     - Pick best         │
└────────┬────────────────┘
         ▼
┌─────────────────────────┐
│  4. Store embeddings    │
│     (reuse for book)    │
└─────────────────────────┘
```

### For Longer Text Generation

```
┌─────────────────┐
│   Full Book     │
│   Text          │
└────────┬────────┘
         ▼
┌─────────────────────────┐
│  Semantic Splitting:    │
│  - Paragraph boundaries │
│  - Chapter breaks       │
│  - Dialogue vs narration│
│  Target: ~2000 chars    │
└────────┬────────────────┘
         ▼
┌─────────────────────────┐
│  Parallel Generation:   │
│  - Batch size: 2-3      │
│  - With retry logic     │
│  - Save checkpoints     │
└────────┬────────────────┘
         ▼
┌─────────────────────────┐
│  Smart Concatenation:   │
│  - Crossfade overlap    │
│  - Normalize volume     │
│  - Add chapter markers  │
└─────────────────────────┘
```

---

## 💰 Cost Comparison (per 100-page book)

| Model | Chunks | Time | Modal Cost | Quality |
|-------|--------|------|------------|---------|
| F5-TTS | ~50 | ~10 min | $0.07 | ⭐⭐⭐⭐ |
| Zonos | ~25 | ~8 min | $0.10 | ⭐⭐⭐⭐⭐ |
| Kokoro | 1 | ~30 sec | $0.001 | ⭐⭐⭐⭐ |
| XTTS v2 | ~50 | ~12 min | $0.08 | ⭐⭐⭐ |
| Orpheus | ~10 | ~5 min | $0.05 | ⭐⭐⭐⭐⭐ |

---

## 🚀 Implementation Priority

### Immediate (This Week)
1. ✅ Use `generate-audiobook-v2.ts` for partial failure recovery
2. ✅ Deploy `f5_tts_server_v2.py` for better voice sample handling
3. ✅ Run database migration for checkpoints

### Short Term (Next 2 Weeks)
1. Try Zonos as alternative TTS endpoint
2. Implement voice embedding caching
3. Add semantic paragraph-aware splitting

### Long Term
1. Try Orpheus for dedicated audiobook mode
2. Add automatic voice quality scoring
3. Implement crossfade between chunks

---

## 📋 Quick Switching Guide

### Switching to Zonos:

```bash
# 1. Deploy Zonos server
modal deploy modal/f5_tts_server_v2.py::ZonosServer

# 2. Update env
MODAL_TTS_URL=https://your-modal-url...  # New Zonos URL

# 3. Update chunk size in code
const maxCharsPerRequest = 2000;  // Was 1000
```

### Switching to Kokoro:

```bash
# 1. Deploy Kokoro (different setup)
# See: https://github.com/remsky/Kokoro-FastAPI

# 2. Remove chunking entirely for short books
# Keep chunking only for very long books (>10k chars)
```

---

## Summary

| Your Need | Best Option |
|-----------|-------------|
| Keep voice cloning, better quality | **Zonos** |
| Keep voice cloning, longer samples | **F5-TTS v2** with segment extraction |
| Speed + cost paramount | **Kokoro** |
| Audiobook-specific features | **Orpheus** |
| Stability + community | **XTTS v2** |

**My recommendation:** Try Zonos first - it's the best balance of quality and features for your use case.
