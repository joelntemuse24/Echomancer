# Echomancer v2 - AI Coding Agent Guide

> Transform PDFs into audiobooks with custom AI voice cloning.
>
> **Last updated:** June 2026

---

## Project Overview

Echomancer v2 is a full-stack web app that converts PDF documents into audiobooks using F5-TTS voice cloning. Users upload PDFs, provide a voice sample (upload or saved), clip a reference segment, and generate a full audiobook narrated in that voice.

### Core Features

- **PDF Upload**: Store documents in Cloudflare R2 (or local filesystem in dev)
- **Voice Cloning**: Upload audio or reuse saved voice samples
- **Voice Clipping**: Select 3–30 second reference segment from source audio
- **Voice Preview**: Short TTS sample via Modal `/generate_batch`
- **Background Processing**: Modal GPU pipeline with webhook progress updates
- **Audio Enhancement**: Demucs vocal isolation via Audio Cleaner service
- **Job Management**: Queue, retry, cancel, soft-delete with deduplication

---

## Technology Stack

### Frontend
- **Framework**: Next.js 16.1.6 (App Router)
- **Language**: TypeScript 5.x, strict mode
- **UI**: React 19.2.3 + shadcn/ui + Tailwind CSS 4
- **Animations**: motion/react
- **State**: React hooks only (no Redux/Zustand)
- **Progress updates**: Polling every 3s (not WebSockets)

### Backend (Vercel Serverless)
- **API Routes**: Next.js route handlers (`runtime = "nodejs"`)
- **Database**: Turso (LibSQL) — `src/lib/turso.ts`
- **Storage**: Cloudflare R2 via `src/lib/storage.ts` (local fallback)
- **Job trigger**: `src/lib/trigger-generation.ts` → Modal `/generate_audiobook`
- **Progress**: Modal webhooks → `POST /api/jobs/[id]/webhook`
- **Validation**: Zod schemas in `src/lib/validation.ts`

### AI/ML (Modal.com)
- **Primary app**: `modal/f5_tts_server.py` (F5-TTS on A10G GPU)
- **Audio cleaning**: `modal/audio_cleaner.py` (Demucs on T4)
- **Architecture**: CPU fastapi_app spawns GPU workers via `.map()`
- **Deploy**: `modal deploy f5_tts_server.py`

### Legacy (not used by current routes)
- `src/lib/db/` — local better-sqlite3 (dev only, not wired to API)
- `src/lib/storage/index.ts` — old local-only storage module
- YouTube search/download API routes (removed; UI has upload + saved only)

---

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── pdf/upload/              # PDF upload
│   │   ├── audio/upload/            # Voice sample upload
│   │   ├── jobs/
│   │   │   ├── route.ts             # Create + list jobs
│   │   │   └── [id]/
│   │   │       ├── route.ts         # Get, delete, retry
│   │   │       ├── webhook/route.ts # Modal progress callbacks
│   │   │       └── cancel/route.ts  # Cancel in-flight job
│   │   ├── voices/route.ts          # Saved voice CRUD
│   │   ├── voice/preview/route.ts   # Short TTS preview
│   │   ├── voice/analyze/route.ts   # Voice quality check
│   │   ├── modal/warmup/route.ts    # GPU pre-warm
│   │   ├── storage/[[...path]]/     # File serving (R2/local)
│   │   └── health/route.ts
│   └── dashboard/
│       ├── voice/page.tsx           # Upload + saved voices
│       ├── voice/clip/page.tsx      # Clip + create job
│       ├── queue/page.tsx           # Job queue (polling)
│       ├── player/[id]/page.tsx     # Audiobook player
│       └── resources/page.tsx
├── components/
│   ├── ui/                          # shadcn/ui
│   ├── modal-warmup-loader.tsx
│   └── tts-generator.tsx
├── hooks/
│   └── useAudioProcessor.ts         # Web Audio API effects
└── lib/
    ├── turso.ts                     # Turso client
    ├── turso/jobs.ts                # Job CRUD
    ├── storage.ts                     # R2/local unified storage
    ├── r2-storage.ts                # R2 S3 client
    ├── trigger-generation.ts        # Modal job trigger (SHARED)
    ├── modal-client.ts              # Warmup + health check
    ├── env.ts, errors.ts, validation.ts, rate-limit.ts
    └── text-extraction.ts           # Used for non-PDF formats (if added)

modal/
├── f5_tts_server.py                 # PRIMARY — deploy this
└── audio_cleaner.py                 # Vocal isolation service
```

---

## Architecture

### Data Flow

```
1. User uploads PDF → R2 (or local ./data/storage)
2. User uploads voice OR picks saved voice
3. User clips 3–30s reference segment on /dashboard/voice/clip
4. POST /api/jobs → insert Turso row (status: queued)
5. triggerAudiobookGeneration() → POST Modal /generate_audiobook
   - Passes R2 keys + webhook URL
   - Returns immediately (no Vercel timeout)
6. Modal process_audiobook orchestrator:
   a. Download PDF + voice from R2
   b. Extract text (PyMuPDF), split into paragraphs
   c. Clean voice (Audio Cleaner), transcribe (faster-whisper)
   d. Farm paragraph batches to F5TTSAudiobookWorker (.map(), max 4 GPU)
   e. Concatenate partials, upload final MP3 to R2
   f. Webhook progress → POST /api/jobs/{id}/webhook
7. Frontend polls GET /api/jobs every 3s
8. User plays audiobook from /api/storage/{audio_storage_path}
```

### Critical Files — Do Not Duplicate Logic

| Concern | Single Source of Truth |
|---------|----------------------|
| Trigger Modal generation | `src/lib/trigger-generation.ts` |
| Job DB updates | `src/lib/turso/jobs.ts` |
| Storage read/write | `src/lib/storage.ts` |
| Audiobook pipeline | `modal/f5_tts_server.py` |

**Never re-implement generation in Next.js.** The old `generate-audiobook-v2.ts` was removed.

### Database Schema (Turso)

Run `migrate-turso.sql` if schema is stale.

**Active tables:**
- `jobs` — audiobook generation jobs
- `voices` — saved voice samples
- `usage_logs` — action tracking

**Job statuses:** `queued` → `processing` → `ready` | `failed`

Soft delete via `deleted_at` column (NULL = active).

---

## Environment Variables

```bash
# Required — Turso
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token

# Required — Modal
MODAL_TTS_URL=https://yourname--echomancer-f5-tts-fastapi-app.modal.run/generate_batch

# Required for production — R2
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=echomancer-audio
R2_PUBLIC_URL=https://your-r2-public-domain  # optional

# Required for production webhooks
WEBHOOK_SECRET=your-webhook-secret
NEXT_PUBLIC_APP_URL=https://echomancer-v2.vercel.app

# Optional — local dev fallback
STORAGE_PATH=./data/storage
```

Modal secrets (set via `modal secret create`):
- R2 credentials (same as above)
- `AUDIO_CLEANER_URL` — Audio Cleaner service endpoint

---

## Build and Development Commands

```bash
npm install
npm run dev          # http://localhost:3000
npm run build
npm run start
npm run lint
npm run test         # vitest

# Deploy Modal (from project root)
cd modal && modal deploy f5_tts_server.py
cd modal && modal deploy audio_cleaner.py

# Deploy frontend
npx vercel --prod
```

### Development Workflow

1. Set `.env.local` with Turso + Modal URLs (minimum)
2. Run `migrate-turso.sql` in Turso dashboard if needed
3. `npm run dev`
4. Upload PDF → voice → clip → create job
5. Monitor Modal logs: `modal app logs echomancer-f5-tts`

**Note:** Local dev webhooks go to production Vercel URL (hardcoded fallback in `trigger-generation.ts`). Share Turso credentials to see progress locally.

---

## Code Style Guidelines

### TypeScript
- Strict mode, `noUncheckedIndexedAccess: true`
- Path alias: `@/*` → `src/*`
- All API inputs validated with Zod
- Use `handleApiError()` in all API route catch blocks

### Naming
- Components: PascalCase
- Utilities: camelCase (`triggerAudiobookGeneration`)
- DB columns: snake_case
- Route files: kebab-case directories

### Logging
- Prefix with `[Job ${jobId}]` for generation-related logs
- Prefix with `[Webhook]`, `[Warmup]`, `[Storage]` for subsystem logs

### Patterns to Follow
- Fire-and-forget for Modal triggers (never `await` in the request handler)
- Monotonic progress guards in webhook handler
- Rate limiting on job creation (5/min) and preview (3/min)
- Soft delete jobs, don't hard-delete rows

### Patterns to Avoid
- Don't add generation logic to Next.js API routes
- Don't import from `src/lib/db/` in new code (use Turso)
- Don't create a second Modal trigger function (use `trigger-generation.ts`)
- Don't bypass `storage.ts` for file operations

---

## Testing Instructions

### Manual Checklist

1. **PDF Upload** — various sizes, scanned PDF should fail gracefully on Modal
2. **Voice Upload** — MP3/WAV/M4A, reject >10MB
3. **Voice Preview** — hear short TTS sample before creating job
4. **Job Creation** — appears in queue as `queued`, transitions to `processing`
5. **Progress** — progress bar updates via polling
6. **Completion** — status `ready`, audio playable in player
7. **Retry** — failed job can be retried (re-triggers Modal)
8. **Cancel** — in-flight job marked `failed`
9. **Deduplication** — same PDF+voice+clip returns existing `ready` job
10. **Delete** — soft-deletes job, removes storage files

### API Testing

```bash
# Health
curl http://localhost:3000/api/health

# Modal health (replace base URL)
curl https://yourname--echomancer-f5-tts-fastapi-app.modal.run/health

# Create job
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"pdfStoragePath":"pdfs/...","voiceStoragePath":"voices/...","startTime":0,"endTime":15}'

# Warmup GPU
curl -X POST http://localhost:3000/api/modal/warmup \
  -H "Content-Type: application/json" \
  -d '{"containers":2}'
```

---

## Deployment

### Vercel (Production)
1. Import `joelntemuse24/Echomancer` on Vercel
2. Set all env vars (see above)
3. Deploy — auto-builds on push to `main`

### Modal (GPU Workers)
```bash
cd modal
modal deploy f5_tts_server.py
# Set MODAL_TTS_URL to fastapi_app URL + /generate_batch

modal deploy audio_cleaner.py
# Set AUDIO_CLEANER_URL in Modal secrets
```

See `DEPLOYMENT.md` and `TURSO_R2_SETUP.md` for detailed setup.

---

## Known Issues and Limitations

### Fixed
- Retry path now re-triggers Modal (was stuck at `queued` forever)
- Voice clip time validation aligned (up to 36000s)
- Job deduplication prevents duplicate GPU work
- Rate limiting on job creation and preview
- Webhook monotonic guards prevent progress regression

### Current Limitations
- **No auth**: All jobs are `user_id = "anonymous"`
- **Cancel doesn't stop Modal**: GPU work continues after Turso status change
- **No checkpoint resume**: Modal retries start from scratch
- **YouTube removed**: Voice selection is upload + saved only
- **In-memory rate limits**: Reset on serverless cold start
- **Local webhook**: Progress updates go to production URL during local dev

### Modal-Specific
- **Cold start**: 30–90s first request after idle; use warmup endpoint
- **GPU**: A10G, max 4 parallel containers
- **Timeout**: Orchestrator has 3600s (1 hour) max

---

## Security Considerations

- Webhook auth via `WEBHOOK_SECRET` header (production)
- Path traversal protection on local storage route
- Security headers in `next.config.ts` (HSTS, X-Frame-Options, etc.)
- Rate limiting on sensitive endpoints
- **Needs hardening**: User authentication, per-user data isolation, magic-byte file validation

---

## Cost Considerations

| Service | Typical Cost |
|---------|-------------|
| Vercel | Free tier / $20/mo Pro |
| Turso | Free tier / ~$5/mo |
| Cloudflare R2 | ~$0.015/GB storage, zero egress |
| Modal GPU | ~$0.03–0.07 per audiobook |

---

## Related Documentation

| File | Purpose |
|------|---------|
| `CODEBASE_MASTERY_GUIDE.md` | Deep-dive architecture guide |
| `DEPLOYMENT.md` | Vercel deployment |
| `TURSO_R2_SETUP.md` | DB + storage setup |
| `F5-TTS-MODAL-SETUP.md` | Modal deployment |
| `migrate-turso.sql` | Current schema |
| `CODE_REVIEW_BUGS.md` | Bug history |
| `ISSUES_SUMMARY.md` | Active issues |

---

## Useful Commands

```bash
modal app list
modal app logs echomancer-f5-tts
modal secret list

# Test Modal F5-TTS
python test-f5-modal.py

# Turso CLI
turso db shell echomancer
```

---

*For deep architectural understanding, read `CODEBASE_MASTERY_GUIDE.md`.*