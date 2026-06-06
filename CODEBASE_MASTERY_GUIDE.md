# Echomancer v2 — Codebase Mastery Guide

> A practical, layered walkthrough of the entire codebase — from concrete syntax patterns to architectural decisions. Built for someone who knows the app at a high level and wants to understand *how it actually works*.
>
> **Last updated:** June 2026 — reflects the production architecture: **Vercel + Turso + Cloudflare R2 + Modal F5-TTS**.

---

## 1. Project Overview & High-Level Architecture

### What It Does

Echomancer converts documents (PDF, EPUB, DOCX, etc.) into audiobooks using AI voice cloning. The user uploads a voice sample (or picks a saved one), clips a 3–30 second reference segment, and the system synthesizes speech that mimics that voice reading the entire document.

### The Big Picture

```
┌──────────────────────────────────────────────────────────────────┐
│                        USER'S BROWSER                            │
│  Landing → Upload PDF → Select Voice → Clip → Queue → Player    │
└───────────────────────────┬──────────────────────────────────────┘
                            │ REST API calls (polling every 3s)
┌───────────────────────────▼──────────────────────────────────────┐
│              NEXT.JS APP on Vercel (Serverless)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ API Routes│  │  Turso   │  │ R2/local │  │ trigger-gen    │  │
│  │ (jobs,    │  │ (LibSQL) │  │ Storage  │  │ (fire Modal)   │  │
│  │  voices,  │  │          │  │          │  │                │  │
│  │  uploads) │  │          │  │          │  │                │  │
│  └─────┬─────┘  └──────────┘  └──────────┘  └───────┬────────┘  │
│        │                                              │          │
│        │  POST /generate_audiobook (returns instantly)│          │
└────────┼──────────────────────────────────────────────┼──────────┘
         │                                              │
         │         Webhook progress updates             │
         │  POST /api/jobs/{id}/webhook ←───────────────┘
         │
┌────────▼─────────────────────────────────────────────────────────┐
│                    MODAL.COM (GPU Infrastructure)                  │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  fastapi_app (CPU) — instant cold start, no Vercel timeout│    │
│  │    /generate_audiobook  → spawns process_audiobook        │    │
│  │    /generate_batch      → voice preview TTS               │    │
│  │    /warmup              → pre-spin GPU containers         │    │
│  │    /health              → readiness check                 │    │
│  └────────────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  process_audiobook (CPU orchestrator)                     │    │
│  │    1. Download PDF + voice from R2                        │    │
│  │    2. Extract text, split into paragraphs                 │    │
│  │    3. Farm chunks to F5TTSAudiobookWorker via .map()      │    │
│  │    4. Concatenate, upload final MP3 to R2                 │    │
│  │    5. Send webhooks to Vercel on progress + completion    │    │
│  └────────────────────────────────────────────────────────────┘    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  F5TTSAudiobookWorker (A10G GPU, max 4 containers)        │    │
│  │    F5-TTS zero-shot voice cloning per paragraph batch      │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Turso over local SQLite in production**: Jobs, voices, and usage logs live in Turso (edge-distributed LibSQL). The legacy `src/lib/db/` (better-sqlite3) still exists for local dev fallback but production routes use `src/lib/turso.ts`.
- **R2 over local filesystem in production**: PDFs, voice samples, and audiobooks are stored in Cloudflare R2 (zero egress). `src/lib/storage.ts` auto-detects R2 credentials and falls back to `./data/storage` locally.
- **Modal orchestrator, not in-process generation**: The old `generate-audiobook-v2.ts` pipeline ran inside the Next.js server. Generation now runs entirely on Modal (`modal/f5_tts_server.py`). The Next.js app only triggers jobs and receives webhook updates.
- **Webhook-based progress**: Modal sends `POST /api/jobs/{id}/webhook` with status/progress. The frontend polls Turso every 3 seconds — no WebSockets or Supabase Realtime.
- **CPU fastapi_app + GPU workers**: Vercel has a 10–60s function timeout. The CPU endpoint spawns `process_audiobook` and returns immediately, so Vercel never waits for GPU work.

---

## 2. Project Structure & Navigation

```
src/
├── app/                              # Next.js App Router
│   ├── page.tsx                      # Landing page — upload PDF
│   ├── layout.tsx                    # Root layout — fonts, theme, Toaster
│   ├── globals.css                   # Tailwind + custom CSS variables
│   ├── api/
│   │   ├── pdf/upload/route.ts       # POST — upload document
│   │   ├── audio/upload/route.ts     # POST — upload voice sample
│   │   ├── jobs/
│   │   │   ├── route.ts              # GET (list), POST (create + trigger)
│   │   │   └── [id]/
│   │   │       ├── route.ts          # GET, DELETE, PATCH (retry)
│   │   │       ├── webhook/route.ts  # POST — Modal progress callbacks
│   │   │       └── cancel/route.ts   # POST — cancel in-flight job
│   │   ├── voices/route.ts           # GET, POST, DELETE saved voices
│   │   ├── voice/
│   │   │   ├── preview/route.ts      # POST — short TTS preview
│   │   │   └── analyze/route.ts      # POST — voice quality analysis
│   │   ├── modal/warmup/route.ts     # POST — pre-warm GPU containers
│   │   ├── storage/[[...path]]/      # GET — serve files (R2 or local)
│   │   ├── health/route.ts           # GET — health check
│   │   └── debug/env/route.ts        # GET — env diagnostics (dev)
│   └── dashboard/
│       ├── layout.tsx                # Dashboard nav shell
│       ├── page.tsx                  # Redirects to voice selection
│       ├── voice/
│       │   ├── page.tsx              # Voice upload + saved voices
│       │   └── clip/page.tsx         # Clip range + create job
│       ├── queue/page.tsx            # Job library with polling
│       ├── player/[id]/page.tsx      # Audiobook player
│       └── resources/page.tsx        # Help & FAQ
├── components/
│   ├── ui/                           # shadcn/ui primitives
│   ├── modal-warmup-loader.tsx       # GPU warmup progress UI
│   ├── tts-generator.tsx             # TTS test component
│   ├── Logo.tsx
│   ├── theme-provider.tsx
│   └── theme-toggle.tsx
├── hooks/
│   └── useAudioProcessor.ts          # Web Audio API EQ/effects for player
└── lib/
    ├── turso.ts                      # Turso client + query helpers
    ├── turso/jobs.ts                 # Async job CRUD (production)
    ├── storage.ts                    # Unified R2/local storage interface
    ├── r2-storage.ts                 # Cloudflare R2 S3-compatible client
    ├── storage/index.ts              # Legacy local-only storage (deprecated)
    ├── trigger-generation.ts         # Fire-and-forget Modal job trigger
    ├── modal-client.ts               # Modal health check + warmup helpers
    ├── db/                           # Legacy local SQLite (dev only)
    │   ├── index.ts
    │   └── jobs.ts
    ├── env.ts                        # Zod-validated env vars
    ├── errors.ts                     # AppError + handleApiError()
    ├── errors-ui.ts                  # userFriendlyError() for frontend
    ├── validation.ts                 # Zod schemas for API inputs
    ├── rate-limit.ts                 # In-memory IP rate limiter
    ├── text-extraction.ts            # PDF/EPUB/DOCX text extraction
    └── utils.ts                      # cn() Tailwind helper

modal/
├── f5_tts_server.py                  # Primary Modal app (F5-TTS pipeline)
└── audio_cleaner.py                  # Demucs vocal isolation service

data/                                 # Runtime data (gitignored, local dev)
├── echomancer.db                     # Legacy SQLite (if used locally)
└── storage/                          # Local file fallback
```

### Entry Points

| Entry | What Happens |
|-------|-------------|
| `npm run dev` | Starts Next.js dev server on `localhost:3000` |
| `src/app/page.tsx` | Landing page — user uploads a document |
| `POST /api/jobs` | Creates Turso job record, calls `triggerAudiobookGeneration()` |
| `trigger-generation.ts` | POSTs to Modal `/generate_audiobook` with R2 keys + webhook URL |
| `modal deploy f5_tts_server.py` | Deploys the F5-TTS Modal app |
| `POST /api/jobs/{id}/webhook` | Modal reports progress; Turso job row updated |

---

## 3. Core Patterns & Implementation Details

### 3.1 Turso Database (Production)

**File**: `src/lib/turso.ts`

```typescript
export function getTursoClient(): Client {
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
  }
  return client;
}
```

**What this does**: Returns a singleton LibSQL client connected to Turso's edge network. All production API routes use async `query()`, `queryOne()`, and `execute()` helpers.

**Schema** — see `migrate-turso.sql`. Key `jobs` columns:

| Column | Purpose |
|--------|---------|
| `pdf_storage_path` | R2 key for uploaded document |
| `voice_storage_path` | R2 key(s) for voice sample (comma-separated if multiple) |
| `audio_storage_path` | R2 key for finished audiobook MP3 |
| `status` | `queued` → `processing` → `ready` / `failed` |
| `progress` | 0–100, updated via webhook |
| `deleted_at` | Soft delete (NULL = active) |

**Timestamps**: Stored as `unixepoch()` integers. API responses convert to ISO strings:
```typescript
created_at: new Date(job.created_at * 1000).toISOString()
```

### 3.2 Dynamic SQL Builder for Job Updates

**File**: `src/lib/turso/jobs.ts`

Same pattern as the old SQLite version — builds `UPDATE` dynamically based on which fields are provided. Only touches columns with new values. Always sets `updated_at = unixepoch()`.

Used by both the webhook handler and any direct status changes (cancel, retry).

### 3.3 Unified Storage (R2 + Local Fallback)

**File**: `src/lib/storage.ts`

```typescript
export function getStorageBackend(): "r2" | "local" {
  return isR2Configured() ? "r2" : "local";
}
```

**Two APIs coexist**:

1. **New unified API**: `upload()`, `download()`, `remove()`, `getUrl()` — type-aware keys like `pdfs/{userId}/{timestamp}_{filename}`
2. **Legacy API**: `uploadFile()`, `downloadFile()`, `getPublicUrl()` — used by existing routes; auto-routes to R2 when configured

**R2 fallback behavior**: If R2 upload/download fails, the legacy functions fall through to local filesystem with a console warning. This keeps dev working even with partial R2 config.

**Public URLs**:
- **R2**: `R2_PUBLIC_URL/{key}` if `R2_PUBLIC_URL` is set
- **Local/Vercel**: `{NEXT_PUBLIC_APP_URL}/api/storage/{key}`
- Production hardcodes `https://echomancer-v2.vercel.app` when `NEXT_PUBLIC_APP_URL` contains `localhost` or `ngrok`

### 3.4 Storage Proxy Route

**File**: `src/app/api/storage/[[...path]]/route.ts`

Serves files from R2 (buffered) or local disk (streamed). Supports:
- **Range requests** for audio seeking in the player
- **Download query param**: `?download=filename.mp3`
- **Path traversal protection** on local paths

When R2 is configured, the entire file is loaded into memory for range slicing. For large audiobooks this is acceptable on Vercel but worth monitoring.

### 3.5 Zod Validation

**File**: `src/lib/validation.ts`

```typescript
export const createJobSchema = z.object({
  pdfStoragePath: z.string().min(1),
  bookTitle: z.string().min(1).max(200).optional().default("Untitled"),
  voiceStoragePath: z.string().min(1),  // required (no YouTube-only path)
  voiceName: z.string().max(200).optional().default("Custom Voice"),
  startTime: z.coerce.number().min(0).max(36000).optional().default(0),
  endTime: z.coerce.number().min(0).max(36000).optional().default(30),
});
```

Clip times now support up to 10 hours (`max(36000)`), matching the voice preview route. The old 60-second cap bug is fixed.

### 3.6 Custom Error Hierarchy

**File**: `src/lib/errors.ts`

`AppError` with `code`, `message`, `statusCode` → `handleApiError()` formats consistent JSON responses. Frontend uses `errors-ui.ts` to translate technical errors (Modal 502, scanned PDF, etc.) into user-friendly messages.

### 3.7 In-Memory Rate Limiting

**File**: `src/lib/rate-limit.ts`

| Endpoint | Limit |
|----------|-------|
| Job creation | 5 per minute per IP |
| Voice preview | 3 per minute per IP |
| Modal warmup | 30s cooldown per IP |

Resets on serverless cold start. Fine for current scale; would need Redis for multi-instance consistency.

### 3.8 Fire-and-Forget Modal Trigger

**File**: `src/lib/trigger-generation.ts`

```typescript
export function triggerAudiobookGeneration(opts: TriggerGenerationOptions): void {
  const modalUrl = process.env.MODAL_TTS_URL;
  // ...
  fetch(`${baseUrl}/generate_audiobook`, {
    method: "POST",
    body: JSON.stringify({
      job_id: opts.jobId,
      pdf_r2_key: opts.pdfStoragePath,
      voice_r2_key: voicePaths[0] || "",
      webhook_url: `${appUrl}/api/jobs/${opts.jobId}/webhook`,
      r2_bucket_name: process.env.R2_BUCKET_NAME || "echomancer-audio",
      // ...
    }),
  }).catch(/* log only */);
}
```

**Critical design points**:
- Shared by `POST /api/jobs` AND `PATCH /api/jobs/[id]` (retry) — prevents drift
- Never throws — failures are logged; job stays `queued` until webhook or manual intervention
- Webhook URL uses production Vercel URL when running locally (Modal can't reach localhost)
- Storage paths are passed as R2 keys regardless of backend name (`pdf_r2_key`)

### 3.9 Webhook Handler with Monotonic Guards

**File**: `src/app/api/jobs/[id]/webhook/route.ts`

Modal sends progress updates. The handler enforces:
- **Auth**: `X-Webhook-Secret` header must match `WEBHOOK_SECRET` (required in production)
- **Terminal state lock**: Once `ready` or `failed`, ignore all further updates
- **Monotonic progress**: Never decrease `progress` value
- **Job ID match**: `body.job_id` must equal URL `{id}`

### 3.10 Frontend Polling

**File**: `src/app/dashboard/queue/page.tsx`

```typescript
const hasActive = jobs.some(j => j.status === "processing" || j.status === "queued");
useEffect(() => {
  if (!hasActive) return;
  const id = setInterval(() => {
    if (document.visibilityState === "visible") refreshRef.current();
  }, 3000);
  return () => clearInterval(id);
}, [hasActive]);
```

Two fetch functions: `fetchJobs()` (shows loader on initial load) and `refreshJobs()` (silent background poll). Polling stops when no active jobs and pauses when tab is hidden.

### 3.11 Modal Warmup

**Files**: `src/lib/modal-client.ts`, `src/app/api/modal/warmup/route.ts`, `src/components/modal-warmup-loader.tsx`

When the user reaches voice selection with a PDF uploaded, `warmupModal()` fires a best-effort `POST /api/modal/warmup` → Modal `/warmup`. This pre-spins up to 4 GPU containers so the first real generation isn't a cold start.

The warmup loader shows staged progress UI ("Spinning up GPU...", "Loading AI voice model...") during voice preview TTS calls.

### 3.12 Web Audio API Player Effects

**File**: `src/hooks/useAudioProcessor.ts`

Processing chain: `source → eqLow → eqMid → eqHigh → compressor → gain → panner → destination`

Audio nodes stored in `useRef` (not state) to avoid re-renders. Uses `setTargetAtTime()` for smooth parameter transitions without audio clicks.

---

## 4. Key Modules & Flows

### 4.1 PDF Upload

**File**: `src/app/api/pdf/upload/route.ts`

- Validates file type and size (max 100MB)
- Stores via `uploadFile()` → R2 or local
- Returns `{ storagePath, fileName, fileSize }`
- Frontend redirects to `/dashboard/voice?pdfPath=...&pdfName=...`

Text extraction happens on Modal during generation (PyMuPDF), not at upload time.

### 4.2 Voice Selection & Clipping

**Current UI** (`src/app/dashboard/voice/page.tsx`): Two tabs only —
- **Upload**: Direct audio upload → clip page
- **Saved**: Pick from previously saved voices → clip page

YouTube search/download routes were removed from the current codebase. Saved voices may still have `source: "youtube"` from earlier data.

**Clip page** (`src/app/dashboard/voice/clip/page.tsx`):
- Plays voice from `/api/storage/{voicePath}`
- User adjusts start/end time (3–30 second clip)
- Optional "Test this voice" → `POST /api/voice/preview` (ffmpeg clip + Modal `/generate_batch`)
- "Create audiobook" → `POST /api/jobs`

### 4.3 Job Creation & Deduplication

**File**: `src/app/api/jobs/route.ts`

Before creating a new job, checks Turso for an existing `ready` job with the same PDF path, voice path, and clip times. If found, returns the existing job ID — saves GPU time.

Voice paths are normalized (sorted, comma-joined) so order doesn't matter.

### 4.4 Audiobook Generation Pipeline (Modal)

**File**: `modal/f5_tts_server.py` — `process_audiobook()`

```
1. Download PDF from R2 → extract text (PyMuPDF)
2. Download voice sample from R2 → clip with ffmpeg (3–30s)
3. Optional: Audio Cleaner service (Demucs vocal isolation)
4. Transcribe reference audio (faster-whisper) for F5-TTS ref_text
5. Split text into paragraphs (~1500 chars max)
6. Analyze pacing (speed/cfg per paragraph)
7. Farm paragraph batches to F5TTSAudiobookWorker via Modal .map()
   - Each worker: F5-TTS inference on A10G GPU
   - Uploads partial MP3s to R2
   - Sends async progress webhooks
8. Download all partials from R2 → concatenate with ffmpeg
9. Post-process (loudnorm, format) → upload final MP3 to R2
10. Send final webhook: status=ready, audio_storage_path, duration_seconds
```

**On failure**: Synchronous failure webhook with `status=failed` and `error_message`.

**Parallelism**: `F5TTSAudiobookWorker` runs with `max_containers=4`, `keep_warm=2`. The orchestrator uses `.map()` to process paragraph batches concurrently.

### 4.5 Voice Preview (Short TTS)

**File**: `src/app/api/voice/preview/route.ts`

Runs on the Next.js server (not the full audiobook pipeline):
1. Download voice from storage
2. Clip with ffmpeg to selected range
3. POST to Modal `MODAL_TTS_URL` (`/generate_batch`) with clipped audio as base64
4. Save preview MP3 to storage, return public URL

### 4.6 Job Lifecycle

| Action | Route | Effect |
|--------|-------|--------|
| Create | `POST /api/jobs` | Insert `queued`, trigger Modal |
| List | `GET /api/jobs` | Paginated, excludes soft-deleted |
| Get | `GET /api/jobs/[id]` | Single job details |
| Retry | `PATCH /api/jobs/[id]` `{action:"retry"}` | Reset to `queued`, re-trigger Modal |
| Cancel | `POST /api/jobs/[id]/cancel` | Mark `failed` with "Cancelled by user" |
| Delete | `DELETE /api/jobs/[id]` | Soft-delete job, remove PDF/audio/checkpoints from storage |
| Progress | `POST /api/jobs/[id]/webhook` | Modal updates status/progress |

---

## 5. Data Flow & Critical Paths

### 5.1 Complete User Journey

```
1. LANDING (/)
   ├─ User uploads PDF
   ├─ POST /api/pdf/upload → R2 or local storage
   └─ Redirect /dashboard/voice?pdfPath=...&pdfName=...

2. VOICE SELECTION (/dashboard/voice)
   ├─ warmupModal() fires in background
   ├─ Tab: Upload → POST /api/audio/upload → /clip page
   └─ Tab: Saved → select voice → /clip page

3. CLIP PAGE (/dashboard/voice/clip)
   ├─ Adjust start/end time on voice sample
   ├─ Optional: POST /api/voice/preview → hear TTS sample
   ├─ POST /api/jobs → redirect /queue
   └─ Fire-and-forget: POST /api/voices (save voice)

4. QUEUE (/dashboard/queue)
   ├─ GET /api/jobs (poll every 3s while active)
   ├─ Progress bars from webhook-updated Turso rows
   └─ Click "Listen" → /dashboard/player/[id]

5. PLAYER (/dashboard/player/[id])
   ├─ GET /api/jobs/[id]
   ├─ Audio src: /api/storage/[audio_storage_path]
   └─ Web Audio API EQ/speed controls
```

### 5.2 Generation Data Flow (Modal ↔ Vercel)

```
Vercel                           Modal                         Turso
  │                                │                             │
  │─ POST /generate_audiobook ───→│                             │
  │←─ 200 {spawned} ──────────────│                             │
  │                                │─ download PDF/voice from R2 │
  │                                │─ split text, farm to GPU    │
  │                                │                             │
  │←─ POST /webhook {processing,5}│                             │
  │─ update job ───────────────────────────────────────────────→│
  │                                │─ ... more sections ...      │
  │←─ POST /webhook {processing,45}│                             │
  │─ update job ───────────────────────────────────────────────→│
  │                                │─ upload final MP3 to R2     │
  │←─ POST /webhook {ready,100} ──│                             │
  │─ update job ───────────────────────────────────────────────→│
  │                                │                             │
Browser polls GET /api/jobs ──────────────────────────────────→│
  │←─ {status: "ready", progress: 100}                          │
```

### 5.3 Retry Flow

```
User clicks "Retry" on failed job
  → PATCH /api/jobs/[id] {action: "retry"}
  → resetJob() sets status=queued, progress=0
  → triggerAudiobookGeneration() (same function as new job creation)
  → Modal spawns fresh process_audiobook (no checkpoint resume on Modal side yet)
```

---

## 6. Advanced Insights & Maintainability

### 6.1 Type Safety

**Strong**:
- Zod schemas on all API inputs with type inference
- `noUncheckedIndexedAccess: true` in tsconfig
- Typed `JobUpdateData` in `turso/jobs.ts`

**Weak**:
- Turso query results use manual generic casts (`query<{ id: string; ... }>`)
- No ORM — schema changes require manual SQL updates in multiple files

### 6.2 Error Handling

**Good**:
- `AppError` hierarchy + `handleApiError()` consistency
- Webhook monotonic guards prevent race conditions
- Modal orchestrator has try/catch with failure webhooks
- Retry path re-triggers generation (fixed from earlier bug where retry only reset DB)

**Gaps**:
- Cancel marks job `failed` in Turso but doesn't stop the Modal worker (orphan GPU work continues)
- No timeout-based cleanup for jobs stuck in `processing`
- `triggerAudiobookGeneration` silently returns if `MODAL_TTS_URL` is missing

### 6.3 Performance Considerations

- **R2 buffering in storage route**: Full file loaded into memory for range requests
- **Modal cold start**: First request after idle takes 30–90s; warmup mitigates this
- **Parallel GPU workers**: Up to 4 containers process paragraphs concurrently
- **Webhook async vs sync**: Progress webhooks are fire-and-forget; final ready/failed webhooks are synchronous to prevent race with late progress updates

### 6.4 Security

| Area | Status |
|------|--------|
| Path traversal protection (local storage) | ✅ |
| Security headers in `next.config.ts` | ✅ |
| Webhook secret auth | ✅ (when `WEBHOOK_SECRET` set) |
| Rate limiting on job/preview/warmup | ✅ |
| User authentication | ❌ — all jobs use `user_id = "anonymous"` |
| RLS / per-user data isolation | ❌ |

### 6.5 Scalability Limits

| Limit | Why | Mitigation |
|-------|-----|------------|
| In-memory rate limiting | Resets on cold start | Redis for distributed limiting |
| No job queue | Direct Modal spawn per request | Add BullMQ/Trigger.dev for backpressure |
| Cancel doesn't stop Modal | No Modal call_id tracking | Store `call_id` from spawn response, add cancel endpoint |
| Single webhook secret | Shared across all jobs | Per-job HMAC tokens |

---

## 7. Onboarding & Practical Next Steps

### Running Locally

```bash
npm install
cp .env.local.example .env.local   # or create manually
npm run dev
# → http://localhost:3000
```

**Minimum `.env.local` for local dev**:

```bash
# Turso (required for job routes)
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token

# Modal F5-TTS (required for generation)
MODAL_TTS_URL=https://yourname--echomancer-f5-tts-fastapi-app.modal.run/generate_batch

# Optional: R2 (without these, uses local ./data/storage)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=echomancer-audio

# Optional
WEBHOOK_SECRET=your-secret
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Run `migrate-turso.sql` in the Turso dashboard if the schema is out of date.

### Deploying Modal

```bash
cd modal
modal deploy f5_tts_server.py
# Copy the fastapi_app URL → MODAL_TTS_URL (append /generate_batch)

modal deploy audio_cleaner.py
# Set AUDIO_CLEANER_URL in Modal secrets
```

### Deploying to Vercel

See `DEPLOYMENT.md` and `TURSO_R2_SETUP.md`. Set all env vars in the Vercel dashboard. `NEXT_PUBLIC_APP_URL` must be your production domain so Modal webhooks reach the right host.

### Testing the API

```bash
# Health check
curl http://localhost:3000/api/health

# Upload PDF
curl -X POST http://localhost:3000/api/pdf/upload -F "file=@test.pdf"

# Create job
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "pdfStoragePath": "pdfs/anonymous/123_test.pdf",
    "voiceStoragePath": "voices/anonymous/456_sample.wav",
    "bookTitle": "Test Book",
    "startTime": 0,
    "endTime": 15
  }'

# Poll status
curl http://localhost:3000/api/jobs/<jobId>
```

### Suggested Experiments

1. **Job timeout cleanup**: Cron that marks `processing` jobs older than 60 minutes as `failed`
2. **True cancel**: Store Modal `call_id` on job creation, call Modal to cancel on user cancel
3. **SSE instead of polling**: `GET /api/jobs/[id]/stream` with Turso change notifications
4. **Re-add YouTube voice source**: Restore `/api/youtube/search` and `/api/youtube/download` routes
5. **Checkpoint resume on Modal**: Persist partial R2 keys so retries skip completed sections

### Common Questions

**Q: Why does the first generation take so long?**
A: Modal GPU containers scale to zero. The warmup endpoint pre-spins containers, but the first real inference still loads F5-TTS models into GPU memory (~30–60s).

**Q: Where did `generate-audiobook-v2.ts` go?**
A: The entire pipeline moved to `modal/f5_tts_server.py` (`process_audiobook`). The Next.js server is now a thin orchestration layer.

**Q: Can I run without R2?**
A: Yes — omit R2 env vars and files go to `./data/storage`. But Modal production workers read from R2, so generation requires R2 in production.

**Q: Can I run without Turso?**
A: No — all job API routes import from `src/lib/turso.ts`. The legacy `src/lib/db/` is not wired into current routes.

**Q: Why does localhost webhook not work?**
A: Modal can't reach `localhost`. `trigger-generation.ts` hardcodes the Vercel production URL for webhooks when running locally. Progress updates go to production Turso (same DB if you share credentials).

---

## 8. Related Documentation

| File | Purpose |
|------|---------|
| `AGENTS.md` | AI coding agent quick-reference |
| `DEPLOYMENT.md` | Vercel deployment steps |
| `TURSO_R2_SETUP.md` | Database and storage setup |
| `F5-TTS-MODAL-SETUP.md` | Modal deployment details |
| `migrate-turso.sql` | Current Turso schema |
| `CODE_REVIEW_BUGS.md` | Historical bug analysis |
| `ISSUES_SUMMARY.md` | Current known issues |