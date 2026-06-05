# Code Review Request: Parallel F5-TTS Audiobook Pipeline

**Author:** AI Assistant (Kimi Code CLI)  
**Date:** 2026-06-04  
**Branch:** `main` (changes staged in working tree)  
**Reviewer:** Senior Engineer  

---

## 1. What Problem Are We Solving?

Audiobook generation on Modal is **~10 minutes per book** despite renting A10G GPUs. The root cause: `process_audiobook` was processing all text sections **serially** in a Python `for` loop, one `model.infer()` call at a time. `BATCH_SIZE = 8` only batched **webhook updates**, not model inference.

## 2. Summary of Changes

### `modal/f5_tts_server.py` (~+150 lines)
- **Removed `keep_warm`**: Previously paid 24/7 for 2 warm containers (~$2.40/hr). Now uses on-demand warmup triggered by frontend.
- **Added `F5TTSAudiobookWorker` class**: GPU container class with `setup()`, `warmup()`, and `process_sections()` methods.
- **Parallelized generation**: Orchestrator splits book into 4 chunks, farms them via `worker.process_sections.map()`. Each container processes its chunk serially.
- **Made orchestrator CPU-only**: `process_audiobook` no longer requests a GPU — it downloads, splits, delegates, concatenates, uploads.
- **Async webhooks**: `send_webhook_async()` fires in a background thread so HTTP calls never block the diffusion loop.
- **Increased chunk size**: `max_chunk_size = 4000` (was 1200). Cuts section count by ~3×.
- **Added `/warmup` endpoint**: CPU endpoint that calls `worker.warmup.map([0,1,2,3])` to spin up 4 GPU containers ahead of time.

### `src/lib/modal-client.ts` (+28 lines)
- Added `warmupModal(containers = 4)` helper. Fire-and-forget POST to `/warmup`. Fails silently — non-critical.

### Frontend pages (3 files)
| File | Trigger point |
|------|---------------|
| `src/app/page.tsx` | After PDF upload succeeds |
| `src/app/dashboard/voice/page.tsx` | On `VoiceSelectionContent` mount (if `pdfPath` present) |
| `src/app/dashboard/voice/clip/page.tsx` | On mount + inside `handleUseClip()` just before `POST /api/jobs` |

## 3. Expected Behavior After Deploy

**User flow timing:**
1. User lands on site → (no warmup yet — they haven't committed)
2. User uploads PDF → `warmupModal()` fires → 4 GPU containers start loading F5-TTS (~30-45s)
3. User picks voice / clips voice → `warmupModal()` fires again (idempotent, containers already warm)
4. User clicks "Create audiobook" → `warmupModal()` fires final time, then `POST /api/jobs`
5. Orchestrator splits text into 4 chunks, distributes via `.map()`
6. Each warm container processes its chunk, uploads partial WAV to R2
7. Orchestrator downloads 4 partials, concatenates, normalizes, uploads final MP3

**Expected wall-clock time:** ~1.5–3 min (was 10+ min)

## 4. Specific Areas to Review

### A. Modal Parallelism Correctness
```python
# Lines ~550–600 in f5_tts_server.py
worker = F5TTSAudiobookWorker()
chunk_results = list(worker.process_sections.map(chunk_requests))
```
**Questions:**
- Does `.map()` on a `@modal.cls` method spawn one container per input item? (Modal docs say yes for class methods)
- Is `max_containers=4` respected when `.map()` is called with 4 items?
- If the user sends 2 books simultaneously, does Modal queue the 5th+ chunk correctly?

### B. Orchestrator GPU Removal
```python
@app.function(
    # NO gpu=GPU_CONFIG here
    ...
)
def process_audiobook(request_dict: dict) -> dict:
```
**Questions:**
- Does removing `gpu=` cause any issue with `torch` or `soundfile` imports inside `process_audiobook`?
- The orchestrator imports `fitz` (pymupdf), `soundfile`, `subprocess` — all CPU-safe. Confirm.
- `concatenate_audio_ffmpeg()` and `normalize_audio_ffmpeg()` use `subprocess` — fine on CPU.

### C. Partial Failure Handling
```python
if not successful_chunks:
    raise ValueError(f"All chunks failed...")
```
**Questions:**
- If 1 of 4 chunks fails, we proceed with 3/4 audio. Is silently dropping text acceptable?
- Should we retry failed chunks? (Current: no retry logic)
- Failed chunk text is lost — user gets a gap in their audiobook. Should we fail the whole job instead?

### D. R2 Storage for Partial Chunks
Each chunk worker uploads its partial audio to R2:
```python
chunk_r2_key = f"audiobooks/{job_id}/chunks/chunk_{chunk_index:03d}.wav"
```
**Questions:**
- Do we need lifecycle rules on R2 to auto-delete these partials? (Currently they accumulate)
- If 2 jobs run simultaneously with same `job_id` — is this possible? (UUIDs should prevent collisions)

### E. Warmup Race Conditions
Frontend calls `warmupModal()` 3 times in the funnel:
```typescript
// page.tsx: after upload
warmupModal();
// voice/page.tsx: on mount  
warmupModal();
// voice/clip/page.tsx: on mount + before create
warmupModal();
```
**Questions:**
- Can rapid overlapping warmup calls cause Modal to spin up more than 4 containers?
- Does Modal deduplicate concurrent `.map()` calls to the same class method?
- If warmup is still running when generation starts, does `.map()` wait or spin up new containers?

### F. `scaledown_window=600` on Worker vs. Orchestrator
Worker: `scaledown_window=600` (10 min idle before shutdown)  
Orchestrator: `scaledown_window=300` (5 min)

**Question:** After a job completes, the orchestrator container shuts down in 5 min. The worker containers shut down in 10 min. If a new job comes in at minute 7, the orchestrator cold-starts but the workers are still warm. Is this acceptable?

### G. Environment Variable Access in Browser
```typescript
const baseUrl = (process.env.NEXT_PUBLIC_MODAL_TTS_URL || process.env.MODAL_TTS_URL || "").replace("/generate_batch", "");
```
**Question:** `process.env.MODAL_TTS_URL` is NOT prefixed with `NEXT_PUBLIC_`. In a client component (`"use client"`), does Next.js bundle this at build time? Or will it be `undefined` in the browser, causing `warmupModal()` to silently skip?

**If this is a problem**, the fix is:
- Add `NEXT_PUBLIC_MODAL_TTS_URL` to `.env.local` and Vercel dashboard
- Or move `warmupModal()` to a server action / API route

### H. Chunk Size = 4000 Characters
**Question:** Has anyone tested F5-TTS with 4000-character inputs? The model was likely trained on shorter utterances. At inference time, longer text means:
- Longer generated audio per section → fewer concatenation points → less noticeable joins
- But: F5-TTS uses diffusion → longer mel-spectrogram → more steps → slower per-section

Tradeoff: fewer sections (good) vs. longer per-section (bad). We picked 4000 empirically. Should we A/B test 2000 vs 4000 vs 6000?

## 5. Testing Checklist (for reviewer + deploy)

### Before Deploy
- [ ] `modal deploy f5_tts_server.py` succeeds without errors
- [ ] `npx vercel --prod` succeeds (TypeScript compiles, no lint errors)
- [ ] `NEXT_PUBLIC_MODAL_TTS_URL` is set in Vercel environment variables

### After Deploy — Warmup Test
- [ ] Open site in browser, upload a PDF
- [ ] Check Modal logs: `[API] Warming up 4 GPU containers...` appears
- [ ] Confirm 4 containers spin up and report `[Worker] Model loaded and ready`

### After Deploy — Generation Test
- [ ] Upload a 50+ page PDF, pick voice, clip, click Create
- [ ] Check Modal logs: `Farming 4 chunks to 4 workers via .map()`
- [ ] Check that 4 containers process chunks simultaneously (timestamps should overlap)
- [ ] Confirm final audiobook plays correctly with no gaps
- [ ] Confirm webhook progress updates arrive (10% → chunk done → 75% → 100%)

### After Deploy — Stress Test
- [ ] Start 2 audiobook jobs simultaneously
- [ ] Confirm both complete successfully (8 total chunks across 4 max containers)
- [ ] Check R2 for accumulating partial chunk files (`audiobooks/{job_id}/chunks/`)

### After Deploy — Idle Test
- [ ] Wait 15 minutes after last job
- [ ] Start a new job
- [ ] Confirm cold start occurs (logs show model loading again)

## 6. Rollback Plan

If anything breaks:
1. Revert `modal/f5_tts_server.py` to previous version (git checkout or restore from git history)
2. `modal deploy f5_tts_server.py` to restore old serial pipeline
3. Frontend changes are additive (new `warmupModal()` calls) — safe to leave, but can revert the 3 page files too

## 7. Known Limitations / Future Work

| Issue | Priority | Notes |
|-------|----------|-------|
| No retry for failed chunks | Medium | Could retry within orchestrator or add `modal.Retry` |
| Partial chunk files accumulate in R2 | Low | Add lifecycle rule or delete after concatenation |
| Orchestrator cold-starts in 5 min while workers stay 10 min | Low | Acceptable tradeoff |
| No true batch inference inside a container | Low | F5-TTS `infer()` likely doesn't support batched text inputs anyway |
| Could use Modal's `Function.map()` retries | Low | Add `retries=2` to `.map()` call |

---

**Please review the code in these files specifically:**
- `modal/f5_tts_server.py` (lines 356–520: `F5TTSAudiobookWorker`, `process_audiobook`, `/warmup` endpoint)
- `src/lib/modal-client.ts` (new `warmupModal()` function)
- `src/app/page.tsx`, `src/app/dashboard/voice/page.tsx`, `src/app/dashboard/voice/clip/page.tsx` (warmup calls)

**After your review, the deploy command is:**
```bash
cd modal && modal deploy f5_tts_server.py
cd .. && npx vercel --prod
```
