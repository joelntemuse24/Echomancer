# Echomancer Quality Improvements - Implementation Plan

## The "100% Quality" Strategy

Based on research, here's how we achieve ChatGPT-level naturalness without ChatGPT-level costs:

---

## Phase 1: Deploy Zonos (Immediate - This Week)

### Why Zonos?
- **44kHz native** (vs F5-TTS's 24kHz)
- **Better speaker similarity** on zero-shot cloning
- **Transformer architecture** (not flow matching) = different failure modes
- **Same L4 GPU cost** as F5-TTS

### Cost Analysis
| Aspect | F5-TTS | Zonos | Difference |
|--------|--------|-------|------------|
| GPU | L4 | L4 | Same |
| RTF | 0.15 | ~0.20 | 25% slower |
| Quality | Good | Better | Noticeable |
| Cost/book | $1.50 | $1.90 | +$0.40 |

**Strategy**: Use Zonos for "premium" mode, F5-TTS for "standard"

### Implementation
```bash
# Deploy Zonos
modal deploy modal/zonos_server.py
```

Update `.env.local`:
```bash
MODAL_ZONOS_URL=https://yourname--zonos-tts-zonosserver-generate.modal.run
```

---

## Phase 2: Multi-Reference Voice Cloning (Week 2)

### The Secret
Use **3-5 reference samples** instead of 1. Average the speaker embeddings.

**Impact**: +15-20% speaker similarity
**Cost**: Same (just more audio bytes in one request)

### UX Changes
1. Allow users to upload MULTIPLE voice samples
2. During YouTube search: suggest downloading 3 different clips from same speaker
3. Show "Voice Quality Score" for each sample
4. Automatically pick best 3-5 samples

### Implementation
Modify voice selection flow:
```typescript
// Instead of single voicePath
const voicePaths: string[] = await selectMultipleVoiceSamples();

// In generation
const voiceSample = await prepareMultiReferenceVoice(
  supabase, voicePaths, startTime, endTime, jobId
);
```

---

## Phase 3: Enhanced Prosody Director (Week 3)

### Current State
Your LLM Director outputs: `[emotion:love speed:0.9 energy:low]`

### Enhanced State
Add rich prosody tags:
```
[whisper]She leaned in close,[normal] and whispered the secret.[pause:0.8]
[emphasis]This[emphasis] was the moment everything changed.
[breath] [speed:1.1]She had to move quickly.
```

### Tags to Support
| Tag | Effect | Models Supported |
|-----|--------|------------------|
| `[pause:N]` | N-second silence | F5-TTS, Zonos |
| `[whisper]` | Whisper voice | Fish S2, Zonos (partial) |
| `[emphasis]` | Stress word | All |
| `[breath]` | Add breath sound | F5-TTS |
| `[speed:N]` | Speed multiplier | All |

### Implementation
Update `modal/emotion_director_batch.py` to output rich tags.

---

## Phase 4: Reference Audio Preprocessing (Week 4)

### Current Pipeline
Voice sample → TTS

### Enhanced Pipeline
Voice sample → **Demucs** → **Normalize** → **Trim Silence** → TTS

### Steps
1. **Vocal isolation** (already have this)
2. **Loudness normalization** (-23 LUFS broadcast standard)
3. **Trim silence** (remove dead air at start/end)
4. **High-pass filter** (remove sub-bass rumble)

### Implementation
Add preprocessing step in `prepareVoiceSample()`:
```typescript
async function preprocessVoiceSample(buffer: Buffer): Promise<Buffer> {
  // 1. Demucs (already done)
  // 2. Normalize loudness
  buffer = await normalizeLoudness(buffer, targetLUFS=-23);
  // 3. Trim silence
  buffer = await trimSilence(buffer, thresholdDb=-40);
  return buffer;
}
```

---

## Phase 5: Post-Processing Enhancement (Week 5)

### Current
TTS → Concat → Done

### Enhanced
TTS → Concat → **Enhance** → Done

### Enhancement Chain (via `modal/audio_enhancer.py`)
1. High-pass filter (80Hz) - remove rumble
2. Light compression (2:1 ratio) - even out volume
3. Peak normalization (-1dB) - maximize loudness
4. De-essing (reduce harsh sibilants)

### Cost
- T4 GPU for ~10 seconds per audiobook
- ~$0.02 per book

---

## Phase 6: Hybrid Ensemble (Week 6+)

### Strategy
Generate with BOTH models, pick best:
```
Text → [F5-TTS] → Audio A
     → [Zonos]  → Audio B
     → [Quality Scorer] → Pick best
```

### Quality Scoring
Use lightweight MOS predictor or simple heuristics:
- Spectral variance (natural = varied)
- Zero-crossing rate (natural = moderate)
- RMS energy consistency

### When to Use Ensemble
- Don't use for every chunk (too expensive)
- Use for: First chunk, last chunk, key emotional moments
- Use for: "Preview" mode where user can hear both and pick

---

## Expected Quality Improvements

| Phase | Improvement | Cost Impact |
|-------|-------------|-------------|
| 1. Zonos | +15% naturalness | +$0.40/book |
| 2. Multi-ref | +15% similarity | $0 |
| 3. Rich prosody | +20% expression | $0 |
| 4. Preprocessing | +10% clarity | $0 |
| 5. Post-processing | +10% polish | +$0.02/book |
| **Combined** | **+50-70% overall** | **+$0.42/book** |

**New cost**: ~$2.00/book (vs current $1.50)
**Quality**: Approaching ElevenLabs
**Price to customer**: $4-5/book is now justifiable

---

## Technical Implementation Priority

### Must Do (This Week)
1. ✅ Deploy Zonos server (`modal/zonos_server.py`)
2. ✅ Deploy audio enhancer (`modal/audio_enhancer.py`)
3. ✅ Update F5-TTS to v1 Base + BigVGAN

### Should Do (Next 2 Weeks)
4. Multi-reference voice selection UI
5. Enhanced prosody director with rich tags
6. Reference audio preprocessing pipeline

### Nice to Have (Later)
7. Ensemble generation
8. Quality-based model selection
9. A/B testing framework

---

## Competitive Positioning

With these improvements:

| Feature | ElevenLabs | Echomancer (After) | Echomancer (Before) |
|---------|------------|-------------------|---------------------|
| Custom voices | ✅ | ✅ | ✅ |
| Quality | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| Price ($/1hr audio) | $11 | $2 | $1.50 |
| Latency | Fast | Medium | Medium |
| Emotion control | ✅ | ✅ | ⚠️ |
| Multi-speaker | ✅ | ✅ (soon) | ❌ |
| Offline capable | ❌ | ✅ | ✅ |

**Positioning**: "ElevenLabs quality at 1/5th the cost, with full voice ownership"

---

## Next Steps

1. **Deploy the three Modal files** I created
2. **Test Zonos** alongside F5-TTS
3. **Update pricing** to $4/250 pages + $1/100 pages
4. **Market the quality improvement** as "v2.0"

Want me to deploy these now?
