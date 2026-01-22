# Echomancer

Transform PDFs into audiobooks with custom voices from YouTube. Upload any PDF, search YouTube for the exact voice you want, clip a few seconds with one click, and get a full-length audiobook narrated in that voice.

## Features

- **PDF Upload & Text Extraction** - Upload PDFs up to 100MB, extract text with pdfplumber
- **YouTube Voice Search** - Search YouTube videos using YouTube Data API v3
- **Client-Side Audio Clipping** - Clip audio samples using FFmpeg.wasm in the browser
- **AI Voice Cloning** - Generate audiobooks using Fish Speech V1.5 via Replicate
- **Clerk Authentication** - Secure user authentication
- **Paddle.com Payments** - One-time and subscription payment options
- **Background Jobs** - ARQ (async Redis queue) for audiobook processing
- **Bunny.net CDN** - Fast CDN for audio file delivery

## Architecture

```
echomancer/
├── frontend/          # React + Vite + TypeScript
├── backend/           # Python FastAPI backend
│   ├── app/
│   │   ├── main.py           # FastAPI application
│   │   ├── config.py         # Settings & environment
│   │   ├── routers/          # API endpoints
│   │   │   ├── pdf.py        # PDF upload & extraction
│   │   │   ├── youtube.py    # YouTube search
│   │   │   ├── audio.py      # Audio sample upload
│   │   │   ├── queue.py      # Job queue management
│   │   │   ├── payment.py    # Paddle payments
│   │   │   └── health.py     # Health checks
│   │   ├── services/         # Business logic
│   │   │   ├── pdf.py        # PDF text extraction
│   │   │   ├── youtube.py    # YouTube API + yt-dlp
│   │   │   ├── tts.py        # Fish Speech via Replicate
│   │   │   ├── audio.py      # FFmpeg audio processing
│   │   │   └── bunny.py      # CDN uploads
│   │   └── workers/          # Background job processors
│   │       └── audiobook.py  # Main audiobook generation worker
│   └── requirements.txt
└── package.json
```

## Prerequisites

- **Python 3.11+**
- **Node.js 20+** (for frontend)
- **Redis** (for job queue)
- **FFmpeg** (for audio processing)
- **yt-dlp** (for YouTube audio download)

## Quick Start

### 1. Install Backend Dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Install Frontend Dependencies

```bash
cd frontend
npm install
```

### 3. Configure Environment

Copy the example env file and fill in your API keys:

```bash
cd backend
cp .env.example .env
```

**Required API Keys:**

| Service | Purpose | Get it at |
|---------|---------|-----------|
| Replicate | Fish Speech TTS | https://replicate.com/account/api-tokens |
| YouTube Data API | Video search | https://console.cloud.google.com/apis/credentials |
| Bunny.net | File storage/CDN | https://bunny.net |

**Optional for Production:**

| Service | Purpose | Get it at |
|---------|---------|-----------|
| Clerk | User authentication | https://dashboard.clerk.com |
| Paddle | Payments | https://vendors.paddle.com |

### 4. Start Redis

```bash
# Using Docker
docker run -d -p 6379:6379 redis:alpine

# Or using local Redis
redis-server
```

### 5. Start the Backend

```bash
cd backend
uvicorn app.main:app --reload --port 8000
```

### 6. Start the Background Worker

In a separate terminal:

```bash
cd backend
arq app.workers.audiobook.WorkerSettings
```

### 7. Start the Frontend

```bash
cd frontend
npm run dev
```

The app will be available at http://localhost:3000

## API Endpoints

### Health
- `GET /health` - Service health check

### PDF
- `POST /api/pdf/upload` - Upload PDF file (multipart/form-data)
- `GET /api/pdf/text?pdf_url=...` - Extract text from PDF URL

### YouTube
- `GET /api/youtube/search?q=query` - Search YouTube videos
- `GET /api/youtube/video/{video_id}` - Get video details

### Audio
- `POST /api/audio/upload-sample` - Upload voice sample (multipart/form-data)

### Queue
- `POST /api/queue/create` - Create audiobook job
- `GET /api/queue/job/{job_id}` - Get job status
- `GET /api/queue/jobs` - Get all user jobs

### Payment
- `POST /api/payment/checkout/one-time` - Create one-time checkout
- `POST /api/payment/checkout/subscription` - Create subscription checkout
- `GET /api/payment/subscription-status` - Get subscription status
- `POST /api/payment/webhook` - Paddle webhook handler

## How It Works

1. **Upload PDF** - User uploads a PDF, text is extracted using pdfplumber
2. **Select Voice** - User searches YouTube for a voice or uploads their own audio sample
3. **Clip Audio** - Client-side FFmpeg.wasm clips the selected portion
4. **Create Job** - Job is queued in Redis via ARQ
5. **Process** - Background worker:
   - Downloads voice sample from YouTube (yt-dlp) or uses uploaded file
   - Uploads voice sample to Bunny CDN
   - Calls Fish Speech on Replicate with text + voice sample
   - Uploads final audiobook to Bunny CDN
6. **Deliver** - User can stream or download the audiobook

## TTS Provider

The app uses **Fish Speech V1.5** via **Replicate** for voice cloning.

**Why Replicate?**
- No GPU infrastructure to manage
- Pay per second of compute (~$0.00055/sec)
- Same open-source model - no vendor lock-in
- Can self-host Fish Speech later if needed

**Replicate Pricing:**
- ~$0.10-0.50 per audiobook (depends on length)
- No monthly minimums

## Environment Variables

See `backend/.env.example` for all configuration options.

**Key Settings:**

```env
# Required
REPLICATE_API_TOKEN=r8_...
YOUTUBE_API_KEY=AIza...
BUNNY_STORAGE_ZONE=your-zone
BUNNY_API_KEY=...
BUNNY_CDN_URL=https://your-zone.b-cdn.net

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Optional (for payments/auth)
CLERK_SECRET_KEY=sk_test_...
PADDLE_API_KEY=...
```

## Development

### API Documentation

FastAPI auto-generates API docs:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### Running Tests

```bash
cd backend
pytest
```

### Code Style

```bash
# Backend (Python)
black app/
isort app/

# Frontend (TypeScript)
cd frontend
npm run lint
```

## Production Deployment

1. Set all environment variables
2. Use a production Redis instance (e.g., Upstash, Redis Cloud)
3. Deploy backend to a Python-compatible host (Railway, Render, Fly.io)
4. Deploy frontend to a static host (Vercel, Netlify)
5. Set up Paddle webhooks pointing to your backend
6. Configure Clerk for production

## Costs

| Service | Typical Cost |
|---------|--------------|
| Replicate (Fish Speech) | ~$0.10-0.50 per audiobook |
| Bunny.net CDN | ~$0.01/GB storage, ~$0.01/GB transfer |
| Redis (Upstash) | Free tier available |
| YouTube API | Free tier (10k requests/day) |

## License

Private - All rights reserved
