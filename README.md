# Echomancer v2

Transform PDFs into audiobooks with custom AI voices from YouTube.

## Architecture

```
Frontend:    Next.js 16 App Router (React 19, TypeScript 5)
Database:    SQLite (better-sqlite3) with WAL mode
Storage:    Local filesystem (./data/storage)
TTS:         VoxCPM2 via Modal.com (serverless GPU)
Voice Clone: Local audio processing with voice enhancement
```

**Self-hosted** — runs entirely on your infrastructure with optional Modal GPU workers.

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
└── modal/                            # Modal.com GPU workers
    ├── voxcpm_server.py              # VoxCPM2 TTS server
    ├── voxcpm_vllm_server.py        # VoxCPM2 with vLLM
    ├── audio_cleaner.py             # Voice enhancement
    └── f5_tts_server.py             # Alternative F5-TTS

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
- Python 3.10+ (for Modal GPU workers, optional)
- YouTube Data API key (for YouTube search)

### 2. Get API Keys

| Service | Purpose | URL |
|---------|---------|-----|
| YouTube Data API | Video search | https://console.cloud.google.com/apis/credentials |
| Modal (optional) | GPU TTS workers | https://modal.com |

### 3. Configure Environment

Create `.env.local`:

```bash
# === LOCAL STORAGE & DATABASE ===
DB_PATH=./data
STORAGE_PATH=./data/storage

# === MODAL (Optional - for GPU TTS) ===
MODAL_TTS_URL=https://your-modal-endpoint.modal.run
MODAL_AUDIO_CLEANER_URL=https://your-cleaner-endpoint.modal.run

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
5. **Background Processing** → `generateAudiobookV2()` runs TTS via Modal GPU workers
6. **Polling Updates** → Frontend polls job status every 2 seconds
7. **Download/Play** → Generated audio served via local storage API

## Key Features

- **Self-Hosted**: SQLite + local storage — no external database needed
- **GPU TTS**: Modal.com workers for fast voice cloning (VoxCPM2)
- **Resume Capability**: Checkpoints saved after each batch, jobs can resume
- **Voice Enhancement**: Automatic audio cleaning with Demucs + Silero VAD
- **Progress Tracking**: Real-time progress with section-by-section updates

## Deployment Options

### Option 1: Local/Development

```bash
npm install
npm run dev
```

Data stored in `./data/` directory (SQLite + file storage).

### Option 2: Modal GPU Workers (Production TTS)

Deploy TTS workers for GPU acceleration:

```bash
cd modal
modal deploy voxcpm_vllm_server.py
modal deploy audio_cleaner.py
```

Update `MODAL_TTS_URL` in `.env.local` with your Modal endpoint.

### Option 3: RunPod Serverless (Alternative GPU)

A RunPod worker is included in `runpod/` directory:

```bash
cd runpod
docker build -t fish-speech .
# Push to registry and deploy on RunPod
```

See `runpod/README.md` for detailed instructions.

### Option 4: Vercel (Frontend only)

Note: Vercel has limitations for long-running background jobs. For full functionality, use a VPS or self-hosted option.

```bash
npx vercel
```

## Costs

| Component | Self-Hosted | Cloud |
|-----------|-------------|-------|
| Database | Free (SQLite) | - |
| Storage | Free (local disk) | - |
| TTS Inference | Free (CPU) / Modal $0.001-0.01/sec | RunPod ~$0.50/hr |
| YouTube API | Free tier: 10k quota units/day | - |

**Typical audiobook cost**: ~$0.05-0.50 depending on length (with Modal GPU workers)

## License

Private - All rights reserved
