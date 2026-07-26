# Echomancer v2 — Third-Pass Audit Prompt

You are a senior code auditor. Two previous audit passes identified and fixed ~30 issues across this codebase. Your job is to perform a fresh, thorough audit to:
1. Verify the V2 fixes are correct and complete.
2. Find any regressions introduced by the V2 fixes.
3. Identify any remaining or new issues not caught in prior passes.

## Context

Echomancer v2 is a PDF-to-audiobook app. Stack: Next.js 16, Turso (LibSQL), Cloudflare R2, OpenRouter (TTS gateway). All voices route through OpenRouter. Two generation paths: **stream** (live listen) and **take-home** (offline full download with section-by-section synthesis).

## What was changed in the second pass (V2 fixes)

### Critical
1. **C1 — `process-job.ts`**: Added `processing_started_at` column + stale job re-claim. The atomic claim `UPDATE` now matches `status = 'queued' OR (status = 'processing' AND processing_started_at IS NOT NULL AND unixepoch() - processing_started_at > 600)`. Also clears `processing_started_at` when setting back to `queued`.
2. **C2 — `process-job.ts`**: Existing ready sections now advance `nextIndex = i + 1` before `continue`, fixing an infinite loop.
3. **C3 — `stream-session.ts`**: Catch block now detects `AbortError`/`signal.aborted` and sets status to `queued` (with cursor/used persisted) instead of `failed`. Non-abort errors still set `failed`.
4. **C4 — `voices.json`**: Removed all 9 Google WaveNet and Neural2 static voices (model slugs `google/wavenet`, `google/neural2` are not valid OpenRouter IDs). Only Gemini (`google/gemini-2.5-flash-tts`) and Grok (`xai/grok-tts`) voices remain.
5. **C5 — `stream-session.ts` + `types.ts`**: Added `streamContentType?: string` to `TtsProviderAdapter`. Stream session now uses `provider.streamContentType || "audio/mpeg"` instead of hardcoding.

### High
6. **H1 — `process-job.ts`**: Wrapped the section synthesis loop in `try/catch`. On unexpected error, resets job to `queued` (with `WHERE status = 'processing'` guard) and re-throws. Provider/voice resolution errors now call `updateJob({ status: "failed" })` instead of throwing.
7. **H2 — `process-job.ts`**: `scheduleTakehomeContinue` now awaits `fetch()` with 3 retry attempts (1s/2s backoff) instead of fire-and-forget.
8. **H3 — `openrouter.ts`**: `synthesizeOpenRouter` now returns the real content type from the response header, normalized to `audio/wav`, `audio/ogg`, `audio/pcm`, or `audio/mpeg`.
9. **H4 — `rate-limit.ts`**: Replaced separate `INSERT ... ON CONFLICT DO UPDATE` + `SELECT` with a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` for atomic read-after-increment.
10. **H5 — `jobs/route.ts` + `takehome/route.ts`**: Both now check `isHdVoice(catalog) && !isPremiumHdEnabled({ ip })` and reject with 403.
11. **H6 — `stream-session.ts`**: Added atomic stream claim: `UPDATE jobs SET status = 'processing' WHERE id = ? AND (status IN ('queued', 'ready') OR status = 'processing')`. Rejects if `rowsAffected === 0`.
12. **H7 — `storage/index.ts`**: `fileExists` now delegates to `getFileMetadata` (which uses `HeadObjectCommand` for R2) instead of downloading the entire file.
13. **H8 — `jobs/[id]/route.ts`**: DELETE now parses `segments_json`, collects all segment paths, lists `audiobooks/<id>/` prefix in R2, and deletes everything. Removed old local filesystem `checkpoints` cleanup.
14. **H9 — `jobs/route.ts` + `jobs/[id]/route.ts`**: Removed `pdf_storage_path`, `audio_storage_path`, `user_id` from public API responses. Added `audio_url` (safe `/api/storage/` path) instead.
15. **H10 — New `/api/jobs/[id]/download/route.ts`**: Concatenates all ready segments into a single MP3 stream for download. Frontend download button updated to use this endpoint.

### Medium
16. **M1 — `schema-migrate.ts`**: Added `processing_started_at`, `total_sections`, `current_section`, `audio_storage_path`, `error_message`, `deleted_at` to migration column list. Only sets `migrated = true` when all ALTERs succeed. Ignores duplicate-column errors but logs others.
17. **M4 — `stream-session.ts`**: Only advances `localCursor`/`localUsed` when `!signal?.aborted` or when `windowDelivered` is true on partial delivery.
18. **M6 — `process-job.ts`**: Added `isNonRetryable()` check — skips remaining retry attempts if previous error matches `/40[0134]|invalid|bad request/i`.
19. **M7 — `voices/route.ts`**: POST single-voice lookup now applies `isHdVoice`/`isPremiumHdEnabled` filter, returning 403 if HD and premium is off.
20. **M9 — `health/route.ts`**: Simplified to only return `{ status: "healthy" | "degraded" }` without per-service details or OpenRouter API calls.
21. **M10 — `voice/analyze/route.ts`**: Added rate limiting (3 req/min per IP) and 10MB file size limit.

### Low
22. **L1 — `rate-limit.ts`**: `tableEnsured` only set to `true` inside the `try` block after successful `CREATE TABLE`.
23. **L2 — `r2-storage.ts` + `turso.ts`**: `dotenv.config()` only called when `process.env.NODE_ENV !== "production"`.
24. **L4 — `stream-session.ts`**: Rejects with error if `job.status === "failed"` before starting a stream.

## Audit checklist

### 1. Verify V2 fix correctness
For each change above, verify:
- The fix actually solves the stated problem.
- No regressions or edge cases were introduced.
- Error paths are handled correctly.
- The fix is complete (not partial).

### 2. Concurrency control (`process-job.ts`)
- The stale re-claim uses `processing_started_at > 600` seconds. Is 600s appropriate given Vercel's 300s `maxDuration`? Could a legitimate long tick be re-claimed while still running?
- The `try/catch` in the section loop resets to `queued` on error. But what if the error happens after some sections in the current tick succeeded? Those sections are already persisted in `segments_json` and `next_section_index` — will the re-claim correctly skip them?
- `scheduleTakehomeContinue` now awaits with retries. But it's called from `process/route.ts` which is itself a Vercel function. Does awaiting the next tick's fetch extend the current function's lifetime? Could this cause cascading timeouts?
- The `isNonRetryable` function is defined but is it actually called in the retry loop? Check the control flow carefully.
- After a failed tick resets to `queued`, who triggers the next tick? Is there a watchdog, or does it rely on the next `scheduleTakehomeContinue` call?

### 3. Stream session (`stream-session.ts`)
- The H6 atomic claim uses `status IN ('queued', 'ready') OR status = 'processing'`. This means a second concurrent stream CAN claim a job that's already `processing`. Is this intentional? It doesn't actually prevent concurrent streams — it just prevents claiming terminal-state jobs.
- The abort handler sets status to `queued` — but what if the stream was already `ready` (finished book/budget)? The abort path would regress it back to `queued`. Check the status logic in the abort branch.
- The `windowDelivered` flag is set to `true` on the first `yield`. But `yield` doesn't guarantee the chunk was actually sent to the client — it could be buffered. Is this a meaningful distinction?
- The final status update uses the same expression for both `aborted` and non-aborted cases: `aborted ? (finishedBook || budgetDone ? "ready" : "queued") : (finishedBook || budgetDone ? "ready" : "queued")`. This is redundant — was the intent to have different logic?
- `logUsage` is skipped when aborted. Is this correct? The characters were still sent to the provider and billed.

### 4. Rate limiter (`rate-limit.ts`)
- The `RETURNING count` clause — is this supported by Turso/LibSQL? Verify that LibSQL supports `RETURNING` on `INSERT ... ON CONFLICT DO UPDATE`.
- The `ensureTable` function no longer sets `tableEnsured = true` on error. But `ensureTable` is called on every rate limit check. If the DB is permanently unavailable, this means a `CREATE TABLE` attempt on every request. Is this acceptable performance-wise?
- The cleanup uses `Math.random() < 0.05` — in serverless, each invocation is independent. Could this never fire under low traffic?

### 5. Premium HD gate
- The H5 fix checks `isHdVoice(catalog)` in `jobs/route.ts`. But what if `catalog` is `undefined` (user provides `ttsProvider` + `providerVoiceId` directly without `catalogVoiceId`)? Can a user bypass the gate by providing raw provider/voice IDs?
- The `takehome/route.ts` HD check uses the parent job's `catalog_voice_id`. What if the parent was created before the gate was added?
- Are there any other entry points that create jobs or trigger synthesis with a voice selection?

### 6. Storage and R2
- `fileExists` now delegates to `getFileMetadata`. But `getFileMetadata` returns `null` on error, and `fileExists` returns `meta !== null`. Is there a case where `getFileMetadata` returns `null` for an existing file (e.g. transient R2 error)?
- The H8 DELETE route lists `audiobooks/<id>/` prefix. But segment paths are stored as `audiobooks/<jobId>/sections/0000.mp3`. Does the `listFiles` call correctly find all segments?
- The new download route (`/api/jobs/[id]/download`) downloads each segment into memory and enqueues it. For a large book (50+ segments, 100MB+), this could OOM the Vercel function. Should it stream instead?
- The download route doesn't check `job.status === "ready"` — it just checks if segments exist. Could a user download a partial audiobook while it's still processing? Is that intentional?

### 7. API response shape changes (H9)
- The frontend player page references `job.audio_storage_path` and `job.user_id` in its TypeScript interface. Are these fields still expected by the frontend? Will removing them cause runtime errors or TypeScript build failures?
- The `formatJobRow` function in `jobs/route.ts` now returns `audio_url` and `stream_url`. Does the frontend queue page use these new fields?
- The single-job GET (`jobs/[id]/route.ts`) also excludes `pdf_storage_path` now. Does any frontend code need this field (e.g. for re-upload, retry, or display)?

### 8. Schema migration (`schema-migrate.ts`)
- The new columns added to the migration list (`processing_started_at`, `total_sections`, `current_section`, `audio_storage_path`, `error_message`, `deleted_at`) — were these already present in the DB schema? If not, will the ALTER ADD COLUMN work correctly with existing data?
- The `allOk` flag is set to `false` on non-duplicate-column errors. But the loop continues to try remaining columns. Is this correct? Should it abort early?
- `migrated` is module-level. In serverless, each cold start re-runs the migration. The `migrated` flag only prevents re-running within the same invocation. Is this acceptable?

### 9. OpenRouter provider (`openrouter.ts`)
- The content type normalization maps `wav`, `ogg`, `pcm`, and defaults to `mpeg`. Are there other content types OpenRouter might return (e.g. `flac`, `opus`, `webm`)?
- The `streamContentType` is set to `"audio/mpeg"` on the provider. But the actual stream response could have a different content type. Should the stream path also check the response headers?
- The `response_format: "mp3"` in the request body — does this guarantee the response is always MP3? If so, is the content type normalization in `synthesizeOpenRouter` unnecessary?

### 10. Static voice catalog (`voices.json`)
- After removing Google WaveNet/Neural2 voices, only Gemini (5 voices) and Grok (5 voices) remain — 10 total. Is this enough variety? Are there OpenRouter-hosted voices that should be added?
- The Gemini voices use `google/gemini-2.5-flash-tts` as the model slug. Is this a valid OpenRouter model ID? Verify against the live OpenRouter models API.
- The Grok voices use `xai/grok-tts`. Same question — is this valid on OpenRouter?
- The `provider` field for Gemini voices is `"gemini"` and for Grok is `"grok"`. But `resolveStockAdapter` always returns the OpenRouter adapter. Is the `provider` field misleading or unused?

### 11. Frontend
- The download button now uses `/api/jobs/${job.id}/download`. Does this endpoint exist and work? Test the route.
- The player page's `Job` interface still has `audio_storage_path: string | null`. Will this cause a TypeScript error since the API no longer returns it?
- The queue page references `audio_storage_path` — check if it needs updating.
- Are there any other frontend pages that reference removed fields (`pdf_storage_path`, `user_id`, `audio_storage_path`)?

### 12. Security
- The health endpoint no longer leaks infra details. But is it still useful for monitoring? Should it require auth?
- The voice analyzer endpoint now has rate limiting + file size limit. But it still accepts unauthenticated requests. Is this acceptable?
- The job list endpoint (`GET /api/jobs`) is still unauthenticated and lists all jobs. Should it require auth or at least pagination tokens?
- The download endpoint (`GET /api/jobs/[id]/download`) is unauthenticated. Anyone with a job UUID can download the audiobook. Is this acceptable?
- The stream endpoint (`GET /api/jobs/[id]/stream`) is unauthenticated. Same concern.
- Are there any new SQL injection risks in the new/modified queries?

### 13. Edge cases and error handling
- What happens if `scheduleTakehomeContinue` is called but `INTERNAL_JOB_SECRET` is not set? The process route will reject it in production.
- What happens if a job's `pdf_storage_path` points to a file that no longer exists in R2? The `loadBookText` call will throw. Is this handled by the H1 try/catch?
- What happens if `splitTextForTts` returns 0 sections for a non-empty file (e.g. file contains only whitespace)?
- The download route concatenates segments as raw bytes. MP3 files can be concatenated this way, but WAV/OGG/FLAC cannot. If segments are not MP3, the download will produce a corrupt file.

### 14. Environment and deployment
- Are all new env vars (if any) documented in `AGENTS.md`?
- Does the new `processing_started_at` column need to be in `AGENTS.md`?
- Does the download route work in dev (local storage) mode?
- Does the `listFiles` function work correctly for R2 with the `audiobooks/<id>/` prefix?

## Output format

For each finding, provide:
- **ID**: A unique identifier (e.g. V3-01)
- **Severity**: Critical / High / Medium / Low
- **File**: Path and line numbers
- **Description**: What the issue is
- **Impact**: What could go wrong
- **Suggested fix**: How to fix it, with code if possible

Group by severity. Start with Critical, then High, Medium, Low. If no issues found in a category, say "No findings."
