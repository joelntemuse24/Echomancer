# Echomancer v2 — Codebase Mastery Guide

> ⚠️ **MIGRATION NOTICE**: This guide was written for the Modal GPU architecture. The app has migrated to **RunPod Serverless + Fish Speech S2 Pro**. While the core patterns (SQLite, storage, job processing) remain accurate, the TTS/GPU sections reference the old Modal services. See `runpod/README.md` for current deployment instructions.

> A practical, layered walkthrough of the entire codebase — from concrete syntax patterns to architectural decisions. Built for someone who knows the app at a high level and wants to understand *how it actually works*.

---

## 1. Project Overview & High-Level Architecture

### What It Does

Echomancer converts documents (PDF, EPUB, DOCX, etc.) into audiobooks using AI voice cloning. The user provides a voice sample — either by uploading a recording or selecting a clip from YouTube — and the system synthesizes speech that mimics that voice reading the entire document.

### The Big Picture

```
┌──────────────────────────────────────────────────────────────────┐
│                        USER'S BROWSER                            │
│  Landing → Upload PDF → Select Voice → Clip → Queue → Player    │
└───────────────────────────┬──────────────────────────────────────┘
                            │ REST API calls
┌───────────────────────────▼──────────────────────────────────────┐
│                     NEXT.JS APP (Server)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ API Routes│  │ SQLite DB│  │Local FS  │  │ Background Gen │  │
│  │ (jobs,    │  │ (better- │  │ Storage  │  │ (generateV2)   │  │
│  │  voices,  │  │  sqlite3)│  │(./data/) │  │                │  │
│  │  youtube) │  │          │  │          │  │                │  │
│  └─────┬─────┘  └──────────┘  └──────────┘  └───────┬────────┘  │
│        │                                              │          │
└────────┼──────────────────────────────────────────────┼──────────┘
         │                                              │
         │      HTTP calls to RunPod Serverless         │
┌────────▼──────────────────────────────────────────────▼──────────┐
│                  RUNPOD SERVERLESS (GPU)                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │        Fish Speech S2 Pro (Voice Cloning TTS)           │    │
│  │                   (H100 / A100 GPU)                      │    │
│  │  • Zero-shot voice cloning with reference audio          │    │
│  │  • Fast inference (~10-15s per section)                   │    │
│  │  • Synchronous or async job polling                       │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **SQLite over Postgres/Supabase**: The app was migrated from Supabase to local SQLite + filesystem storage. This eliminates an external DB dependency, simplifies deployment, and keeps all data co-located with the app. Trade-off: no concurrent multi-server writes, but this is a single-user app.
- **RunPod Serverless for GPU TTS**: Fish Speech S2 Pro runs on RunPod's serverless GPU infrastructure (H100/A100). RunPod endpoints scale to zero, so you only pay during generation. Fish Speech provides fast zero-shot voice cloning with reference audio.
- **Background processing in-process**: `generateAudiobookV2()` runs as a fire-and-forget async function in the Next.js server process — no separate worker queue. Simple, but means generation is tied to the server's lifetime.
- **Polling over WebSockets**: The frontend polls `/api/jobs` every 3 seconds instead of using Supabase Realtime or SSE. Simpler infrastructure, acceptable UX for generation times of minutes.

---

## 2. Project Structure & Navigation

```
src/
├── app/                          # Next.js App Router (routes = folders)
│   ├── page.tsx                  # Landing page — upload PDF
│   ├── layout.tsx                # Root layout — fonts, theme, Toaster
│   ├── globals.css               # Tailwind + custom CSS variables
│   ├── api/                      # Backend API routes
│   │   ├── pdf/upload/           # POST — upload document, store locally
│   │   ├── audio/upload/         # POST — upload voice sample
│   │   ├── youtube/
│   │   │   ├── search/           # GET — search YouTube Data API
│   │   │   └── download/         # POST — download YouTube audio clip
│   │   ├── jobs/
│   │   │   ├── route.ts          # GET (list), POST (create + trigger gen)
│   │   │   └── [id]/route.ts     # GET, DELETE, PATCH (retry) single job
│   │   ├── voices/route.ts       # GET, POST, DELETE voice samples
│   │   ├── voice/preview/route.ts# POST — generate voice preview via TTS
│   │   └── storage/[[...path]]/  # GET — serve stored files (PDFs, audio)
│   └── dashboard/                # App UI (all under shared layout)
│       ├── layout.tsx            # Dashboard nav shell
│       ├── page.tsx              # Redirects to /dashboard/voice
│       ├── voice/
│       │   ├── page.tsx          # Voice selection (upload/YouTube/saved)
│       │   └── clip/page.tsx     # Fine-tune voice clip + create job
│       ├── queue/page.tsx        # Job library with progress bars
│       └── player/[id]/page.tsx  # Audiobook player with audio controls
├── components/
│   ├── ui/                       # shadcn/ui primitives (Button, Slider, etc.)
│   ├── Logo.tsx
│   ├── theme-provider.tsx        # next-themes wrapper
│   └── theme-toggle.tsx
├── hooks/
│   └── useAudioProcessor.ts      # Web Audio API hook for player EQ/effects
├── lib/
│   ├── db/
│   │   ├── index.ts              # SQLite setup, schema, getDb()
│   │   └── jobs.ts               # Job CRUD helpers (updateJob, getJob, etc.)
│   ├── storage/index.ts          # Local filesystem storage (upload, download, etc.)
│   ├── env.ts                    # Zod-validated env vars
│   ├── errors.ts                 # AppError class + handleApiError()
│   ├── errors-ui.ts              # userFriendlyError() for frontend
│   ├── validation.ts             # Zod schemas for API inputs
│   ├── rate-limit.ts             # In-memory IP rate limiter
│   ├── text-extraction.ts        # PDF/EPUB/DOCX/TXT/RTF/MOBI text extraction
│   ├── generate-audiobook-v2.ts  # Core audiobook generation pipeline
│   └── utils.ts                  # cn() Tailwind helper
runpod/                            # RunPod serverless GPU workers
├── src/
│   ├── handler.py                # Fish Speech S2 Pro request handler
│   └── run.sh                    # Container startup script
├── Dockerfile                    # Container build configuration
└── README.md                     # Deployment guide
```

### Entry Points

| Entry | What Happens |
|-------|-------------|
| `npm run dev` | Starts Next.js dev server on `localhost:3000` |
| `src/app/page.tsx` | Landing page — user uploads a document |
| `src/app/api/jobs/route.ts POST` | Creates a job and fires `generateAudiobookV2()` |
| Deploy `runpod/` to RunPod | Creates Fish Speech S2 Pro serverless endpoint |

---

## 3. Core Patterns & Implementation Details

### 3.1 SQLite Database with `better-sqlite3`

The database is a single local SQLite file, initialized on first access.

**File**: `src/lib/db/index.ts`

```typescript
export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  dbInstance = new Database(DB_PATH);
  dbInstance.pragma("journal_mode = WAL");
  initDb(dbInstance);
  return dbInstance;
}
```

**What this does**: Returns a singleton database connection. Creates the `./data/` directory if needed, enables WAL mode (Write-Ahead Logging — allows concurrent reads while writing), and runs schema creation.

**Why WAL**: SQLite's default journal mode locks the entire database during writes. WAL allows readers to proceed while a writer is active — critical for a web server that needs to serve job status while generation updates progress.

**Schema pattern** — timestamps use `unixepoch()`:
```sql
created_at INTEGER DEFAULT (unixepoch()),
updated_at INTEGER DEFAULT (unixepoch())
```

SQLite doesn't have a native datetime type. `unixepoch()` returns seconds since 1970 as an integer. On read, the API converts back:
```typescript
created_at: new Date(job.created_at * 1000).toISOString(),
```

**Why integers over ISO strings**: Faster comparisons, smaller storage, native SQLite arithmetic (`created_at > unixepoch() - 3600` for "last hour").

### 3.2 Dynamic SQL Builder for Job Updates

**File**: `src/lib/db/jobs.ts`

```typescript
export function updateJob(jobId: string, data: JobUpdateData): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (data.status !== undefined) {
    fields.push("status = ?");
    values.push(data.status);
  }
  if (data.progress !== undefined) {
    fields.push("progress = ?");
    values.push(data.progress);
  }
  // ... more fields ...

  fields.push("updated_at = unixepoch()");

  const sql = `UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`;
  values.push(jobId);

  const stmt = db.prepare(sql);
  stmt.run(...values);
}
```

**What this does**: Builds an `UPDATE` statement dynamically based on which fields are provided. Only touches columns that have new values.

**Why not a static query**: Job updates happen at many stages (status change, progress update, audio path set, error set). A static query would set untouched columns to their current values unnecessarily, and you'd need `null` placeholders. This pattern is more flexible and generates minimal SQL.

**Trade-off**: No compile-time check that field names match the schema. A typo like `statu` instead of `status` would silently skip that field. In a larger codebase, you'd want a mapping object or ORM.

### 3.3 Local Filesystem Storage

**File**: `src/lib/storage/index.ts`

```typescript
export async function uploadFile(
  directory: string,
  filename: string,
  data: Buffer | ArrayBuffer | Uint8Array,
  contentType?: string
): Promise<{ path: string; size: number }> {
  const dirPath = path.join(STORAGE_ROOT, directory);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, filename);
  // ... convert to Buffer, write file ...
  return { path: `${directory}/${filename}`, size: buffer.length };
}
```

**What this does**: Writes a file to `./data/storage/<directory>/<filename>`, creating directories as needed. Returns a relative path like `pdfs/abc-123/document.pdf`.

**How files are served back** — the storage API route:
```typescript
// src/app/api/storage/[[...path]]/route.ts
const storagePath = pathSegments.join("/");
const fullPath = getFullPath(storagePath);

// Security: prevent path traversal
const storageRoot = path.resolve(process.env.STORAGE_PATH || "./data/storage");
const resolvedPath = path.resolve(fullPath);
if (!resolvedPath.startsWith(storageRoot)) {
  return NextResponse.json({ error: "Invalid path" }, { status: 403 });
}
```

**Why the path traversal check**: The `[[...path]]` catch-all route takes arbitrary URL segments. Without this check, a request to `/api/storage/../../etc/passwd` could read any file on the server. `path.resolve` normalizes the path, then we verify it's still within the storage root.

**URL generation** — `getPublicUrl()`:
```typescript
export function getPublicUrl(storagePath: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${baseUrl}/api/storage/${storagePath}`;
}
```

This replaces the old Supabase Storage public URL pattern. The frontend uses `/api/storage/...` paths directly (same origin, no CORS issues).

### 3.4 Zod Validation for API Inputs

**File**: `src/lib/validation.ts`

```typescript
export const createJobSchema = z.object({
  pdfStoragePath: z.string().min(1, "PDF storage path is required"),
  bookTitle: z.string().min(1).max(200).optional().default("Untitled"),
  voiceStoragePath: z.string().optional(),
  videoId: z.string().optional(),
  voiceName: z.string().max(200).optional().default("Custom Voice"),
  startTime: z.coerce.number().min(0).max(60).optional().default(0),
  endTime: z.coerce.number().min(0).max(60).optional().default(30),
}).refine(
  (data) => data.voiceStoragePath || data.videoId,
  { message: "Either voiceStoragePath or videoId is required" }
);
```

**What this does**: Defines the shape and constraints of the job creation request. `z.coerce.number()` converts string query params to numbers. The `.refine()` adds a cross-field validation that at least one voice source exists.

**How it's used** in an API route:
```typescript
const body = await request.json();
const parsed = createJobSchema.parse(body);
// If we get here, `parsed` is type-safe and validated
```

If validation fails, `zod` throws a `ZodError`, which `handleApiError()` catches and formats:
```typescript
if (error instanceof ZodError) {
  const messages = error.issues.map((e) => `${e.path.join(".")}: ${e.message}`);
  return NextResponse.json(
    { error: "Validation failed", details: messages },
    { status: 400 }
  );
}
```

**Why Zod over manual checks**: Type inference (`z.infer<typeof createJobSchema>` gives you the TypeScript type), consistent error format, and the `.refine()` pattern for cross-field rules that are awkward with `if` statements.

### 3.5 Custom Error Hierarchy

**File**: `src/lib/errors.ts`

```typescript
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "AppError";
  }
}
```

**What this does**: A structured error class with a machine-readable `code` (like `"MISSING_FILE"`, `"INVALID_VIDEO_ID"`) and an HTTP status code.

**How it flows through the system**:

1. API route throws: `throw new AppError("MISSING_FILE", "No file provided", 400)`
2. Route catches and delegates: `return handleApiError(error)`
3. `handleApiError` checks the type and formats the response:
   - `AppError` → `{ error: message, code: code }` with the given status
   - `ZodError` → `{ error: "Validation failed", details: [...] }` with 400
   - Generic `Error` → `{ error: "Internal server error" }` with 500 (message hidden from client)

**On the frontend**, `errors-ui.ts` translates raw messages:
```typescript
export function userFriendlyError(rawError: string | null): string {
  if (lower.includes("scanned")) return "Could not read text from this document...";
  if (lower.includes("modal") || lower.includes("502")) return "The AI service was temporarily unavailable...";
  // ...
}
```

This two-layer approach keeps technical details out of the UI while preserving them in logs.

### 3.6 In-Memory Rate Limiting

**File**: `src/lib/rate-limit.ts`

```typescript
export function createRateLimiter(max: number, windowMs: number) {
  const map = new Map<string, { count: number; resetAt: number }>();
  return function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = map.get(ip);
    if (!entry || now > entry.resetAt) {
      map.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= max;
  };
}
```

**What this does**: A factory that returns a rate-check function. Each limiter has its own `Map` keyed by IP. If the window expired, the counter resets. Returns `true` if allowed, `false` if over limit.

**Usage**: Job creation allows 5 per minute, voice preview allows 3 per minute:
```typescript
const checkRateLimit = createRateLimiter(5, 60_000);
const checkPreviewRateLimit = createRateLimiter(3, 60_000);
```

**Limitations**: Resets on server restart (in-memory only), doesn't work across multiple server instances. Fine for a single-process app.

### 3.7 Fire-and-Forget Background Processing

**File**: `src/app/api/jobs/route.ts`

```typescript
generateAudiobookV2({
  jobId,
  pdfStoragePath: parsed.pdfStoragePath,
  voiceStoragePath: voicePaths[0] || null,
  // ...
}).catch((err) => {
  console.error(`[Job ${jobId}] Unhandled error:`, err);
});
```

**What this does**: Calls the generation function without `await`. The API responds immediately with `{ jobId, status: "queued" }`, and generation runs in the background within the same Node.js process.

**Why not `await`**: The generation takes minutes. The HTTP request would time out. The frontend polls for progress instead.

**Trade-offs**:
- ✅ Simple — no message queue, no worker process
- ❌ If the server restarts mid-generation, the job is stuck in "processing" forever (no automatic recovery)
- ❌ Generation uses the same event loop as API requests — heavy CPU work could slow down API responses (though most heavy work is offloaded to Modal)

### 3.8 Frontend Polling Pattern

**File**: `src/app/dashboard/queue/page.tsx`

```typescript
// Polling for real-time updates (every 3 seconds)
useEffect(() => {
  const hasActiveJobs = jobs.some(
    job => job.status === "processing" || job.status === "queued"
  );
  if (!hasActiveJobs) return;

  const interval = setInterval(fetchJobs, 3000);
  return () => clearInterval(interval);
}, [jobs, fetchJobs]);
```

**What this does**: Only polls when there are active jobs. Once all jobs are "ready" or "failed", the interval stops. The `jobs` dependency re-evaluates on every state change.

**Why conditional polling**: Avoids unnecessary network requests when nothing is changing. A WebSocket would be more efficient, but polling is simpler and works everywhere.

### 3.9 Motion Animations with `motion/react`

**File**: Throughout the dashboard UI

```typescript
import { motion, AnimatePresence } from "motion/react";

// Fade-in on mount
<motion.div
  initial={{ opacity: 0, y: 30 }}
  animate={{ opacity: 1, y: 0 }}
  className="text-center space-y-4 mb-8"
>

// Animated list with exit animations
<AnimatePresence mode="wait">
  {!selectedVideo ? (
    <motion.div key="search" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      ...
    </motion.div>
  ) : (
    <motion.div key="player" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}>
      ...
    </motion.div>
  )}
</AnimatePresence>
```

**What this does**: `motion/react` (the `motion` package, formerly `framer-motion`) provides declarative animations. `AnimatePresence` enables exit animations — when a component unmounts, it plays the `exit` animation before removing from the DOM.

**Key pattern**: The `key` prop on `motion.div` inside `AnimatePresence` tells motion which component is entering vs. exiting. Without unique keys, it can't distinguish them.

### 3.10 Web Audio API for Player Effects

**File**: `src/hooks/useAudioProcessor.ts`

```typescript
// Audio processing chain:
// source → eqLow → eqMid → eqHigh → compressor → gain → panner → destination
source
  .connect(eqLow)      // Low shelf filter (200Hz) — "depth" control
  .connect(eqMid)      // Peaking filter (1kHz) — "voice character" control
  .connect(eqHigh)     // High shelf filter (4kHz)
  .connect(compressor) // Dynamic compression — "dynamics" control
  .connect(gainNode)   // Volume
  .connect(panner)     // Stereo panning
  .connect(audioContext.destination);
```

**What this does**: Creates a Web Audio API processing chain connected to an `<audio>` element. Each node is stored in a `useRef` so it persists across renders without causing re-renders.

**Why `useRef` over `useState`**: Audio nodes are mutable objects. Putting them in state would cause unnecessary re-renders every time a parameter changes (which happens continuously during playback). Refs let you mutate `.gain.value` etc. without triggering React updates.

**`setTargetAtTime` for smooth transitions**:
```typescript
eqLowRef.current.gain.setTargetAtTime(gain, audioContextRef.current.currentTime, 0.1);
```

The third argument (`0.1`) is the time constant — the transition takes ~0.3s (3× time constant). This prevents audio clicks/pops from sudden parameter jumps.

---

## 4. Key Modules & Flows

### 4.1 PDF Upload & Text Extraction

**Upload**: `src/app/api/pdf/upload/route.ts`
- Validates file type via extension (`detectFormat`)
- Max 100MB
- Stores to `./data/storage/pdfs/<uuid>/<filename>`
- Returns `{ storagePath, fileName, fileSize }`

**Extraction**: `src/lib/text-extraction.ts`
- Supports PDF (unpdf), EPUB (epub2), DOCX (mammoth), TXT, RTF (regex), MOBI (Calibre)
- EPUB requires a temp file because `epub2` needs a file path
- MOBI requires Calibre's `ebook-convert` CLI tool installed on the server

**Preprocessing** (inside `generate-audiobook-v2.ts`):
```typescript
function preprocessPDFText(rawText: string, jobId: string): string {
  // Normalize unicode quotes, dashes, ellipses
  // Remove page numbers (lines that are just digits)
  // Strip repeated headers/footers (lines appearing 3+ times)
  // Detect chapter breaks (Chapter X, PROLOGUE, etc.)
  // Join hyphenated line breaks
  // Remove citation brackets [1], URLs, emails
  // Collapse excess whitespace
}
```

This is crucial for TTS quality — raw PDF text has artifacts that sound terrible when read aloud (page numbers, headers, broken hyphens).

### 4.2 Voice Selection & Clipping

Two paths:

**Path A — Upload**: User uploads an audio file → stored to `./data/storage/voices/<uuid>/<filename>` → redirected to clip page.

**Path B — YouTube**: User searches YouTube → selects a video → embedded player appears with time selection slider → user picks 3-30 second clip → `handleDownloadClip()` downloads only that clip via Modal → stored locally → job created immediately (no separate clip page needed).

**The YouTube download flow** (`src/app/api/youtube/download/route.ts`):
```
Frontend → POST /api/youtube/download { videoId, startTime, endTime }
         → POST to Modal youtube-audio-download endpoint
         → Modal returns { audio_base64, format, duration_seconds }
         → Decode base64, uploadFile() to local storage
         → Return { storagePath, format, size, durationSeconds }
```

The Modal endpoint URL is derived from `MODAL_TTS_URL` by replacing the function name in the URL — a convention-based approach rather than a separate config variable.

### 4.3 Job Creation & Deduplication

**File**: `src/app/api/jobs/route.ts`

```typescript
// Deduplication: check if a "ready" job already exists with same PDF+voice+clip
const checkStmt = db.prepare(`
  SELECT id, status, audio_storage_path 
  FROM jobs  -- NOTE: bug — missing FROM clause in original
  WHERE pdf_storage_path = ? 
    AND voice_storage_path = ? 
    AND start_time = ? 
    AND end_time = ? 
    AND status = 'ready'
  LIMIT 1
`);
```

If a matching "ready" job exists, the API returns it instead of re-generating. This saves GPU time and prevents duplicate audiobooks.

**Voice path normalization**: Multiple voice paths are comma-separated, sorted, and joined for comparison:
```typescript
const voicePathStr = parsed.voiceStoragePath 
  ? parsed.voiceStoragePath.split(",").map(p => p.trim()).sort().join(",")
  : "";
```

This ensures `voices/a,voices/b` and `voices/b,voices/a` are treated as the same.

### 4.4 Audiobook Generation Pipeline

**File**: `src/lib/generate-audiobook-v2.ts` (~978 lines)

This is the heart of the application. The pipeline:

```
1. Download PDF from local storage → Extract text → Preprocess
2. Download voice sample → Clip to [startTime, endTime] → Clean (if YouTube) → Enhance
3. Split text into ~600-char sections by sentences
4. Create voice prompt on Modal (Qwen3-TTS)
5. For each batch of sections:
   a. Send batch to Qwen3-TTS → Get audio_base64 for each
   b. Save checkpoints (individual MP3s + JSON manifest)
   c. Update job progress
6. Validate all checkpoints exist
7. Concatenate all section MP3s (crossfade for ≤20, concat filter for >20)
8. Post-process: upsample to 44.1kHz, EQ, loudnorm via ffmpeg
9. Upload final audiobook → Update job status to "ready"
```

**Checkpoint system**: After each batch, the system saves:
- Individual section MP3s to `./data/storage/checkpoints/<jobId>/section_XXXX.mp3`
- A `checkpoints.json` manifest with section index, path, timestamp, text length

On retry, `loadCheckpoints()` reads the manifest and skips already-completed sections:
```typescript
const existingCheckpoints = await loadCheckpoints(jobId);
if (existingCheckpoints.length > 0) {
  checkpoints.push(...existingCheckpoints);
}
```

**Batch processing with retries**:
```typescript
while (batchAttempt < maxBatchRetries) {
  try {
    batchResults = await qwen3TTSBatch(modalUrl, pendingTexts, promptKey, jobId);
    break;
  } catch (err) {
    const delay = Math.min(1000 * Math.pow(2, batchAttempt), 30000);
    await new Promise(r => setTimeout(r, delay));
  }
}
```

Exponential backoff (1s, 2s, 4s) up to 30s max. After 3 failures, if some checkpoints exist, continues with partial results.

**Direct HTTP calls to Modal**: Instead of using `fetch()`, the TTS calls use Node's `http`/`https` modules directly:
```typescript
const req = requestModule.request(urlObj, options, (res) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => { /* parse and resolve */ });
});
```

**Why not `fetch`**: The generation function runs in a long-lived async context. Node's `fetch` can have timeout and memory issues with very large responses (audio base64 can be megabytes). The raw `http` approach gives more control over buffering and timeouts.

### 4.5 Modal GPU Services

Three separate Modal apps, each deployed independently:

| Service | File | GPU | Purpose |
|---------|------|-----|---------|
| F5-TTS / Qwen3-TTS | `modal/f5_tts_server_fixed.py` | L4 | Voice cloning + batch TTS |
| Audio Cleaner | `modal/audio_cleaner.py` | T4 | Vocal isolation (Demucs) + VAD (Silero) |
| Emotion Director | `modal/emotion_director_v3.py` | T4 | Emotion detection for pacing |

**Modal pattern** — each service follows this structure:
```python
app = modal.App("service-name")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg")
    .pip_install("torch", "transformers", ...)
    .run_commands("python -c 'download models during build'")  # Cache models in image
)

@app.cls(gpu="L4", image=image, scaledown_window=300, timeout=600)
class ServiceClass:
    @modal.enter()
    def setup(self):
        # Load models into GPU memory — runs once per container
        self.model = load_model()

    @modal.fastapi_endpoint(method="POST")
    def endpoint(self, request: dict):
        # Handle request — runs per HTTP call
        return process(request)
```

**Key Modal concepts**:
- `@modal.enter()` — runs once when a container starts (model loading)
- `@modal.fastapi_endpoint()` — exposes a FastAPI route as a public URL
- `scaledown_window=300` — container stays warm for 5 minutes after last request
- `timeout=600` — max 10 minutes per request
- Models are pre-downloaded during image build (`run_commands`) to avoid cold-start downloads

### 4.6 The Storage Proxy Route

**File**: `src/app/api/storage/[[...path]]/route.ts`

This is the catch-all route that serves stored files. The `[[...path]]` syntax means it matches any depth of path segments: `/api/storage/pdfs/abc/file.pdf`, `/api/storage/voices/xyz/audio.wav`, etc.

```typescript
export const dynamic = "force-dynamic";  // Never cache — files may change
```

It streams files using `createReadStream` for memory efficiency — the entire file isn't loaded into RAM before sending.

---

## 5. Data Flow & Critical Paths

### 5.1 Complete User Journey: Upload to Playback

```
1. LANDING PAGE (/)
   ├─ User drops/selects a PDF
   ├─ POST /api/pdf/upload → stores to ./data/storage/pdfs/<uuid>/<name>
   └─ Redirect to /dashboard/voice?pdfPath=...&pdfName=...

2. VOICE SELECTION (/dashboard/voice)
   ├─ Tab: Upload → POST /api/audio/upload → redirect to /clip page
   ├─ Tab: YouTube → search → select video → pick clip range →
   │   POST /api/youtube/download → POST /api/jobs → redirect to /queue
   └─ Tab: Saved → select saved voice → redirect to /clip page

3. CLIP PAGE (/dashboard/voice/clip)  [for upload & saved voices]
   ├─ Audio plays from /api/storage/<voicePath>
   ├─ User adjusts start/end time
   ├─ Optional: "Test this voice" → POST /api/voice/preview → hear TTS preview
   ├─ "Create audiobook" → POST /api/jobs → redirect to /queue
   └─ Also saves voice to /api/voices (fire-and-forget)

4. QUEUE PAGE (/dashboard/queue)
   ├─ GET /api/jobs → lists all jobs
   ├─ Polls every 3s while any job is processing
   ├─ Shows progress bars, time estimates
   └─ Click "Listen" → /dashboard/player/<id>

5. PLAYER PAGE (/dashboard/player/[id])
   ├─ GET /api/jobs/<id> → job details
   ├─ Audio src: /api/storage/<audio_storage_path>
   ├─ Web Audio API chain for EQ/speed/dynamics
   └─ Download: /api/storage/<path>?download=filename.mp3
```

### 5.2 Generation Data Flow (Inside `generateAudiobookV2`)

```
┌─────────────────────────────────────────────────────────┐
│                    JOB PROCESSING                        │
│                                                         │
│  downloadFile(pdfStoragePath)                           │
│       ↓                                                 │
│  extractTextFromDocument(buffer, filename)              │
│       ↓                                                 │
│  preprocessPDFText(rawText)                             │
│       ↓                                                 │
│  splitBySentences(text, 600) → sections[]              │
│                                                         │
│  downloadFile(voiceStoragePath)                         │
│       ↓                                                 │
│  clipAudioBuffer(buffer, startTime, endTime)            │
│       ↓                                                 │
│  [Optional] Audio Cleaner (Modal) → vocal isolation     │
│       ↓                                                 │
│  enhanceVoiceSample(buffer) → ffmpeg EQ + loudnorm      │
│                                                         │
│  createQwen3VoicePrompt(modalUrl, voiceBase64)          │
│       ↓                                                 │
│  FOR EACH BATCH:                                        │
│    qwen3TTSBatch(modalUrl, texts, promptKey)            │
│       ↓                                                 │
│    uploadFile(checkpoints/..., section_NNNN.mp3)        │
│    saveCheckpoints(jobId, checkpoints)                  │
│    updateJob(jobId, { progress, current_section })      │
│                                                         │
│  concatenateFromBuffers(checkpoints, audioBuffers)      │
│       ↓                                                 │
│  postProcessAudio(concatenatedAudio) → ffmpeg pipeline  │
│       ↓                                                 │
│  uploadFile(audiobooks/<jobId>/audiobook.mp3)           │
│       ↓                                                 │
│  updateJob(jobId, { status: "ready", progress: 100 })  │
└─────────────────────────────────────────────────────────┘
```

### 5.3 How Frontend Gets Progress Updates

```
Browser                          Server
  │                                │
  │── GET /api/jobs ──────────────→│  (every 3 seconds)
  │←─ { jobs: [...], progress: 45 }│
  │                                │
  │   [3 seconds pass]             │  [generateAudiobookV2 calls updateJob()]
  │                                │  [progress now 55]
  │── GET /api/jobs ──────────────→│
  │←─ { jobs: [...], progress: 55 }│
  │                                │
  │   [job completes]              │
  │── GET /api/jobs ──────────────→│
  │←─ { jobs: [...], status: "ready" }
  │                                │
  │   [polling stops — no active jobs]
```

---

## 6. Advanced Insights & Maintainability

### 6.1 Type Safety Observations

**Strong areas**:
- Zod schemas validate all API inputs and provide type inference
- `noUncheckedIndexedAccess: true` in tsconfig forces null checks on array/object access
- Strict null checks throughout

**Weak areas**:
- SQLite query results are manually typed with `as Array<{ ... }>` casts — no compile-time verification that the types match the actual schema
- `updateJob`'s dynamic SQL builder has no compile-time field name checking
- The `JobUpdateData` type doesn't enforce that only valid status strings are passed

### 6.2 Error Handling Patterns

**Good**:
- `AppError` hierarchy with structured codes
- `handleApiError()` provides consistent error responses
- `userFriendlyError()` translates technical errors for the UI
- Generation pipeline has retry logic with exponential backoff
- Partial failure mode: if some sections succeed, the job reports "Partial failure" with the count

**Gaps**:
- No global unhandled rejection handler for the fire-and-forget generation
- If the server crashes mid-generation, jobs stay in "processing" forever — no timeout-based cleanup
- `catch {}` blocks in several places silently swallow errors (e.g., voice save in clip page)

### 6.3 Performance Considerations

**Audio base64 over HTTP**: The entire audio content is base64-encoded and sent as JSON between Modal and the Next.js server. For a long audiobook, this could be 50MB+ of base64 text. A binary streaming approach (e.g., Modal writes to a shared volume or returns a download URL) would be more memory-efficient.

**ffmpeg as the Swiss Army knife**: ffmpeg is called 5+ times during generation (clip, enhance, concatenate, post-process, normalize fallback). Each call spawns a child process. This works but is fragile — ffmpeg must be installed on the server, and the command strings are vulnerable to injection if filenames contain special characters (though `randomUUID` filenames mitigate this).

**SQLite WAL mode**: Correctly enabled, but `better-sqlite3` is synchronous — all database operations block the Node.js event loop. For this app's volume, that's fine. At high concurrency, you'd want to move DB access to a worker thread.

### 6.4 Security Observations

- **Path traversal protection** in the storage route ✅
- **Security headers** configured in `next.config.ts` (X-Frame-Options, HSTS, etc.) ✅
- **No authentication**: All API routes use `user_id = "anonymous"`. Anyone who can reach the server can access any job or file.
- **No rate limiting on storage route**: The `/api/storage/` endpoint has no rate limiting — a client could download all stored files rapidly.
- **MODAL_TTS_URL derivation**: YouTube download URL is derived by string-replacing the TTS URL. If the TTS URL format changes, this silently breaks.

### 6.5 Scalability Limits

| Limit | Why | Mitigation |
|-------|-----|-----------|
| Single SQLite file | Concurrent writes from multiple server instances would conflict | Run a single server instance |
| In-memory rate limiting | Resets on restart, doesn't share across instances | Use Redis for distributed rate limiting |
| Fire-and-forget generation | Tied to process lifetime | Use a real job queue (BullMQ, Celery) |
| No file cleanup | Old PDFs, voice samples, checkpoints accumulate indefinitely | Add a cron job or TTL-based cleanup |
| Audio base64 transport | Memory-intensive for large audiobooks | Stream binary data or use shared storage |

---

## 7. Onboarding & Practical Next Steps

### Running the App

```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables
# Create .env.local with:
#   YOUTUBE_API_KEY=your-key
#   # RunPod Fish Speech (primary TTS)
#   RUNPOD_API_KEY=your-runpod-key
#   RUNPOD_FISH_SPEECH_ENDPOINT_ID=your-endpoint-id
#   # Optional: Modal fallback (legacy)
#   # MODAL_TTS_URL=https://yourname--modalapp.modal.run
# DB_PATH and STORAGE_PATH default to ./data and ./data/storage

# 3. Start dev server
npm run dev

# 4. Open http://localhost:3000
```

The SQLite database and storage directories are created automatically on first request.

### Deploying RunPod Fish Speech Service

```bash
# 1. Build and push Docker image (GitHub Actions auto-builds)
# Image: ghcr.io/joelntemuse24/echomancer/fish-speech-worker:latest

# 2. Create RunPod Serverless Endpoint
# - Go to https://www.runpod.io/console/serverless
# - Use the pushed image
# - Select GPU: H100 or A100 80GB

# 3. Configure environment
# Update .env.local with your RunPod API key and Endpoint ID
```

### Testing the API Manually

```bash
# Upload a PDF
curl -X POST http://localhost:3000/api/pdf/upload \
  -F "file=@test.pdf"

# Search YouTube
curl "http://localhost:3000/api/youtube/search?q=narrator+voice&maxResults=5"

# Create a job (use storagePath from upload response)
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "pdfStoragePath": "pdfs/abc-123/test.pdf",
    "bookTitle": "Test Book",
    "voiceStoragePath": "voices/def-456/sample.wav",
    "voiceName": "Test Voice",
    "startTime": 0,
    "endTime": 15
  }'

# Check job status
curl http://localhost:3000/api/jobs/<jobId>

# List all jobs
curl http://localhost:3000/api/jobs
```

### Suggested Experiments

1. **Add job timeout cleanup**: Write a periodic check that marks jobs stuck in "processing" for >30 minutes as "failed". Could be a `setInterval` in a Next.js middleware or a separate script.

2. **Add file cleanup on job delete**: The DELETE route already removes PDF, voice, and audio files, but checkpoint directories remain. Add cleanup for `checkpoints/<jobId>/`.

3. **Replace polling with SSE**: Add a `GET /api/jobs/[id]/stream` endpoint that sends Server-Sent Events when a job updates. The frontend would use `EventSource` instead of `setInterval`.

4. **Add authentication**: Even a simple API key or session-based auth would prevent unauthorized access to stored files and job creation.

5. **Test the checkpoint resume**: Create a job, wait for partial progress, restart the server, then retry the job. Verify it resumes from checkpoints.

### Common Questions

**Q: Why does the first TTS call take 30-60 seconds?**
A: Modal containers scale to zero when idle. The first request after a cold start needs to load the container, initialize the GPU, and load models. Subsequent requests within the `scaledown_window` (5 minutes) are fast.

**Q: What happens if ffmpeg isn't installed?**
A: Voice enhancement, clipping, concatenation, and post-processing all fail. The generation pipeline catches these errors and falls back to simpler approaches (e.g., raw audio without EQ), but quality degrades significantly. ffmpeg must be installed on the Next.js server.

**Q: Can I use a different TTS model?**
A: Yes. The Modal TTS endpoint just needs to accept `{ reference_audio_base64, reference_text }` for voice prompt creation and `{ texts, prompt_key, language }` for generation. Swap the Modal deployment and update `MODAL_TTS_URL`.

**Q: Why is `startTime`/`endTime` capped at 60 in the Zod schema?**
A: The validation schema in `src/lib/validation.ts` limits clip times to 60 seconds, but the YouTube download route has no such limit. This is a bug — if you select a clip starting at 90 seconds, the job creation will clamp it to 60, but the downloaded audio will be from 90-120s. The fix would be to align the limits or remove the `max(60)` constraint.

**Q: Where is the Emotion Director used?**
A: Looking at the current `generate-audiobook-v2.ts`, the Emotion Director (`MODAL_LLM_DIRECTOR_URL`) is defined in `env.ts` but **not called** in the generation pipeline. It's a deployed service that's available but not yet integrated. To use it, you'd call it before TTS generation to get pacing/speed/emotion annotations for each text section.
