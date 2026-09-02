# Echomancer v2 — Technical Design (Code Walkthrough)

**Audience:** someone who will open the repo and follow along. This document is
organized as a **map of the code**, not a product brief. Every important module
is named; every major export is explained; end-to-end flows are traced through
concrete files and functions.

**Live app:** [echomancer-v2.vercel.app](https://echomancer-v2.vercel.app)

**Companion docs:** `AGENTS.md` (agent/ops cheat sheet), `DEPLOYMENT.md`,
`TURSO_R2_SETUP.md`, `README.md`.

---

## Table of Contents

1. [What the product is (one page)](#1-what-the-product-is-one-page)
2. [Repository map](#2-repository-map)
3. [Request lifecycle](#3-request-lifecycle)
4. [Identity & sessions](#4-identity--sessions)
5. [Ownership guards](#5-ownership-guards)
6. [Rate limiting](#6-rate-limiting)
7. [Database (Turso)](#7-database-turso)
8. [Schema & runtime migrations](#8-schema--runtime-migrations)
9. [Uploads & text extraction](#9-uploads--text-extraction)
10. [Storage abstraction (local + R2)](#10-storage-abstraction-local--r2)
11. [Storage HTTP proxy](#11-storage-http-proxy)
12. [Voice catalog](#12-voice-catalog)
13. [Personas, accents, style honesty](#13-personas-accents-style-honesty)
14. [TTS providers](#14-tts-providers)
15. [Audio formats & silence guards](#15-audio-formats--silence-guards)
16. [Jobs API — create & list](#16-jobs-api--create--list)
17. [Job detail, cancel, retry, delete](#17-job-detail-cancel-retry-delete)
18. [Live stream path](#18-live-stream-path)
19. [Take-home worker (leases, ticks, waves)](#19-take-home-worker-leases-ticks-waves)
20. [Download & concatenation](#20-download--concatenation)
21. [Pricing & ETA](#21-pricing--eta)
22. [Frontend surfaces](#22-frontend-surfaces)
23. [Errors & UX copy](#23-errors--ux-copy)
24. [Testing](#24-testing)
25. [Environment & deployment knobs](#25-environment--deployment-knobs)
26. [Invariants checklist](#26-invariants-checklist)
27. [Glossary](#27-glossary)

---

## 1. What the product is (one page)

Echomancer turns an uploaded document into listen-able audio via **stock TTS**
(primarily OpenRouter speech models). There is no self-hosted TTS and no voice
cloning.

Two customer paths, one pipeline:

| Customer language | `job_kind` | What the code does |
|-------------------|------------|--------------------|
| Live Stream | `stream` | Pipe provider audio live; cap chars/time; store **no** audio |
| Get the whole book | `takehome` | Split text → synthesize sections → store on R2 → concat |

`generation_mode` is always `"stock"` in v2.

Rough money: take-home price is dynamic from character count × voice rate
(`src/lib/tts/pricing.ts`). Product target ≈ **€4.50** for a typical novel —
not a hard ceiling.

---

## 2. Repository map

```
src/
  proxy.ts                     # Next.js middleware (anonymous session mint)
  app/
    page.tsx                   # Landing upload
    layout.tsx                 # Fonts, theme, toaster
    dashboard/
      layout.tsx               # Nav shell
      voice/page.tsx           # Narrator picker + job create
      queue/page.tsx           # Library + polling
      player/[id]/page.tsx     # Playback
      resources/page.tsx       # Static how-to
    api/
      pdf/upload/              # JSON presign (tiny). Browser PUTs to R2.
      pdf/upload/[id]/         # complete + poll extraction
      pdf/upload/[id]/object/  # local PUT when R2 is unset
      jobs/                    # Create / list
      jobs/[id]/               # Detail / delete / retry
      jobs/[id]/stream/        # Live listen
      jobs/[id]/takehome/      # Promote stream → full book
      jobs/[id]/process/       # Internal worker (one job)
      jobs/[id]/download/      # Assembled file
      jobs/[id]/cancel/
      cron/process-jobs/       # Queue drain
      storage/[[...path]]/     # Ownership-gated file proxy
      tts/voices/              # Catalog
      tts/preview/             # Short paid preview
      health/
  lib/
    auth/{session,guard}.ts
    rate-limit.ts
    jobs/{serialize,worker-auth,trigger-takehome,trigger-extract,trigger-secrets}.ts
    turso.ts + turso/{jobs,uploads}.ts
    storage/index.ts + r2-storage.ts
    uploads/{extract,http,rate-limit}.ts
    text-extraction.ts + document-formats.ts + upload-client.ts
    tts/…                      # Entire synthesis stack
                               # speakable-text.ts (TTS script sanitizer)
                               # clone-sample-audio.ts (WAV PCM cleanup, no ffmpeg)
    validation.ts, errors.ts, errors-ui.ts, ux-copy.ts
  hooks/useAudioProcessor.ts
  test/{harness,setup-env}.ts
migrate-turso.sql              # Additive SQL mirror of runtime migrator
vercel.json                    # Empty schema on Hobby (no native cron)
```

---

## 3. Request lifecycle

```
Browser
  │
  ▼
src/proxy.ts
  • If SESSION_SECRET configured: read cookie / mint anon session
  • Overwrites request header x-ec-session with verified token
  • Sets ec_session cookie when newly minted
  │
  ▼
Route handler (App Router)
  • Re-verifies session via readSession() — never trusts header alone
  • Rate limit (Turso-backed)
  • Ownership / machine auth as needed
  │
  ├─► Turso (jobs, uploads, rate_limits, usage_logs)
  ├─► Storage (local FS or R2) via lib/storage
  └─► TTS (OpenRouter, optional direct adapters)
```

**Why proxy + re-verify:** proxy issues identity early so every page gets a
cookie; handlers re-HMAC-check so a forged `x-ec-session` cannot impersonate.

---

## 4. Identity & sessions

### `src/lib/auth/session.ts`

Anonymous-but-authenticated identity. No login product yet.

| Export | Role |
|--------|------|
| `SESSION_COOKIE` (`ec_session`) | httpOnly cookie name |
| `SESSION_HEADER` (`x-ec-session`) | Internal header proxy sets |
| `getSessionSecret()` | `SESSION_SECRET` → fallback `INTERNAL_JOB_SECRET` → **throws** in prod if missing; uses known dev secret locally |
| `isSessionConfigured()` | Boolean wrapper for proxy (must not throw) |
| `newAnonymousUserId()` | `anon_<32 hex>` |
| `signSessionToken()` | `v1.<userId>.<issuedAt>.<hmac>` |
| `verifySessionToken()` | Timing-safe HMAC; user id must match `anon_[0-9a-f]{32}` or `user_[\w-]{1,64}` |
| `mintSession()` | New id + token |
| `readSession(req)` | Header first, then cookie; always re-verifies |
| `readOrMintSession(req)` | Upload may mint on first visit |
| `attachSessionCookie(res, session)` | Sets cookie options (httpOnly, SameSite=Lax, Secure in prod, 1y) |

**Invariant:** production must not invent a random per-instance secret — that
would make every serverless isolate a different “you” and empty the library.

### `src/proxy.ts`

```ts
export async function proxy(request: NextRequest) {
  if (!isSessionConfigured()) return NextResponse.next();
  let session = await readSession(request);
  let minted = false;
  if (!session) { session = mintSession(); minted = true; }
  // overwrite header so clients cannot smuggle identity
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(SESSION_HEADER, session.token);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  if (minted) attachSessionCookie(res, session);
  return res;
}
```

Matcher skips Next static assets / favicon.

---

## 5. Ownership guards

### `src/lib/auth/guard.ts`

| Export | Behavior |
|--------|----------|
| `requireSession(req)` | No valid session → **401** `SESSION_REQUIRED` |
| `requireOwnedJob(req, id, columns?)` | Load non-deleted job; wrong `user_id` → **404** (not 403); missing → 404 |
| `ownsUploadPath(userId, path)` | Match `uploads.storage_path` or `source_path` |
| `ownsStoragePath(userId, path)` | `audiobooks/<jobId>/…` → `jobs.user_id`; `pdfs/<uploadId>/…` → `uploads.user_id`, with legacy fallback to jobs by `pdf_storage_path LIKE` |

**404 vs 401 vs empty list:**

| Situation | Response |
|-----------|----------|
| No session on owned job detail | 401 |
| Session but wrong/missing job | 404 |
| No session on `GET /api/jobs` | `[]` (empty library) |
| No session / wrong owner on `/api/storage` | 404 (avoid key probing) |

Projection rule for `requireOwnedJob`: callers may request columns, but must
always include fields they later read (`id`, `user_id`, …).

---

## 6. Rate limiting

### `src/lib/rate-limit.ts`

Counters live in Turso table `rate_limits` (not memory) because Vercel isolates
do not share RAM.

| Export | Role |
|--------|------|
| `createRateLimiter(max, windowMs, { onError })` | Fixed window; atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING count` |
| `rateLimitIdentity({ userId, ip })` | `u:<id>` or `ip:<sha256 truncated>` |
| `clientIp(req)` | `x-forwarded-for` first hop, else `x-real-ip` |

**Fail policy:**

- Costly routes (create, upload, stream, preview, catalog): `onError: "closed"` → deny if DB fails.
- Storage proxy: fail **open** so a Turso blip does not brick playback.

Typical caps (see each route): upload 10/min, jobs 5/min, preview 15/min, storage 600/min.

---

## 7. Database (Turso)

### `src/lib/turso.ts`

| Export | Role |
|--------|------|
| `getTursoClient()` | Singleton libSQL; needs `TURSO_DATABASE_URL` (+ optional `TURSO_AUTH_TOKEN`) |
| `query` / `queryOne` / `execute` | Thin wrappers |
| `transaction(fn)` | Write transaction with commit/rollback |
| `closeTursoClient()` | Test seam |

### `src/lib/turso/jobs.ts`

| Export | Role |
|--------|------|
| `getJob(id)` | Full non-deleted row; **no** ownership check |
| `updateJob(id, patch)` | Dynamic SET for status/progress/audio/error/… |
| `deleteJob(id)` | Soft delete: `deleted_at = unixepoch()` |
| `resetJob(id)` | Coarse requeue helper (route-level retry does a fuller reset) |
| `logUsage(…)` | Best-effort insert into `usage_logs`; **never throws** |

### `src/lib/turso/uploads.ts`

| Export | Role |
|--------|------|
| `recordUpload({ id, userId, storagePath, sourcePath, … })` | Ownership proof (paste + ready extracts) |
| `insertPendingUpload(…)` | Row created at presign (`status: pending`) |
| `getUploadForUser(userId, storagePath)` | Exact match on extracted `content.txt` path **and** `status = ready` — used by job create |
| `getUploadById` / `getUploadByIdForUser` | Worker and poll/complete |

---

## 8. Schema & runtime migrations

### `migrate-turso.sql`

Additive SQL for humans / ops. **Must not** `DROP TABLE jobs`. Mirrors what the
runtime migrator creates.

### `src/lib/tts/schema-migrate.ts`

| Export | Role |
|--------|------|
| `ensureTtsJobColumns()` | Idempotent: `CREATE TABLE IF NOT EXISTS` for `jobs`, `uploads`, `usage_logs`; indexes; `ALTER TABLE … ADD COLUMN` for every entry in `JOB_COLUMNS` |
| `resetSchemaMigrationCache()` | Tests |

Important columns on `jobs` (non-exhaustive):

- Identity: `id`, `user_id`, `deleted_at`
- Source: `book_title`, `pdf_storage_path`, `char_count`
- Voice: `tts_provider`, `provider_voice_id`, `catalog_voice_id`, `tts_options`, `voice_name`
- Kind: `generation_mode`, `job_kind` (`stream` \| `takehome`)
- Progress: `status`, `progress`, `current_section`, `total_sections`, `next_section_index`, `segments_json`
- Stream: `stream_cursor`, `stream_chars_used`, `stream_max_chars`
- Lease: `processing_lease_token`, `lease_expires_at`, `processing_started_at`, `generation_started_at`
- Output: `audio_storage_path`, `duration_seconds`, `price_estimate_eur`, `parent_job_id`, `error_message`

Statuses used in practice: `queued`, `processing`, `ready`, `failed`, `cancelled`.

Called at the top of upload/job/worker routes so cold DBs self-heal.

---

## 9. Uploads & text extraction

### `src/lib/document-formats.ts` (browser-safe)

Shared by landing page and upload route:

- `SUPPORTED_DOCUMENT_*`, `detectFormat(name, mime)`
- `maxUploadMb()` / `maxUploadBytes()` from `MAX_UPLOAD_MB` **and**
  `NEXT_PUBLIC_MAX_UPLOAD_MB` (keep both in sync — browser only sees the public one)
- Default cap **512 MB** (`DEFAULT_MAX_UPLOAD_MB`). This is a product ceiling for
  whole books and phone scans, **not** Vercel’s ~4.5MB function body limit.
  Keep `MAX_UPLOAD_MB` and `NEXT_PUBLIC_MAX_UPLOAD_MB` in sync. If either is
  still set to `25` in Vercel env, update both to `512`.

### `src/lib/text-extraction.ts` (server-only)

| Path | Library / tool |
|------|----------------|
| PDF | `unpdf` |
| EPUB | `epub2` (temp file) |
| DOCX | `mammoth` |
| TXT | UTF-8 |
| RTF | control-word strip |
| MOBI/AZW | Calibre `ebook-convert` if present |

Then normalizes: hyphenation across line breaks, page markers, soft wrap joins,
blank-line collapse. Rejects under `MIN_EXTRACTED_CHARS` (50).

### Speakable text — `src/lib/tts/speakable-text.ts`

`toSpeakableText` runs **after extract / paste, before `content.txt` is stored**
(and again when Whole book / Live Stream load the book, so older extracts stay
safe). Char counts and Fish spend then match what is spoken.

It strips emails (including spaced `name @ google . com` so Fish cannot spell
the domain or say “punct” for “.”), URLs, arXiv / DOI / ISSN / copyright lines,
and obvious academic cover metadata (author lists with footnote marks,
affiliations like “Google Brain”, venue lines like “31st Conference…” /
“Proceedings of”, Google figure-reproduction grants, “Equal contribution…”
credit blocks, and “Work performed while at …”) when the rest of the document
has body prose. Venue matching is **local** (not `[\\s\\S]*$` through EOF) so a
glued PDF paragraph cannot delete Abstract / Introduction. Glued academic
extracts are split at headings (Abstract, Introduction, Background, numbered
sections, Chapter/Part) **on the same line** so headings are never fused into
the next sentence. Long high-chars/sentence blocks get paragraph breaks back;
short “A sentence.” loops and already-broken novels are left alone. Title,
Abstract, Introduction, and real sentences stay. Novel bylines are not eaten.
Idempotent. Does **not** rewrite product copy. Does **not** insert Fish pause
tags — those are applied at synthesis time.

Wired from: `extractUploadedDocument`, `POST /api/text/upload`,
`loadBookText` (take-home), `createStreamAudioIterator` (Live Stream), and
optional Live Listen sample text on `/api/tts/live`.

### Narration script — `src/lib/tts/narration-script.ts`

Audiobook pacing is **pauses and phrasing**, not slower vowels. Fish S2
honors `[break]` (short) and `[long-break]` (extended) in the `text` field
([emotion / special-effect cues](https://docs.fish.audio/developer-guide/core-features/emotions)).
S1 `(break)`, blog `[pause]`, SSML `<break>`, and ffmpeg `atempo` are not used.

`toFishNarrationScript` takes speakable text and:

- puts `[long-break]` after headings and between paragraphs
- puts `[break]` between long academic sentences (high chars/sentence)
- leaves short dialogue untagged so it does not chop every beat
- is idempotent

`narrationScriptForSynthesis(text, providerId)` injects tags **only** for the
Fish adapter — OpenRouter / Gemini would speak the words. Live Stream cursor
still advances over the untagged speakable window so offsets do not drift.

Whole book Fish requests use `latency: "normal"` (API: most stable quality)
and `chunk_length: 300` (API max / default). Live Listen / Live Stream keep
`latency: "balanced"` for time-to-first-audio.

`src/lib/tts/narration-pace.ts` is a **light last-resort clamp** (0.9–1.0)
when a later section reports extreme WPM **and** pause ratio is not already
book-like. Default speed stays **1.0**. Never hardcoded 0.85. Never applied
by regenerating section 0. Persist optional `narrationSpeed` on `tts_options`.

Player pills (`src/lib/player/playback-speed.ts`) add listen-time **0.8** and
**0.9**. That is `HTMLAudioElement.playbackRate`, not Fish generation speed.

### Document upload — presign + R2 PUT + Trigger extract

Vercel never buffers the document. Hobby `FUNCTION_PAYLOAD_TOO_LARGE` is ~4.5MB.

1. **`POST /api/pdf/upload`** — JSON `{ fileName, contentType, byteSize }`
   - `readOrMintSession()`, fail-closed rate limit, format + ceiling checks
   - Inserts `uploads` row (`status: pending`) owned by the session
   - Returns `{ uploadId, putUrl, putHeaders, storagePath }`
   - Production: R2 presigned PUT (`getUploadUrl`). Dev/tests without R2:
     `putUrl` is `/api/pdf/upload/<id>/object`
2. **Browser `PUT putUrl`** — file bytes go to R2 (CORS required) or the local
   object route. Secrets never leave the server.
3. **`POST /api/pdf/upload/[id]`** — complete: HEAD the object (no download),
   mark `uploaded`, `tasks.trigger("upload.extract")`. Does **not** call
   `extractTextFromDocument`.
4. **`upload.extract`** on Trigger.dev — `downloadFile(source)` →
   `extractTextFromDocument` → `toSpeakableText` → write `content.txt` →
   `status: ready`
5. Landing page polls **`GET /api/pdf/upload/[id]`** until `ready` / `failed`
6. Job create still requires a **ready** `uploads` row for `content.txt`

Missing `TRIGGER_SECRET_KEY` in production → **503** at presign (before insert).
Local/tests without the key extract in-process from storage after complete.

Multipart `POST /api/pdf/upload` is rejected (`USE_PRESIGN`).

Missing session secret in production → **503** (deliberate).

### `POST /api/text/upload` — paste intake

Same ownership/storage contract without file extraction:

1. JSON `{ text, title? }` (50–500_000 chars after trim)
2. `toSpeakableText` then write `pdfs/<uuid>/content.txt` only
3. `recordUpload(format: "txt", fileName: title)`
4. Return `{ storagePath, fileName, charCount, source: "paste", … }`

Landing page offers **Upload** | **Paste text**; both continue to `/dashboard/voice`.

---

## 10. Storage abstraction (local + R2)

### `src/lib/storage/index.ts`

Single façade used by workers and upload:

| Export | Role |
|--------|------|
| `uploadFile(dir, name, data, contentType)` | R2 if configured, else FS |
| `downloadFile(path)` | Buffer |
| `deleteFile` / `listFiles` / `getFileMetadata` / `fileExists` | Same split |
| `getPublicUrl(path)` | Always `/api/storage/<path>` — never raw R2 URLs in the app |

Local root: `STORAGE_PATH` or `./data/storage` (dev) / `/tmp` on Vercel without R2.

### `src/lib/r2-storage.ts`

Configured when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
are set. S3-compatible client against Cloudflare R2. `getUploadUrl` mints a
short-lived **PUT** (Content-Type + Content-Length signed). `getFile` currently
**buffers the whole object** (known P2 leftover — range serving still goes
through the HTTP proxy after a full fetch). Browser PUTs require a bucket CORS
policy — see `TURSO_R2_SETUP.md`.

Path conventions:

```
pdfs/<uploadId>/source.<ext>
pdfs/<uploadId>/content.txt
audiobooks/<jobId>/sections/0000.mp3   # or .wav
audiobooks/<jobId>/full.mp3
```

Paths are predictable → **not** secrets; ownership is enforced in the proxy.

---

## 11. Storage HTTP proxy

### `GET /api/storage/[[...path]]` — `src/app/api/storage/[[...path]]/route.ts`

1. Reject empty / `.` / `..` / absolute segments
2. No session → **404**
3. Rate limit fail-open
4. `ownsStoragePath` → else 404
5. Optional `?download=` filename for `Content-Disposition`
6. Load from R2 or local; wrap `.pcm` as WAV; honor `Range` → 206

Headers: `Cache-Control: private, no-store`, `Accept-Ranges: bytes`.

---

## 12. Voice catalog

### Allowlist — `src/lib/tts/catalog/allowlist.ts`

- Allowed vendors: `google`, `qwen`, `minimax`, `microsoft`, `x-ai`, `xai`
- Hard-blocked substrings: `zonos`, `kokoro`, `deepgram`, `orpheus`, `sesame`,
  `voxtral`, `aura-`
- `MINIMAX_SEEDED_VOICES`: OpenRouter advertises empty voices for MiniMax;
  we seed known system voice IDs

### Live expansion — `src/lib/tts/catalog/openrouter-catalog.ts`

| Function | Role |
|----------|------|
| `usdPerMillionCharsForModel(modelId, pricingPrompt)` | Confirmed overrides first (Fish free 0 / Fish paid 15, MiniMax HD 100 / Turbo 60, MAI-Voice-2 22 / Flash 15, Qwen Plus 20 / Flash 15, Grok 15). Else derive `prompt × 1e6`; reject outside **$0.50–$500**/M and return `undefined` |
| `expandModel(model)` | One card per `(model × voice)`; Gemini English → 4 accent variants; others get native-locale accent only |
| `fetchOpenRouterCatalogVoices()` | List speech models → expand → sort by price |

### Catalog API — `src/lib/tts/catalog/index.ts`

| Function | Role |
|----------|------|
| `listCatalogVoices(filters)` | Fish-only slim catalog: Narrator (`fish-narrator`); clones merged in voices API |
| `getCatalogVoice(id)` | Static / `clone:…` (user-scoped) / `research:` / live `or:…` for legacy jobs |
| `getDefaultCatalogVoice()` | Fish Narrator (`fish-narrator`) |
| `isVoiceAvailable(voice, hdEnabled)` | Hide HD unless gate allows (fish clones always listed) |

### Fish voice cloning + live HTTP stream

| Piece | Role |
|-------|------|
| `FISH_API_KEY` | Native Fish API — create model + synthesize clones / Fish catalog |
| `POST /api/tts/clones` | Multipart sample → `cleanupCloneSample` → Fish `POST /model` → `cloned_voices` row. App max **10 MB**; Vercel POST still **413** above ~4.5 MB (`VERCEL_FUNCTION_BODY_LIMIT_BYTES`). |
| Catalog id | `clone:<uuid>` · provider `fish` · `providerVoiceId` = Fish reference id |
| Synth path | `resolveStockAdapter` → `fishTtsProvider` when `FISH_API_KEY` is set. Clones: `POST /v1/tts` with account `reference_id`. Stock Narrator: same endpoint **without** `reference_id` (Fish default S2.1 Pro Free voice). Never send OpenRouter catalog UUIDs as `reference_id`. |
| Live preview | `GET/POST /api/tts/live` opens Fish HTTP first, then pipes **chunked** MP3 (`latency=balanced`). Fish 4xx before bytes → JSON, never HTML `/500`. |
| Stream path | `synthesizeStream` yields Fish response body chunks (not a buffered unary clip) |
| Table | `cloned_voices` (session-scoped, soft-delete) |

Fish also has a WebSocket `/v1/tts/live` for LLM token streaming; Echomancer does
**not** proxy it — previews and listen already have full text, so HTTP chunked
streaming is enough and fits serverless.

### `GET /api/tts/voices`

Returns `{ voices, listenVoices, source, openRouterConfigured, researchPreview, slimCatalog, … }`
with optional price/ETA when `charCount` is passed. App ships a Fish-only slim catalog
(Narrator + session clones).

---

## 13. Personas, accents, style honesty

### `src/lib/tts/accent-prompt.ts`

| Export | Honesty rule |
|--------|--------------|
| `modelSupportsAccentVariants(modelId)` | **Only Gemini** → multi-accent cards + directed input |
| `modelSupportsStyleInstructions(modelId)` | OpenAI / Gemini / google; **false** for Minimax & Microsoft (and thus Qwen/Grok by omission) |
| `geminiDirectedInput(text, accent)` | Embeds accent in spoken input (short vs long form) |
| `narrationStylePrompt(accent)` | Soft copy — aggressive “IMPORTANT” prompts caused empty PCM |

### `src/lib/tts/resolve-style-prompt.ts`

Priority: explicit `ttsOptions.stylePrompt` → catalog `stylePrompt` →
locale/accent-derived narration prompt.

### `src/lib/tts/voice-persona.ts`

| Export | Role |
|--------|------|
| `stripVoiceIdDecorations` / `friendlyVoiceName` | Human labels from ugly provider ids |
| `inferAccent` | `accentHint` → locale → heuristics (**never** `qualityNotes`) |
| `inferVibe` | calm / warm / upbeat / smooth / dramatic / clear |
| `isListenFriendly` / `isTakehomeFriendly` | Live vs full-book curation |
| `enrichCatalogVoice` | Friendly name, accent, vibe, flags |
| `curateListenVoices` | Short diverse listen menu; one card per underlying voice |

### Where style is applied

Preview, stream windows, and `synthesizeSection` all gate:

```ts
stylePrompt =
  supportsDirection || !supportsStyle || attempt > 0
    ? undefined
    : resolveStylePrompt(...)
```

Gemini attempt 0 uses `geminiDirectedInput`; retries drop direction.

---

## 14. TTS providers

### `src/lib/tts/providers/index.ts`

```ts
resolveStockAdapter({ provider, model, catalogVoiceId })
// Fish clones + Fish catalog models (when FISH_API_KEY) → fish adapter
//   stock Narrator omits native reference_id; clones send it
// if OPENROUTER_API_KEY → openrouter adapter
// else direct google / gemini / grok
```

### `src/lib/tts/providers/openrouter.ts`

| Function | Role |
|----------|------|
| `listOpenRouterSpeechModels()` | `GET /models?output_modalities=speech`, ~10 min cache |
| `synthesizeOpenRouter` | POST `/audio/speech`; Gemini → PCM; others → MP3; `instructions` **only** for `openai/` models |
| `streamOpenRouter` | Same endpoint, streamed body |

**Do not** send a separate OpenRouter `prompt` for Gemini — empty PCM incident.

### Direct fallbacks

- `gemini.ts` — Google `generateContent`, L16 PCM → WAV wrap
- `google.ts` — Cloud TTS REST, MP3 (pseudo-stream = full buffer once)
- `grok.ts` — xAI TTS, MP3 stream

### Types — `src/lib/tts/types.ts`

`CatalogVoice`, `SynthesizeInput/Result`, `TtsProviderAdapter`, `JobSegment`,
`PriceEstimate`, `JobKind`, `StockProvider`.

---

## 15. Audio formats & silence guards

### `src/lib/tts/pcm-wav.ts`

- Detect raw PCM; parse `rate=` from content type
- `pcmToWav` / `ensureBrowserPlayable`
- `sniffAudioContentType` via magic bytes
- `stripWavHeader` for concatenation

### `src/lib/tts/clone-sample-audio.ts`

CPU-only WAV PCM cleanup on the clone POST path. **No ffmpeg / ffmpeg.wasm**
(bundle size + Hobby 60s + must not sit on the Vercel hot path).

| Export | Role |
|--------|------|
| `parseWavPcm` | 16-bit PCM WAV only; else `null` |
| `highPassPcm` | 4th-order high-pass (~100 Hz) to cut rumble / room boom |
| `noiseGatePcm` | Envelope gate on the quiet floor |
| `normalizePeakPcm` | Peak-normalize toward −1 dBFS (0.89) |
| `cleanupCloneSample` | WAV → mono PCM → filter → re-wrap WAV; **mp3/m4a/ogg passthrough** |

Fish `enhance_audio_quality` is still set; this pass just reduces room copied
into the clone. Browser-side trim/transcode can come later.

### `src/lib/tts/audio-guard.ts`

| Export | Role |
|--------|------|
| `isEmptyOrSilentAudio(buf)` | Too short, empty WAV data chunk, or all-zero payload |
| `isEmptyOrSilentStreamPayload(bytes, sawNonZero)` | Stream equivalent |
| `hasNonZeroByte` | Live stream early-exit from buffering |

Applied on **preview**, **take-home sections**, **stream windows**. Silence is
never stored as a successful segment and never advances the stream cursor.

### Split / window size

| Module | Role |
|--------|------|
| `speakable-text.ts` → `toSpeakableText` | Strip unspeakable tokens + academic cover; restore headings / paragraph breaks |
| `narration-script.ts` → `toFishNarrationScript` | Fish `[break]` / `[long-break]` at synth time (Fish adapter only) |
| `split-text.ts` → `splitTextForTts` | Paragraph → sentence → hard split under `maxChars` |
| `section-size.ts` | Catalog/model/provider ceilings; `STREAM_WINDOW_CHARS = 480` for TTFA |

---

## 16. Jobs API — create & list

### Validation — `src/lib/validation.ts`

- `uploadStoragePathSchema`: exact `pdfs/<uuid>/content.txt`
- `createJobSchema`: `mode: stock`, `jobKind`, path, optional voice fields, `charCount`, `parentJobId`

### `POST /api/jobs` — `src/app/api/jobs/route.ts`

**Enqueue only — never synthesizes.**

1. Session required (401)
2. Rate limit fail-closed
3. Zod parse
4. `getUploadForUser` — wrong path → 404
5. Resolve catalog / default voice; allowlist; HD gate (403)
6. Price estimate; reject non-takehome-friendly voices for full books
7. Dedupe: ready take-home with same user + PDF + `catalog_voice_id`
8. Insert `queued` row with `tts_options` JSON (model, stylePrompt, …)
9. Return ids + optional `stream_url`

### `GET /api/jobs`

Lists caller’s non-deleted jobs (empty if no session). If any take-home is not
ready → `nudgeStaleTakehomeJobs(1)` (lease sweep only when nudge budget is 0).

### Serialization — `src/lib/jobs/serialize.ts`

Browser-safe job JSON: ETA/elapsed labels, `/api/storage/…` audio URL, stream
URL only for `job_kind === "stream"`. **Hides** `pdf_storage_path`,
`tts_options`, lease tokens.

---

## 17. Job detail, cancel, retry, delete

### `GET /api/jobs/[id]`

`requireOwnedJob` → `nudgeStaleTakehomeJobIfNeeded` → reload → `serializeJob`.

### `POST /api/jobs/[id]/cancel`

Owned; rejects if already `ready`/`failed`; sets `cancelled`, clears lease
fields so a mid-wave worker cannot keep writing.

### `PATCH /api/jobs/[id]` `{ action: "retry" }`

Only `failed` → keep ready segments, set `next_section_index` to the lowest
unready index, clear error/lease → `queued` → `tasks.trigger("takehome.advance")`.

### `DELETE /api/jobs/[id]`

Owned; collect audio + segment paths; delete `audiobooks/<jobId>/…`; delete
`pdfs/<uploadId>/…` **only if no sibling job** shares `pdf_storage_path`; soft
delete job; best-effort file deletes.

### `POST /api/jobs/[id]/takehome`

Owned stream parent → spawn child take-home with same voice/text/`parent_job_id`
→ `tasks.trigger("takehome.advance")`.

---

## 18. Live stream path

### `GET /api/jobs/[id]/stream` — `src/app/api/jobs/[id]/stream/route.ts`

Ownership + rate limit → `createStreamAudioIterator` → `ReadableStream` to
client. Maps domain errors to 404 / 402 (`STREAM_BUDGET`) / 409 / 500 with
`userFriendlyError`.

### `src/lib/tts/stream-session.ts` — `createStreamAudioIterator`

1. Load job; must be `job_kind === "stream"`
2. Resolve voice + provider; load book text
3. Remaining budget = `stream_max_chars - stream_chars_used`
4. Slice from `stream_cursor`; split into ~480-char windows
5. **Claim** single reader: `status = processing` (allow reclaim if stale > 330s)
6. For each window (≤2 attempts):
   - Attempt 0: Gemini directed input if supported; style prompt only if steerable
   - Buffer until audible (or known silent) — then pass through for TTFA
   - PCM: emit one WAV header before first audio bytes
   - Silent → retry undirected; still silent → **throw, do not advance cursor**
   - Audible → update `stream_cursor`, `stream_chars_used`, `progress`
7. Finish: `ready` if book/budget done else `queued`; abort parks as `queued`

**Invariant:** cursor advances only after audible bytes.

---

## 19. Take-home worker (Trigger.dev + index-stable fan-out)

Whole book generation is hosted on **Trigger.dev Cloud**. The Next.js app on
Vercel only enqueues. Live Listen / Live Stream stay on Vercel.

### Trigger tasks — `src/trigger/takehome.ts`

| Task | Role |
|------|------|
| `takehome.advance` | Payload `{ jobId }`. Imports `runTakehomeUntilSettled` **in-process**. Does not HTTP `/process`. Loops until `ready` / `failed` / `cancelled` / `LeaseLostError`. Wave budget minutes (`TTS_TRIGGER_WAVE_BUDGET_MS`, default 900s). |
| `takehome.drain` | Cron `* * * * *`. Releases expired leases, lists queued + lease-expired processing, dedupes by `jobId`, triggers `takehome.advance`. |

Dispatch from Vercel (then 200 immediately): `POST /api/jobs` (takehome),
`POST /api/jobs/[id]/takehome`, `PATCH` retry. Helper:
`src/lib/jobs/trigger-takehome.ts` → `tasks.trigger("takehome.advance")`.

Missing `TRIGGER_SECRET_KEY` in production: `POST /api/jobs` takehome returns
**503** `TRIGGER_NOT_CONFIGURED` **before insert**. After a job row exists,
`tasks.trigger` failures are logged and the job stays `queued` for
`takehome.drain` (still HTTP 200). The Trigger runtime must have
`FISH_API_KEY`, Turso, R2, `INTERNAL_JOB_SECRET`
(`src/lib/jobs/trigger-secrets.ts`).

`TTS_POLL_NUDGE_BUDGET_MS` defaults to **0**. Polls may sweep leases; they
must not call Fish.

Trigger Cloud indexes `takehome.ts` by importing it, which loads Turso via
`@libsql/client` → `libsql`. That package `require`s `@libsql/linux-x64-gnu`
at import time (dynamic, not a static import). `trigger.config.ts` marks
`@libsql/client` / `libsql` as `build.external` and uses `additionalPackages`
so the worker image installs that native binary. `TRIGGER_PROJECT_ID` stays
an env fallback (`proj_echomancer`); do not hardcode the dashboard ref.

### Machine auth — `src/lib/jobs/worker-auth.ts`

| Function | Secret | Header |
|----------|--------|--------|
| `authorizeInternalWorker` | `INTERNAL_JOB_SECRET` | `x-internal-secret` |
| `authorizeCron` | `CRON_SECRET` Bearer **or** internal secret | |

Vercel `/process` and `/cron/process-jobs` remain operator fallbacks.

**No HTTP self-chaining** (caused Vercel 508). Continuation = lease + index cursor.

### Index invariant

The book is split **once**. Section `i` is a fixed slice of `content.txt`.
Work is claimed as a **set of indexes**. Each Fish call is bound to one index
before the request and writes only `sections/NNNN.mp3` for that index.
`segments_json` is a map `{ index, path, status }` upserted by index — never
appended in completion order. `next_section_index` = lowest index not yet
claimed. Ready-count (progress / `current_section`) is a different number.
Concat and download walk `0..N-1` and **refuse** `full.mp3` until every index
is ready. The player plays `0000`, then `0001`, … and waits — it does not skip.

Section 0 (and 1 when cheap) complete before the rest of the fan-out so the
player can start after one Fish round-trip.

### Parallel Fish

Starter account cap is **5** concurrent requests, shared with Live Listen /
Live Stream. Default take-home fan-out is **4**; **5** only when no live
request is in flight (`src/lib/tts/fish-slots.ts`). On **429**, honor
`Retry-After`. Never a sixth call. Model stays `s2.1-pro-free`. Latency is
`normal` (quality) on every Whole book attempt, with `chunk_length: 300`.
Live stays `balanced`. Direct Fish whenever `FISH_API_KEY` is set.

Hash cache (`src/lib/tts/section-cache.ts`): sha256 of section text + voice +
model + latency + speed + chunk length. Retry / second generate of the same
book hits. Tagged Fish scripts and `normal` vs `balanced` do not collide.

### `src/lib/tts/process-job.ts` — the heart

Env knobs (defaults):

| Env | Default | Meaning |
|-----|---------|---------|
| `TTS_LEASE_TTL_SECONDS` | 90 | Lease lifetime |
| `TTS_SECTIONS_PER_TICK` | fan-out | Max claim set (capped at 4/5) |
| `TTS_WORKER_WAVE_BUDGET_MS` | 240000 | Vercel fallback wave clock |
| `TTS_TRIGGER_WAVE_BUDGET_MS` | 900000 | Trigger Cloud wave clock |
| `TTS_TAKEHOME_FANOUT` | 4 or 5 | Pin; else 4 if live in flight |
| `TTS_MAX_TICKS_PER_WAVE` | 40 | Safety cap |
| `TTS_CRON_JOBS_PER_RUN` | 3 | Fallback cron batch |
| `TTS_POLL_NUDGE_BUDGET_MS` | 0 | UI poll synth budget; `0` = read-only |
| `TTS_RETRY_BACKOFF_MS` | 1000 | Between section attempts |

| Function | Role |
|----------|------|
| `claimTakehomeLease(jobId)` | Atomic UPDATE to `processing` + new token **only if** no active lease |
| `heartbeatLease` | Extend expiry while holding token |
| `writeWithLease` | Progress UPDATE … AND token = ?; 0 rows → `LeaseLostError` |
| `releaseLease` | Clear token; set queued/failed |
| `processTakehomeTick` | Claim → heartbeat → `runClaimedTick` → cleanup |
| `runClaimedTick` | Split once → claim index set → parallel synth (bound per index) → lease-scoped map write → materialize only when `0..N-1` ready |
| `synthesizeSection` | Fish script tags; cache lookup; `normal` + `chunk_length` 300; 429 waits; reject silence |
| `runTakehomeWave` | Loop ticks until done/busy/error/budget/max ticks |
| `runTakehomeUntilSettled` | Trigger host: waves until terminal |
| `drainTakehomeQueue` | Fallback: release expired → list queued → waves |
| `listDrainableTakehomeJobs` | Queued + lease-expired processing, deduped |
| `releaseExpiredTakehomeLeases` | Abandoned `processing` → `queued` |
| `nudgeStaleTakehomeJobs` / `nudgeStaleTakehomeJobIfNeeded` | Poll paths (lease sweep only when nudge=0) |

**Lease invariant:** two workers must never bill Fish for the same section.
Losing a lease mid-write abandons safely; successor resumes from the lowest
unready index (holes first). Ready files are not shifted.

Section storage: `audiobooks/<jobId>/sections/NNNN.<ext>`. Progress uses
ready-count, capped at 99 until final ready.

Helpers: `src/lib/tts/section-index.ts` (claim set, map upsert, concat
transcript). Required test: five dummy synths with random sleeps; concat
order is always `0,1,2,3,4`.

---

## 20. Download & concatenation

### `src/lib/tts/concat-audio.ts`

| Function | Role |
|----------|------|
| `readySegmentsSorted` | Ready segments by index |
| `concatReadySegments` | Same format only; WAV → strip headers + one final header; MP3/Ogg → naive byte join |
| `materializeFullAudiobook` | Upload `audiobooks/<jobId>/full.<ext>` |
| `isSectionStoragePath` | Detect `/sections/` vs full artifact |

Naive MP3 join is fine for constant-bitrate frames; fragile otherwise (known P2).

### `GET /api/jobs/[id]/download`

Owned; prefer full artifact; else concat on the fly; set `Content-Length`;
optional async backfill if ready job still points at a section path.

### `src/lib/download-client.ts`

Browser helper: fetch → blob → temporary `<a download>` → revoke URL.

---

## 21. Pricing & ETA

### `src/lib/tts/pricing.ts`

- COGS: `usdPerAudioHour` **or** `usdPerMillionChars` **or** fallback $15/M
- Retail: `cogsUsd * FX * markup + fixedEur`, floor `TTS_MIN_PRICE_EUR`, round to .49/.99
- `streamMaxChars()` from `STREAM_MAX_AUDIO_SECONDS` × chars/min (~54k default)

### `src/lib/tts/eta.ts`

Heuristic seconds/section by latency class; live ETA after ≥2 sections from
observed throughput; soft copy early (“usually under a minute”).

### `src/lib/tts/premium.ts`

`PREMIUM_HD_ENABLED` or allowlist IP/userId. `isHdVoice` via minimax / speech-02 /
`hd` tag.

---

## 22. Frontend surfaces

### Landing — `src/app/page.tsx`

Client format/size check → `uploadBookFile` (`src/lib/upload-client.ts`:
presign JSON → PUT to R2 → complete → poll extract) **or** paste →
`POST /api/text/upload` → redirect:

```
/dashboard/voice?pdfPath=…&pdfName=…&charCount=…
```

### Voice — `src/app/dashboard/voice/page.tsx`

- Intent: listen vs full (`ux-copy` language)
- `GET /api/tts/voices?charCount=`
- Live Listen: Fish / clones → `GET /api/tts/live` progressive MP3
- Live Stream / Whole book: `POST /api/jobs` → player (stream) or queue (takehome)

### Library — `src/app/dashboard/queue/page.tsx`

- `GET /api/jobs` every 3s while any job queued/processing **and** tab visible
- Cards are real links/buttons; progressbars + live regions
- Actions: cancel / retry / delete / download / listen URL selection by kind

### Player — `src/app/dashboard/player/[id]/page.tsx`

| Mode | Audio `src` |
|------|-------------|
| Stream | `/api/jobs/<id>/stream` (no seek; reconnect with `?t=` if budget remains) |
| Segments | `/api/storage/…/sections/NNNN…` (auto-advance) |
| Ready | `job.audio_url` |

Polls detail every 3s while active. Stream jobs can `POST …/takehome`.

### `src/hooks/useAudioProcessor.ts`

Minimal Web Audio: `MediaElementSource` → `GainNode`. Speed via
`playbackRate`. No EQ/compressor (pruned).

### Shell

`dashboard/layout.tsx`: Voice / Library / How it works. No broken `/player` nav
item. `ux-copy.ts` maps internal terms to customer language everywhere.

---

## 23. Errors & UX copy

### `src/lib/errors.ts`

`AppError(code, message, status)` + `handleApiError` (AppError / Zod / opaque 500).

### `src/lib/errors-ui.ts`

`userFriendlyError(raw)` maps provider/DB strings to safe copy (credits, DRM,
budget, HD gate, silence, cancel, timeouts, …). Long leaky strings → generic.

### `src/lib/ux-copy.ts`

Single place for “Live Stream” / “Live Listen” / “Get the whole book” / library status labels.

---

## 24. Testing

### `src/test/setup-env.ts`

Forces in-memory Turso, temp `STORAGE_PATH`, test secrets, `TTS_POLL_NUDGE_BUDGET_MS=0`,
clears R2/OpenRouter so tests stay offline.

### `src/test/harness.ts`

Real route handlers + real DB + real FS + **fake** TTS provider.
`seedUpload` / `seedJob` / `sessionCookieFor` / `buildRequest`.

| Suite | Proves |
|-------|--------|
| `ownership.test.ts` | Cross-session 404/401; storage proxy; upload binding; worker secrets |
| `pipeline.test.ts` | Upload → job → worker → download; resume; silence fail; HD gate |
| `pdf/upload.test.ts` | Presign JSON, reject over ceiling / multipart, extract off the Vercel body |
| `process-job.test.ts` | Lease races, heartbeat, reclaim, skip ready sections, index-stable fan-out |
| `section-index.test.ts` | Five dummy synths; concat transcript always 0,1,2,3,4 |
| `trigger-takehome.test.ts` | create / retry / takehome emit `tasks.trigger` (mocked) |
| `trigger-config.test.ts` | Trigger build includes `@libsql/linux-x64-gnu`; project-id fallback |
| `stream-session.test.ts` | Cursor only after audible; concurrent reader; budget |
| `speakable-text.test.ts` | Attention page-1 + glued 4-page extract: emails/URLs/grants gone, Abstract+Introduction kept as their own paragraphs, no conference-to-EOF wipe |
| `narration-script.test.ts` | Fish `[long-break]` / `[break]` on headings and dense prose; tags only for Fish |
| `narration-pace.test.ts` | Light 0.9–1.0 clamp only when WPM is extreme; healthy pause ratio leaves speed at 1 |
| `playback-speed.test.ts` | Player pills include 0.8 and 0.9; default remains 1 |
| `clone-sample-audio.test.ts` | Tiny WAV: high-pass / gate / normalize; mp3 passthrough |
| Unit suites | pricing, ETA, audio-guard, accent, catalog, session, rate-limit, … |

---

## 25. Environment & deployment knobs

### Required

```
SESSION_SECRET            # or INTERNAL_JOB_SECRET fallback
INTERNAL_JOB_SECRET
CRON_SECRET               # if you hit /api/cron/process-jobs
OPENROUTER_API_KEY
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
NEXT_PUBLIC_APP_URL
```

### Important optionals

```
PREMIUM_HD_ENABLED / PREMIUM_HD_ALLOWLIST
MAX_UPLOAD_MB / NEXT_PUBLIC_MAX_UPLOAD_MB   # default 512
TTS_POLL_NUDGE_BUDGET_MS   # 0 in production (Trigger runs generation)
TRIGGER_SECRET_KEY / TRIGGER_PROJECT_ID
TTS_TRIGGER_WAVE_BUDGET_MS / TTS_TAKEHOME_FANOUT
TTS_* worker knobs (see §19)
TTS_PRICE_* / STREAM_MAX_AUDIO_SECONDS
```

### Deploy notes

- `.gitignore` must **not** use a bare `auth` pattern — that hid `src/lib/auth/`
  and broke Vercel builds (`Module not found`). Use `/auth` for root SQLite only.
- Hobby: no `crons` in `vercel.json`. Whole book is Trigger.dev
  (`takehome.advance` + minute `takehome.drain`). Polls are read-only.
- Generate secrets with any CSPRNG (`openssl rand -hex 32` or PowerShell
  equivalent); they are not vendor API keys.

---

## 26. Invariants checklist

1. **Identity is server-minted.** Cookie/header always re-verified with HMAC.
2. **Wrong owner → 404** on jobs/storage (not 403).
3. **Job create never synthesizes.** Trigger / fallback workers do. Polls do not.
4. **Lease token gates all take-home progress writes.**
5. **Silence is failure.** Preview / sections / stream windows all guard.
6. **Stream cursor advances only after audible bytes.**
7. **Shared PDF folders survive** until the last sibling job is deleted.
8. **Accent variants are Gemini-only;** style prompts only for vendors that honor them.
9. **OpenRouter `pricing.prompt` is untrusted** without override / plausibility window.
10. **`/api/storage` is the only browser file path** — ownership checked every time.
11. **Document bytes never enter a Vercel function body.** Browser PUTs to R2; extract runs on Trigger.dev.

---

## 27. Glossary

| Term | Meaning |
|------|---------|
| Catalog voice | Our card id (`or:model:voice[:locale]`) |
| Provider voice | Upstream voice id sent to TTS |
| Directed input | Accent instruction embedded in Gemini `input` text |
| Tick | One leased synthesis pass (N sections) |
| Wave | Several ticks inside one function invocation |
| Lease | `processing_lease_token` + expiry claiming a take-home job |
| Nudge | Poll-time lease sweep + optional short wave |
| Segment | One stored take-home section in `segments_json` (map by index) |
| Fan-out | Parallel Fish calls for a claimed index set (cap 4/5) |
| Stream budget | Char/time cap for live listen |
| HD gate | Soft block for MiniMax-class voices |

---

## Related reading order (first week in the codebase)

1. `src/proxy.ts` → `lib/auth/session.ts` → `lib/auth/guard.ts`
2. `app/api/pdf/upload/route.ts` → `lib/uploads/extract.ts` → `trigger/extract-upload.ts`
3. `app/api/jobs/route.ts` → `lib/jobs/serialize.ts`
4. `lib/tts/catalog/*` → `lib/tts/providers/openrouter.ts`
5. `lib/tts/stream-session.ts` + `app/api/jobs/[id]/stream/route.ts`
6. `lib/tts/process-job.ts` (read top comments, then claim → synthesizeSection → wave)
7. `app/dashboard/{voice,queue,player}` with `lib/ux-copy.ts` open beside them
8. `src/test/harness.ts` + `ownership.test.ts` + `pipeline.test.ts`

*Document tracks Echomancer v2 after the security/reliability audit (auth modules,
leases, empty-audio guards, catalog honesty, Hobby-safe deploy).*
