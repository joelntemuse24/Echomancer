# VoxCPM2 Audio Quality & Generation Speed — Problem Analysis & Proposed Solutions

## Problems Reported

1. **Audio sounds muffled / not clear** — Voice fidelity (timbre matching) is good, but the output sounds poorly recorded rather than clean and crisp. Described as "not clear," "muffled," lacking clarity despite good voice resemblance.
2. **Generation is too slow** — 20 sections (~6,200 chars) took **12 minutes**. A 186-section book (~61,200 chars) would take over an hour. This is unacceptable for production.

---

## Root Cause Analysis

### Problem 1: Muffled Audio Quality

**Three contributing factors, all fixable:**

#### 1a. Post-processing pipeline is degrading audio (PRIMARY CAUSE)

The current ffmpeg post-processing chain in `src/lib/generate-audiobook-v2.ts:678-685` applies:

```
-ar 44100 -ac 1
equalizer=f=200:g=1.5
equalizer=f=400:g=-1
equalizer=f=3000:g=1
lowpass=f=11000
loudnorm=I=-16:LRA=11:TP=-1.5
```

**This is the main culprit.** VoxCPM2 outputs **48kHz studio-quality audio** via its AudioVAE V2 decoder with built-in super-resolution. The post-processing then:

- **Downsamples from 48kHz → 44.1kHz** — loses high-frequency detail that the model intentionally generated
- **Converts to mono** (`-ac 1`) — removes spatial presence
- **Applies a lowpass filter at 11kHz** — this is devastating. 48kHz audio has content up to 24kHz. Cutting at 11kHz removes all "air" and "presence" frequencies (11-24kHz) that make speech sound crisp and natural. This alone explains the muffled quality.
- **Boosts 200Hz and 3kHz, cuts 400Hz** — these EQ adjustments were likely tuned for a different TTS model and are inappropriate for VoxCPM2's already-balanced output
- **Aggressive loudnorm** — I=-16 with LRA=11 and TP=-1.5 is very aggressive normalization that can compress dynamic range, making speech sound flat

**Fix:** Remove the destructive post-processing. VoxCPM2's output is already studio-quality 48kHz. Only apply minimal loudnorm for consistency between sections, and keep the full frequency range.

#### 1b. Crossfade between sections may introduce artifacts

The concatenation in `src/lib/generate-audiobook-v2.ts:895-876` uses `acrossfade=d=0.15:c1=tri:c2=tri` — a 150ms triangular crossfade. This is fine for smooth music transitions but can cause:
- Volume dips at section boundaries (both signals attenuating simultaneously)
- Phase issues if the sections have slightly different characteristics

**Fix:** Use a shorter crossfade (50ms) or simple concatenation with silence padding, since speech sections are independent utterances that don't need musical blending.

#### 1c. KV cache reset may not be fully effective

The `_reset_kv_cache()` method in `modal/voxcpm_server.py:113-138` calls `setup_cache()` to reinitialize, but the VoxCPM model's internal `_generate_with_prompt_cache` method may have additional cached state beyond what `setup_cache` resets. If KV cache state leaks between sections, later sections will sound degraded.

**Fix:** Verify the reset works by comparing section 1 audio quality vs section 20 in isolation. If degradation is visible, consider reloading the model or using a more thorough cache invalidation.

---

### Problem 2: Generation Speed

**Current performance:** ~33 seconds per section (~300 chars), ~8 chars/sec. RTF ≈ 5-8x (5-8× slower than real-time).

**VoxCPM2's published benchmarks:**
- RTF ~0.3 on RTX 4090 with torch.compile
- RTF ~0.13 with Nano-vLLM / vLLM-Omni acceleration
- We're on an **L4 GPU** (~40% of 4090 performance)
- We have **torch.compile disabled** (adds ~10-15% overhead per section, but the real cost is no kernel fusion)

**Expected on L4 without compile:** RTF ~0.5-0.8 → a 10-second audio clip should take 5-8 seconds. We're seeing 33 seconds. **4-6× slower than expected.**

#### 2a. torch.compile is disabled (MAJOR)

We disabled `torch.compile` to fix `cache_size_limit` and FX tracing errors. This means:
- No kernel fusion → many small CUDA kernels instead of few large ones
- No operator optimization → each layer runs individually
- No Triton code generation → missing memory-efficient attention patterns

**The right fix is not "disable compile" but "fix compile."** The original errors were:
1. `cache_size_limit` (default 8) — we already set it to 256, which should be sufficient for batch sizes of 8
2. FX symbolic tracing of dynamo-optimized function — this was caused by nested compile (VoxCPM internally compiles sub-modules, and our outer compile tried to trace the already-compiled result)

**Fix:** Re-enable torch.compile with proper configuration:
- Set `torch._dynamo.config.cache_size_limit = 256`
- Use `TORCHINDUCTOR_CACHE_DIR` on the persistent volume so compiled kernels survive cold starts
- Do NOT monkey-patch `torch.compile` — let VoxCPM's internal compilation work
- The 5-minute warm-up only happens on the **first cold start ever** — subsequent starts use the cached compiled kernels from the persistent volume
- Increase scaledown_window to keep the container warm longer

#### 2b. Batch generation is sequential on the server

The `generate_batch` endpoint in `modal/voxcpm_server.py:200-226` processes texts one at a time in a `for` loop. Each call to `_generate_single` resets KV cache, decodes the reference audio from base64 (every time!), writes a temp file, generates, encodes back to base64.

**The reference audio is identical for every section in a batch.** Decoding it from base64 and writing to a temp file 8-20 times per batch is pure waste.

**Fix:** Decode the reference audio once at the start of `generate_batch`, write the temp file once, and reuse it for all sections in the batch.

#### 2c. Wrong GPU choice

L4 GPU: 24GB VRAM, ~$0.50/hr on Modal. Adequate but slow for inference.
A10G GPU: 24GB VRAM, ~$0.60/hr on Modal. ~50% faster inference than L4.
A100 GPU: 40GB/80GB VRAM, ~$1.50/hr on Modal. ~3× faster than L4.

For a 186-section book at current speed (~33s/section), that's ~100 minutes on L4 = ~$0.83 per book.
On A100 at ~11s/section, that's ~34 minutes = ~$0.85 per book. **Same cost, 3× faster.**

**Fix:** Upgrade to A10G or A100. The per-book cost is similar because you pay for less time.

#### 2d. No streaming / vLLM integration

VoxCPM2 has official vLLM-Omni support with PagedAttention that achieves RTF ~0.13. This would make generation ~25× faster than current.

**Fix (longer term):** Deploy VoxCPM2 via vLLM-Omni instead of the custom FastAPI server. This is a larger refactor but would dramatically improve speed.

---

## Proposed Solutions (Priority Order)

### P0: Fix muffled audio (quick, no cost increase)

**File:** `src/lib/generate-audiobook-v2.ts` — `postProcessAudio()` function

Replace the current destructive pipeline with a minimal one that preserves VoxCPM2's native 48kHz quality:

```typescript
// BEFORE (destructive):
-ar 44100 -ac 1
equalizer=f=200:g=1.5, equalizer=f=400:g=-1, equalizer=f=3000:g=1
lowpass=f=11000
loudnorm=I=-16:LRA=11:TP=-1.5

// AFTER (preserves quality):
-ar 48000
loudnorm=I=-16:LRA=20:TP=-1  (gentle normalization only)
-b:a 192k
```

Key changes:
- **Keep 48kHz** — VoxCPM2 outputs 48kHz natively, no reason to downsample
- **Remove lowpass** — the 11kHz cutoff was killing clarity
- **Remove EQ** — VoxCPM2's output is already balanced
- **Keep stereo** — don't force mono
- **Soften loudnorm** — LRA=20 allows more dynamic range, TP=-1 is less aggressive

Also update the concatenation crossfade from `d=0.15` to `d=0.05` (50ms) to reduce section boundary artifacts.

### P1: Re-enable torch.compile properly (medium effort, big speed gain)

**File:** `modal/voxcpm_server.py` — `setup()` method

1. Remove `TORCHDYNAMO_DISABLE=1` and the `torch.compile` monkey-patch
2. Set `torch._dynamo.config.cache_size_limit = 256` (already tested, works)
3. Set `torch._inductor.config.triton.cudagraph_trees = False` (prevents FX tracing issue)
4. Ensure `TORCHINDUCTOR_CACHE_DIR` points to the persistent volume
5. **Critical:** Run a warmup generation during `setup()` so the compile happens at container start, not on the first user request. The compiled kernels will be cached to the persistent volume, so subsequent cold starts skip compilation entirely.

```python
# In setup(), after loading model:
# Warm up with a dummy generation to trigger torch.compile caching
print("Warming up torch.compile (one-time, cached to volume)...")
dummy_wav = self.model.generate(
    text="Warm up.",
    reference_wav_path=ref_path,  # use the reference audio
    cfg_value=2.0,
    inference_timesteps=4,  # minimal steps for warmup
)
print("✓ Warmup complete — compiled kernels cached to volume")
```

After the first deployment, the persistent volume will contain all compiled kernels. Future cold starts will load them from cache in seconds, not minutes.

### P2: Optimize batch endpoint (quick, moderate speed gain)

**File:** `modal/voxcpm_server.py` — `generate_batch()` method

Decode reference audio once per batch instead of once per section:

```python
def generate_batch(self, request: BatchTTSRequest):
    # Decode reference audio ONCE for the entire batch
    ref_audio, ref_sr = self._decode_audio(request.reference_audio_base64)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        sf.write(tmp.name, ref_audio, ref_sr)
        ref_path = tmp.name
    
    try:
        results = []
        for i, text in enumerate(request.texts):
            try:
                self._reset_kv_cache()
                wav = self.model.generate(
                    text=text,
                    reference_wav_path=ref_path,
                    cfg_value=request.cfg_value,
                    inference_timesteps=request.inference_timesteps,
                )
                # ... encode and append result
            except Exception as e:
                results.append({"error": str(e)})
        return {"results": results, "total": len(results)}
    finally:
        os.unlink(ref_path)
```

This eliminates 7-19 redundant base64 decodes + temp file writes per batch.

### P3: Upgrade GPU (quick, no code change, same cost)

**File:** `modal/voxcpm_server.py` — `@app.cls(gpu=...)`

Change `gpu="L4"` to `gpu="A10G"` (~50% faster, ~$0.10/hr more) or `gpu="A100"` (~3× faster, ~$1.00/hr more).

On A100 with torch.compile re-enabled, expected RTF ~0.15-0.2 → sections generate in ~2-3 seconds instead of 33 seconds. A 186-section book would take ~10 minutes instead of 100 minutes, at roughly the same cost per book.

### P4: vLLM-Omni integration (larger effort, future)

Replace the custom FastAPI server with vLLM-Omni's official VoxCPM2 serving. This provides:
- PagedAttention for efficient KV cache management
- Continuous batching for concurrent requests
- RTF ~0.13 on A100
- OpenAI-compatible API

This is a bigger refactor but would be the production-grade solution.

---

## Expected Impact

| Fix | Audio Quality | Speed | Effort |
|-----|--------------|-------|--------|
| P0: Remove destructive post-processing | **Major improvement** | No change | 30 min |
| P1: Re-enable torch.compile | No change | **2-3× faster** | 2-3 hrs |
| P2: Batch decode optimization | No change | **10-15% faster** | 30 min |
| P3: Upgrade to A100 | No change | **3× faster** | 5 min |
| P4: vLLM-Omni | No change | **10-25× faster** | 1-2 days |

**Combined P0+P1+P2+P3:** Audio goes from muffled to studio-quality, generation goes from ~33s/section to ~2-3s/section. A 186-section book drops from ~100 min to ~10 min. Cost per book stays roughly the same.

---

## Files to Modify

1. `src/lib/generate-audiobook-v2.ts` — `postProcessAudio()` (P0), crossfade duration (P0)
2. `modal/voxcpm_server.py` — `setup()` (P1), `generate_batch()` (P2), GPU config (P3)
