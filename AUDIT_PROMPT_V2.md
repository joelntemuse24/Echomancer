# Echomancer v2 — Second-Pass Audit Prompt

You are a senior code auditor. A previous audit identified and fixed 14 issues across this codebase. Your job is to perform a fresh, thorough audit to verify the fixes are correct, find any regressions they may have introduced, and identify any remaining or new issues.

## Context

Echomancer v2 is a PDF-to-audiobook app. Stack: Next.js 16, Turso (LibSQL), Cloudflare R2, OpenRouter (TTS gateway). All voices route through OpenRouter. Two generation paths: **stream** (live listen) and **take-home** (offline full download with section-by-section synthesis).

## What was changed in the first pass

1. **Deleted `src/app/api/debug/env/route.ts`** — was leaking env var metadata.
2. **Deleted `src/lib/storage.ts`** — legacy module with silent R2 fallbacks. Replaced by `src/lib/storage/index.ts`.
3. **`src/lib/storage/index.ts` `getFileMetadata`** — now uses R2 `HeadObjectCommand` when configured.
4. **`src/lib/r2-storage.ts`** — exported `getR2Client()`.
5. **`package.json`** — moved `dotenv` from `devDependencies` to `dependencies`.
6. **`src/lib/tts/schema-migrate.ts`** — idempotent migration: checks table exists, checks existing columns, only sets `migrated=true` on success.
7. **`src/lib/tts/providers/index.ts` `resolveStockAdapter`** — always returns `openrouterTtsProvider` when `OPENROUTER_API_KEY` is set, regardless of provider field.
8. **`src/lib/tts/catalog/voices.json`** — updated model slugs to OpenRouter format (`google/wavenet`, `google/neural2`, `google/gemini-2.5-flash-tts`, `xai/grok-tts`).
9. **`src/lib/tts/process-job.ts`** — added atomic concurrency claim (`WHERE status = 'queued'`), per-section retry (3 attempts, linear backoff), persists `total_sections` to avoid re-splitting, sets status back to `'queued'` after partial tick.
10. **`src/lib/tts/stream-session.ts`** — passes `AbortSignal` to `provider.synthesizeStream()`, removed hardcoded `contentType` variable.
11. **`src/lib/tts/types.ts`** — added optional `signal?: AbortSignal` to `SynthesizeInput`.
12. **`src/lib/tts/providers/openrouter.ts`** — passes `signal` to `fetch()` in `streamOpenRouter`.
13. **`src/lib/rate-limit.ts`** — replaced in-memory Map with Turso-backed rate limiter using `rate_limits` table with `INSERT ... ON CONFLICT DO UPDATE` upsert counting. Fails open on DB errors.
14. **`src/app/api/tts/preview/route.ts`** — added rate limiting (5 req/min per IP).
15. **`src/app/api/tts/voices/route.ts`** — filters out HD voices server-side when `isPremiumHdEnabled` returns false.
16. **`src/app/api/storage/[[...path]]/route.ts`** — changed `Cache-Control` from `public` to `private`, removed unused `downloadFileStream` import, fixed `any` types.
17. **`src/app/api/jobs/[id]/webhook/route.ts`** — rejects requests with 503 in production when `WEBHOOK_SECRET` is unset.
18. **`src/app/api/jobs/[id]/process/route.ts`** — rejects requests in production when `INTERNAL_JOB_SECRET` is unset.
19. **`src/lib/tts/split-text.ts`** — lowered `maxChars` minimum floor from 100 to 10.
20. **`AGENTS.md`** — updated env var reference with all required and optional variables.
21. **Various lint fixes** — `prefer-const`, `no-explicit-any`, `react-hooks/purity`, `react-hooks/set-state-in-effect` across `theme-toggle.tsx`, `sidebar.tsx`, `r2-storage.ts`, `text-extraction.ts`, `stream-session.ts`.

## Audit checklist

### 1. Verify fix correctness
For each change above, verify:
- The fix actually solves the stated problem (not just papering over it).
- No regressions or edge cases were introduced.
- Error paths are handled (e.g. what if Turso is down during rate limiting? what if R2 HeadObject fails? what if the atomic claim races with a terminal state update?).

### 2. Concurrency control deep-dive (`process-job.ts`)
- Trace the full lifecycle: job created as `'queued'` → tick claims `'queued'→'processing'` → synthesizes K sections → sets back to `'queued'` → `scheduleTakehomeContinue` fires next POST.
- What happens if the function times out (Vercel 300s limit) mid-section? The job stays `'processing'` forever — is there a recovery mechanism?
- What happens if `scheduleTakehomeContinue`'s `fetch()` fails silently? The job is stuck in `'queued'` — is there a watchdog?
- Is the `WHERE status = 'queued'` claim safe under Turso's eventual consistency? Could two instances both see `'queued'` and both succeed?

### 3. Rate limiter correctness (`rate-limit.ts`)
- The `rate_limits` table uses `INSERT ... ON CONFLICT(key, identifier) DO UPDATE SET count = count + 1`. Is this atomic under LibSQL/Turso?
- The `key` includes a time window (`${max}:${windowMs}:${windowStart}`). Does this correctly bucket requests into fixed windows?
- The `ensureTable` function sets `tableEnsured = true` even if the `CREATE TABLE` throws. Is this intentional? Could it mask a persistent DB error?
- The cleanup uses `Math.random() < 0.05` — is this safe in serverless? Could it never fire if traffic is low?
- Two separate `execute` calls (upsert + select) — could a concurrent request increment between them, causing the select to return a higher count than expected?

### 4. Stream session (`stream-session.ts`)
- The `signal` is now passed to `provider.synthesizeStream()`. But what about the `execute()` calls inside the iterator? If the client disconnects, the DB updates after `signal?.aborted` break may still run — is this correct behavior?
- `contentType` is hardcoded to `"audio/mpeg"` — is this always correct for OpenRouter? What if a provider returns WAV or PCM?
- The stream sets status to `'processing'` before iterating. If the client never connects (or disconnects immediately), does the job stay `'processing'` forever?

### 5. OpenRouter routing (`providers/index.ts`, `voices.json`)
- `resolveStockAdapter` always returns `openrouterTtsProvider` when the key is set. But the `model` slug comes from `catalog.model` or `ttsOptions.model`. Are all static voice model slugs valid OpenRouter model IDs?
- What happens if a user picks a voice whose model slug doesn't exist on OpenRouter? Is the error message helpful?
- The live catalog fetch from OpenRouter (`listOpenRouterSpeechModels`) — do those voices' model slugs match what `synthesizeOpenRouter` sends as `model`? Is there a mismatch between catalog model IDs and synthesis model IDs?

### 6. Premium HD gate (`voices/route.ts`, `premium.ts`)
- `isHdVoice` checks for `minimax`, `speech-02`, `speech-01` in the model name, or `hd` tag. Are there other HD models that should be gated?
- The gate only filters the `GET /api/tts/voices` response. Can a user bypass it by directly specifying a `catalogVoiceId` when creating a job? Check `src/app/api/jobs/route.ts`.
- The `POST /api/tts/voices` endpoint (single voice lookup) — does it also filter HD voices?

### 7. Security review
- Are there any remaining endpoints that expose sensitive data or lack auth in production?
- Check all API routes under `src/app/api/` for auth patterns — which ones should be public vs internal vs authenticated?
- The `INTERNAL_JOB_SECRET` check in `process/route.ts` — does `scheduleTakehomeContinue` always send the secret? What if it's not set in dev?
- Path traversal in the storage route — is the check sufficient? What about encoded paths (`%2e%2e`)?
- Is there any injection risk in the SQL queries? All use parameterized queries?

### 8. Storage and R2
- `downloadFileStream` in `storage/index.ts` only supports local filesystem — it doesn't check `isR2Configured()`. Is it called anywhere in production code paths?
- `fileExists` in `storage/index.ts` calls `r2GetFile` which downloads the entire file just to check existence. Should it use `HeadObjectCommand` instead?
- The storage API route loads the entire R2 file into memory (`r2GetFile` returns a Buffer) even for range requests. Is this a memory concern for large audiobooks?
- Is there cleanup of partial audiobook segments in R2 when a job fails?

### 9. Schema migration (`schema-migrate.ts`)
- The `migrated` flag is module-level. In serverless, each function invocation may have a fresh module. Does this mean `ensureTtsJobColumns` runs on every request? Is that a performance concern?
- The `pragma_table_info` query — is this supported by Turso/LibSQL?

### 10. Pricing accuracy (`pricing.ts`)
- Verify `estimatePriceEur` uses correct character counts and rates.
- Does the pricing account for OpenRouter's pricing model (per-char vs per-token vs per-audio-hour)?
- Are Minimax HD voices priced differently from stock voices?

### 11. Frontend
- Does the voice browser UI correctly handle the filtered HD voices list?
- Does the player correctly handle multi-section audiobooks (segments_json)?
- Are there any API calls to deleted routes (e.g. debug/env)?
- Does the job creation flow correctly pass `catalogVoiceId` and handle the response?

### 12. Environment and deployment
- Are all env vars documented in `AGENTS.md` actually used in the code?
- Are there any env vars used in code but not documented?
- Is `dotenv` imported correctly in production? Does it load `.env.local` or `.env`?
- Check `next.config` for any issues with the build configuration.

## Output format

For each finding, provide:
- **ID**: A unique identifier (e.g. V2-01)
- **Severity**: Critical / High / Medium / Low
- **File**: Path and line numbers
- **Description**: What the issue is
- **Impact**: What could go wrong
- **Suggested fix**: How to fix it, with code if possible

Group by severity. Start with Critical, then High, Medium, Low. If no issues found in a category, say "No findings."
