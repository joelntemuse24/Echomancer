# Echomancer v2

Transform PDFs into audiobooks with custom AI voices from YouTube.

## Architecture

```
Frontend:    Next.js 16 App Router (React 19, TypeScript 5)
Database:    SQLite (better-sqlite3) with WAL mode
Storage:    Local filesystem (./data/storage)
TTS:         Fish Speech S2 Pro via RunPod Serverless
Voice Clone: RunPod GPU inference with reference audio
```

**Self-hosted** — SQLite + local storage with RunPod GPU workers for TTS inference.

## Project Structure

```
src/
├── app/
│   ├── page.tsx                      # Landing page
│   ├── layout.tsx                    # Root layout (dark theme, Toaster)
│   ├── api/
│   │   ├── pdf/upload/route.ts       # PDF upload → local storage
│   │   ├── youtube/search/route.ts   # YouTube Data API proxy
│   │   ├── audio/upload/route.ts     # Voice sample upload → local storage
│   │   ├── voice/preview/route.ts    # Voice preview generation
│   │   ├── storage/[[...path]]/      # Storage file serving
│   │   └── jobs/                     # Job CRUD + background generation
│   │       ├── route.ts              # Create/list jobs
│   │       └── [id]/                 # Get/update/delete jobs
│   └── dashboard/
│       ├── layout.tsx                # Sidebar navigation
│       ├── page.tsx                  # PDF upload (step 1)
│       ├── voice/
│       │   ├── page.tsx              # Voice selection (step 2)
│       │   └── clip/page.tsx         # Voice clipping (step 3)
│       ├── queue/page.tsx            # Job queue with polling
│       ├── player/[id]/page.tsx      # Audio player
│       └── resources/page.tsx        # Help & FAQ
├── components/
│   ├── Logo.tsx
│   └── ui/                           # shadcn/ui components
├── lib/
│   ├── db/                           # SQLite database layer
│   │   ├── index.ts                  # Database connection
│   │   └── jobs.ts                   # Job queries
│   ├── storage/                      # Local file storage
│   │   └── index.ts                  # Storage operations
│   ├── generate-audiobook-v2.ts      # Background generation logic
│   ├── text-extraction.ts            # PDF text extraction
│   ├── voice-quality-checker.ts     # Voice sample validation
│   ├── env.ts                        # Environment validation
│   ├── errors.ts                     # Error handling
│   └── validation.ts                 # Zod schemas
└── runpod/                           # RunPod Serverless GPU workers
    ├── src/                          # Fish Speech S2 Pro worker
    │   ├── handler.py                # RunPod handler
    │   └── run.sh                    # Startup script
    ├── Dockerfile                    # Container build
    └── README.md                     # Deployment guide

data/                                 # Runtime data (gitignored)
├── echomancer.db                     # SQLite database
└── storage/                          # File storage
    ├── pdfs/                         # Uploaded PDFs
    ├── voices/                       # Voice samples
    ├── audiobooks/                   # Generated audiobooks
    └── checkpoints/                # Generation checkpoints
```

## Quick Start

### 1. Prerequisites

- Node.js 18+ 
- RunPod account with Fish Speech endpoint (see runpod/README.md)
- YouTube Data API key (for YouTube search)

### 2. Get API Keys

| Service | Purpose | URL |
|---------|---------|-----|
| YouTube Data API | Video search | https://console.cloud.google.com/apis/credentials |
| RunPod | GPU TTS inference | https://www.runpod.io/console/serverless |

### 3. Configure Environment

Create `.env.local`:

```bash
# === LOCAL STORAGE & DATABASE ===
DB_PATH=./data
STORAGE_PATH=./data/storage

# === RUNPOD FISH SPEECH (Required for TTS) ===
RUNPOD_API_KEY=your_runpod_api_key_here
RUNPOD_FISH_SPEECH_ENDPOINT_ID=your_endpoint_id_here

# === YOUTUBE (Required) ===
YOUTUBE_API_KEY=your_youtube_api_key_here

# === APP URL ===
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 4. Install & Run

```bash
npm install
npm run dev
```

Open http://localhost:3000

The SQLite database and local storage directories will be created automatically on first run.

## How It Works

1. **Upload PDF** → Stored in local filesystem, text extracted with `unpdf`
2. **Select Voice** → Search YouTube or upload audio sample
3. **Clip Voice** → Select time range for voice reference (max 30s)
4. **Create Job** → Job record created in SQLite, background generation starts
5. **Background Processing** → `generateAudiobookV2()` runs TTS via RunPod Fish Speech endpoint
6. **Polling Updates** → Frontend polls job status every 2 seconds
7. **Download/Play** → Generated audio served via local storage API

## Key Features

- **Self-Hosted**: SQLite + local storage — no external database needed
- **GPU TTS**: RunPod serverless with Fish Speech S2 Pro
- **Voice Cloning**: Zero-shot voice cloning with reference audio
- **Resume Capability**: Checkpoints saved after each batch, jobs can resume
- **Progress Tracking**: Real-time progress with section-by-section updates

## Deployment Options

### Option 1: Local/Development

```bash
npm install
npm run dev
```

Data stored in `./data/` directory (SQLite + file storage).

### Option 2: RunPod Serverless (Production TTS)

Deploy the Fish Speech worker to RunPod:

1. **Build & Push Docker Image** (GitHub Actions auto-builds):
   - Image: `ghcr.io/joelntemuse24/echomancer/fish-speech-worker:latest`

2. **Create RunPod Endpoint**:
   - Go to https://www.runpod.io/console/serverless
   - Use your pushed image
   - GPU: H100 or A100 80GB
   - Workers: 1 (always ready) or 0 (scale to demand)

3. **Configure env vars**:
   ```bash
   RUNPOD_API_KEY=your_runpod_key
   RUNPOD_FISH_SPEECH_ENDPOINT_ID=your_endpoint_id
   ```

See `runpod/README.md` for detailed instructions.

### Option 3: Vercel (Frontend only)

Note: Vercel has limitations for long-running background jobs. For full functionality, use a VPS or self-hosted option.

```bash
npx vercel
```

## Costs

| Component | Self-Hosted | Cloud |
|-----------|-------------|-------|
| Database | Free (SQLite) | - |
| Storage | Free (local disk) | - |
| TTS Inference | Free (CPU fallback) / RunPod pay-per-use | ~$0.001-0.005/sec |

**Typical audiobook cost**: ~$0.05-0.30 depending on length (with RunPod GPU)

## License

Private - All rights reserved
