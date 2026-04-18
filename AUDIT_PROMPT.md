# Echomancer v2 — Codebase Audit Prompt

You are auditing a production-ready audiobook generation platform. The codebase has undergone multiple rounds of bug fixes and feature additions. Your job is to find **remaining** issues that were missed — not to re-discover already-fixed problems.

## What This App Does

Converts PDFs into audiobooks using AI voice cloning (F5-TTS on Modal GPU). Users upload a PDF, select a voice from YouTube or upload their own audio, clip a 3-30s voice sample, and generate a full audiobook with emotion-directed narration.

## Tech Stack

- **Frontend**: Next.js 16 App Router, React 19, TypeScript strict, Tailwind CSS 4, shadcn/ui, Framer Motion, Supabase Realtime
- **Backend**: Next.js API routes, Supabase (PostgreSQL + Storage), Zod validation
- **AI/ML**: Modal.com GPU — F5-TTS for TTS, Demucs for vocal isolation, Whisper for ref_text transcription, Emotion Director LLM for SML-tagged pacing
- **Key files**: `src/lib/generate-audiobook-v2.ts` (generation pipeline), `modal/f5_tts_server_fixed.py` (TTS server), `src/app/dashboard/voice/clip/page.tsx` (clip UI)

## Already Fixed (DO NOT re-report these)

These have been verified and fixed. Do not waste time on them:

- SML tags spoken aloud in batch endpoint → batch now calls `_parse_sml_tags()` per chunk
- Chunk size too large (800 chars) → reduced to 600 chars
- No cancellation in retry loop → cancellation check added inside batch retry
- No rate limiting → in-memory rate limiter on POST /api/jobs (5/60s per IP)
- No audio upload validation → magic bytes check + min 10KB + max 10MB
- Non-functional landing page buttons → removed dead About/Examples buttons
- No delete job button → added to queue page for failed/completed jobs
- No job deduplication → checks for existing "ready" job with same PDF+voice+clip
- No voice preview → "Test this voice" button calls single-generate endpoint with sample text
- No chapter navigation → chapters JSONB column + clickable chapter list in player
- No voice favorites → Saved tab on voice page, auto-saves on job creation
- Static batch size → dynamic (8/12/16 based on section count)
- Resources page said "30-60s ideal" → fixed to "15-30s"
- startTime/endTime not clamped → max 30s in validation schema
- ETA missing from queue → estimateTimeRemaining() displayed on processing jobs
- videoId missing from retry → now passed in retry request body

## What to Focus On

### 1. Race Conditions & Concurrency
- The generation function runs as fire-and-forget async. What happens if a user cancels and immediately retries? Could two generation functions run for the same job?
- Supabase realtime updates — could stale payloads overwrite fresher state?

### 2. Edge Cases in Generation Pipeline
- `generate-audiobook-v2.ts` is ~1360 lines. Trace the full path for: partial batch failure, checkpoint corruption, voice sample download failure after job creation, text extraction returning empty string.
- What happens if the Modal TTS server returns fewer results than texts sent in a batch?

### 3. Security
- All API routes use `user_id: "anonymous"`. No auth. What can an unauthenticated user do beyond rate limits?
- The service role key is used server-side. Is there any path where it could be exposed to the client?
- Supabase RLS policies are `using (true)` — wide open. Is this acceptable for launch?

### 4. Cost & Performance
- Each "Test Voice" preview call hits the Modal GPU. Could a user spam this?
- The Emotion Director LLM is called for every chunk. Is there a way to batch or skip it for monotone text?
- Audio buffers are held in memory until concatenation. At what book size does this become a problem on Vercel?

### 5. Data Integrity
- The `chapters` JSONB column was just added. Is the migration safe for existing rows? What if `chapters` is null vs empty array?
- Voice deduplication checks `voice_storage_path` as string equality — but paths can be comma-separated for multi-reference. Does this break?
- The retry flow deletes the old job and creates a new one. What happens to the old job's checkpoints and storage files?

### 6. Frontend State Management
- The clip page uses URL search params for state (`pdfPath`, `voicePath`, `videoId`). What happens if the user refreshes? If they navigate back and forward?
- The player page has both a fetch effect and a realtime subscription. Could they conflict?
- The queue page fetches jobs on mount but also subscribes to realtime. Could a realtime update and the initial fetch race?

### 7. Modal Server Specifics
- `f5_tts_server_fixed.py`: The `_lock` serializes all `infer` calls. Is this necessary? Could it be a bottleneck for batch requests?
- The batch endpoint now splits each text into SML segments and calls `infer` per segment. For a batch of 16 texts each with 3 segments, that's 48 sequential infer calls. Is this acceptable?
- Whisper model is loaded per request (`WhisperModel("base")`). Should it be cached like the TTS model?

## Key Files to Read

```
src/lib/generate-audiobook-v2.ts          # Core generation pipeline (~1360 lines)
modal/f5_tts_server_fixed.py              # TTS server (~670 lines)
src/app/api/jobs/route.ts                 # Job creation with dedup + rate limit
src/app/api/jobs/[id]/cancel/route.ts     # Cancel endpoint
src/app/api/jobs/[id]/route.ts            # Delete endpoint
src/app/api/voice/preview/route.ts        # Voice preview (new)
src/app/api/voices/route.ts               # Voice favorites CRUD (new)
src/app/api/audio/upload/route.ts         # Audio upload with magic bytes validation
src/app/api/youtube/download/route.ts     # YouTube audio download
src/app/dashboard/voice/clip/page.tsx     # Clip selection + test voice + auto-save
src/app/dashboard/voice/page.tsx          # Voice selection with Saved tab
src/app/dashboard/player/[id]/page.tsx    # Player with chapter navigation
src/app/dashboard/queue/page.tsx          # Queue with ETA, delete, cancel
src/lib/validation.ts                      # Zod schemas
src/lib/errors.ts                          # AppError + handleApiError
src/lib/errors-ui.ts                       # User-friendly error mapping
src/lib/voice-quality-checker.ts           # Voice sample analysis
src/lib/supabase/types.ts                  # TypeScript types (includes ChapterMarker)
supabase/schema.sql                        # DB schema with chapters column
```

## Output Format

For each issue found:
1. **Severity**: 🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low
2. **File + line**: Exact location
3. **Description**: What's wrong and why it matters
4. **Suggested fix**: Concrete code change or approach

Do NOT suggest:
- Switching from F5-TTS to another TTS model
- Adding authentication (known, out of scope for this audit)
- Rewriting the architecture
- Features that already exist (see "Already Fixed" list)
