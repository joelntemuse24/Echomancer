# VoxCPM2 TTS Integration — Senior Engineer Review

## Context

Replaced Qwen3-TTS with VoxCPM2 (2B parameter TTS model) deployed on Modal (L4 GPU). Two endpoints:
- **Single**: `https://ntemusejoel--voxcpm-tts-voxcpmserver-generate.modal.run`
- **Batch**: `https://ntemusejoel--voxcpm-tts-voxcpmserver-generate-batch.modal.run`

---

## Changes Made

### 1. Batch URL Construction Fix (`src/lib/generate-audiobook-v2.ts:721-726`)

**Before (broken):**
```ts
const urlObj = new URL(baseUrl.replace('/generate', '/generate_batch'));
```
Modal puts function names in the **subdomain** (with hyphens), not the URL path. The `.replace()` matched nothing — batch requests were hitting the single endpoint.

**After:**
```ts
const batchUrl = getEnv().MODAL_TTS_BATCH_URL
  || baseUrl.replace(/-generate\./, "-generate-batch.");
```
Uses dedicated `MODAL_TTS_BATCH_URL` env var, with regex fallback that handles the actual URL pattern (`-generate.` → `-generate-batch.`).

**Question for reviewer:** Is the fallback regex robust enough? Edge case: what if `MODAL_TTS_URL` contains `-generate.` elsewhere in the domain?

---

### 2. `reference_text: ""` → `null` (both files)

VoxCPM's Pydantic model:
```python
class TTSRequest(BaseModel):
    reference_text: Optional[str] = None
```
Empty string `""` is truthy in Python, so VoxCPM treated it as prompt text (causing garbage output or `Kernel size` errors). `null` maps to Python `None`, which triggers the no-reference-text code path.

**Files changed:**
- `src/lib/generate-audiobook-v2.ts:714` (batch payload)
- `src/app/api/voice/preview/route.ts:90` (single preview)

---

### 3. CUDA Graph Threading Fix (`modal/voxcpm_server.py:59-63`)

**Problem:** `AssertionError` from `torch._inductor/cudagraph_trees.py` — torch.compile's CUDA graphs use thread-local state that's lost when Modal's FastAPI handler runs in a different thread than `setup()`.

**Fix:**
```python
os.environ["TORCHINDUCTOR_CUDAGRAPH_TREES"] = "0"
torch._inductor.config.triton.cudagraph_trees = False
```

**Tradeoff:** ~5-15% slower inference (CUDA graphs optimize kernel launch overhead), but prevents the crash.

**Question for reviewer:** Is there a better fix? Options considered:
1. ✅ Disable CUDA graphs (current approach)
2. Force `torch.compile` to use `mode="reduce-overhead"` without CUDA graphs
3. Run generation in the same thread as setup (not possible with Modal's FastAPI)
4. Set `TORCHINDUCTOR_CUDAGRAPH_TREES` before `torch.compile` is called (already doing this)

---

### 4. Batch Endpoint Resilience (`modal/voxcpm_server.py:126-152`)

**Before:** If any text in a batch failed, the entire batch returned `{"error": "..."}` — all successful results lost.

**After:** Each text wrapped in individual try/catch. Failed texts get `{"error": "..."}` in their result slot. Response includes `"errors": [indices]` array.

```python
for i, text in enumerate(request.texts):
    try:
        result = self._generate_single(...)
        results.append(result)
    except Exception as e:
        results.append({"error": str(e), "traceback": traceback.format_exc()})
        errors.append(i)
```

**Question for reviewer:** The client-side code in `generate-audiobook-v2.ts:157-189` already handles individual result errors (checks `result.error`, pushes to `failedInBatch`). Does this interact correctly with the new batch error format?

---

### 5. VoxCPM-Specific Error Handling

**Batch (`generate-audiobook-v2.ts:748-757`):**
```ts
if (res.statusCode === 422) {
  errorMsg = `VoxCPM validation error (422): missing or invalid fields. Response: ${responseText.slice(0, 300)}`;
} else if (res.statusCode === 504) {
  errorMsg = `VoxCPM timed out (504): model may be cold-starting. Try again in a few minutes.`;
}
```

**Preview (`voice/preview/route.ts:97-106`):**
```ts
if (generateResponse.status === 422) {
  throw new AppError("TTS_VALIDATION_ERROR", `TTS request validation failed: ${errText.slice(0, 200)}`, 400);
}
if (generateResponse.status === 504) {
  throw new AppError("TTS_TIMEOUT", "Voice synthesis service is starting up. Please try again in a few minutes.", 504);
}
```

**User-facing (`errors-ui.ts:26-29`):**
```ts
if (lower.includes("validation error") || lower.includes("422"))
  return "The voice synthesis service received an invalid request. Please try a different voice sample.";
if (lower.includes("cold-start") || lower.includes("starting up") || lower.includes("timed out (504)"))
  return "The voice synthesis service is warming up. Please try again in 2-3 minutes.";
```

---

### 6. Cost Optimization (`modal/voxcpm_server.py`)

| Setting | Before | After | Rationale |
|---------|--------|-------|-----------|
| `scaledown_window` | 600 (10 min) | 1800 (30 min) | L4 ~$0.50/hr, avoid repeated cold starts |
| `allow_concurrent_inputs` | default (1) | 10 | Single container handles multiple requests |
| `volumes` | none | `torch_inductor` persistent volume | Cache torch.compile kernels across restarts |

**Question for reviewer:** Is 30 min keep-warm worth the cost? At $0.50/hr for L4, 30 min idle = ~$0.25 per idle period. Alternative: accept cold starts but show user a "warming up" message.

---

## Test Plan

### 1. Voice Preview (single endpoint)
```bash
# Start dev server
npm run dev

# 1. Open http://localhost:3000
# 2. Upload a PDF
# 3. On voice selection page, upload a voice sample (WAV/MP3, 5-30 seconds)
# 4. Click "Preview" — should generate audio in ~10-30s
# 5. Verify the preview plays correctly
```

**Expected:** Preview audio plays with the cloned voice.
**If fails:** Check browser console for `TTS_VALIDATION_ERROR` (422) or `TTS_TIMEOUT` (504).

### 2. Full Audiobook Generation (batch endpoint)
```bash
# 1. After voice selection, click "Generate Audiobook"
# 2. Monitor job progress in /dashboard/queue
# 3. Wait for status to reach "ready"
# 4. Play the audiobook
```

**Expected:** Job progresses from 0% → 100%, audiobook plays end-to-end.
**If fails:** Check server logs for `[Job <id>]` entries. Common issues:
- First batch takes 3-4 min (cold start) — subsequent batches ~10-20s
- `422` means request format mismatch — check `reference_text` is `null` not `""`
- `AssertionError` means CUDA graph fix didn't apply — check `TORCHINDUCTOR_CUDAGRAPH_TREES=0`

### 3. Cold Start → Warm Request
```bash
# 1. Wait 30+ min for container to scale down
# 2. Create a new job
# 3. First batch should take 3-4 min (model load + warm-up)
# 4. Second batch should take ~10-20s (container is warm)
```

### 4. Batch Partial Failure
```bash
# 1. Create a job with a very long text that might hit token limits
# 2. Verify individual section failures don't kill the entire batch
# 3. Check that failed sections appear in error message
```

### 5. Direct API Test
```bash
# Health check (no GPU needed)
curl https://ntemusejoel--voxcpm-tts-health.modal.run/

# Single generate (needs real base64 audio, container warm)
curl -X POST https://ntemusejoel--voxcpm-tts-voxcpmserver-generate.modal.run \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","reference_audio_base64":"<REAL_AUDIO_BASE64>","reference_text":null,"cfg_value":2.0,"inference_timesteps":10}'
```

---

## Known Risks

1. **torch.compile cache persistence**: The `TORCHINDUCTOR_CACHE_DIR` volume may not actually cache compiled kernels effectively — PyTorch's caching behavior across process restarts is not well-documented. First cold start after deploy will still be slow (~4 min). Subsequent starts *may* be faster if the cache works.

2. **CUDA graphs disabled**: ~5-15% inference overhead. If this is unacceptable, we'd need to restructure to run generation in the same thread as model loading.

3. **No auth on Modal endpoints**: Anyone with the URL can call the TTS service. Should add API key validation.

4. **Batch is sequential**: `generate_batch` processes texts one-by-one on a single GPU. No parallelism within a batch. This is fine for L4 but could be improved with concurrent CUDA streams.

5. **`allow_concurrent_inputs=10`**: Multiple requests share one GPU. If two batches run simultaneously, they compete for GPU memory. Could OOM on large batches.
