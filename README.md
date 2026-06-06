# Echomancer v2

Transform PDFs into audiobooks with custom AI voice cloning.

Upload a document, provide a short voice sample, and Echomancer generates a full audiobook narrated in that voice using F5-TTS on Modal GPU workers.

**Live app:** [echomancer-v2.vercel.app](https://echomancer-v2.vercel.app)

---

## Architecture

```
Frontend     Next.js 16 (React 19, TypeScript 5, Tailwind 4)
Database     Turso (edge SQLite)
Storage      Cloudflare R2 (local filesystem fallback in dev)
TTS          F5-TTS via Modal.com (A10G GPU, parallel workers)
Hosting      Vercel (serverless API + dashboard)
```

```
Browser → Vercel API → Turso (jobs) + R2 (files)
                    ↓
              Modal /generate_audiobook
                    ↓
         GPU workers synthesize audio → upload MP3 to R2
                    ↓
         Webhooks update job progress → frontend polls every 3s
```

---

## Features

- **PDF upload** — documents stored in R2 (or local disk in dev)
- **Voice cloning** — upload a voice sample or reuse saved voices
- **Voice clipping** — pick a 3–30 second reference segment
- **Voice preview** — hear a short TTS sample before generating
- **Background generation** — Modal GPU pipeline runs independently of Vercel timeouts
- **Progress tracking** — real-time status via webhooks + polling
- **Job management** — queue, retry, cancel, deduplication
- **Audio player** — built-in player with EQ and playback controls

---

## Quick Start (Local Dev)

### Prerequisites

- Node.js 18+
- [Turso](https://turso.tech/) database (free tier works)
- [Modal](https://modal.com/) account with F5-TTS deployed
- Optional: [Cloudflare R2](https://developers.cloudflare.com/r2/) bucket (falls back to local storage without it)

### 1. Clone and install

```bash
git clone https://github.com/joelntemuse24/Echomancer.git
cd Echomancer
npm install
```

### 2. Configure environment

Create `.env.local`:

```bash
# Turso (required)
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token

# Modal F5-TTS (required)
MODAL_TTS_URL=https://yourname--echomancer-f5-tts-fastapi-app.modal.run/generate_batch

# Cloudflare R2 (required for production, optional for local dev)
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=echomancer-audio

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
WEBHOOK_SECRET=your-webhook-secret
```

Run `migrate-turso.sql` in the Turso dashboard if setting up a fresh database.

### 3. Deploy Modal workers

```bash
cd modal
modal deploy f5_tts_server.py
modal deploy audio_cleaner.py   # optional vocal isolation
```

Copy the `fastapi_app` URL into `MODAL_TTS_URL` with `/generate_batch` appended.

### 4. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## How It Works

1. **Upload PDF** → stored in R2 (or `./data/storage` locally)
2. **Select voice** → upload audio or pick a saved voice
3. **Clip voice** → choose a 3–30s reference segment; optionally preview TTS
4. **Create job** → record inserted in Turso, Modal generation triggered
5. **Modal pipeline** → downloads files from R2, extracts text, synthesizes paragraphs in parallel on GPU, uploads final MP3
6. **Progress updates** → Modal sends webhooks; frontend polls `/api/jobs` every 3 seconds
7. **Listen** → play or download the finished audiobook

---

## Project Structure

```
src/
├── app/
│   ├── page.tsx                    # Landing page
│   ├── api/
│   │   ├── pdf/upload/             # PDF upload
│   │   ├── audio/upload/           # Voice sample upload
│   │   ├── jobs/                   # Job CRUD + webhooks
│   │   ├── voices/                 # Saved voices
│   │   ├── voice/preview/          # TTS preview
│   │   ├── modal/warmup/           # GPU pre-warm
│   │   └── storage/[[...path]]/    # File serving
│   └── dashboard/
│       ├── voice/                  # Voice selection + clipping
│       ├── queue/                  # Job queue
│       └── player/[id]/            # Audiobook player
├── components/                     # UI components (shadcn/ui)
└── lib/
    ├── turso.ts                    # Database client
    ├── storage.ts                  # R2/local storage
    ├── trigger-generation.ts       # Modal job trigger
    └── modal-client.ts             # GPU warmup helpers

modal/
├── f5_tts_server.py                # F5-TTS audiobook pipeline
└── audio_cleaner.py                # Vocal isolation service
```

---

## Deployment

### Vercel (recommended for frontend)

```bash
npx vercel --prod
```

Or connect the GitHub repo at [vercel.com/new](https://vercel.com/new) and set all environment variables from `.env.local`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full guide.

### Modal (required for TTS)

```bash
cd modal
modal deploy f5_tts_server.py
```

Set Modal secrets for R2 credentials and `AUDIO_CLEANER_URL`. See [F5-TTS-MODAL-SETUP.md](F5-TTS-MODAL-SETUP.md).

### Turso + R2 setup

See [TURSO_R2_SETUP.md](TURSO_R2_SETUP.md).

---

## Scripts

```bash
npm run dev       # Development server
npm run build     # Production build
npm run start     # Start production server
npm run lint      # ESLint
npm run test      # Vitest
```

---

## Costs (typical)

| Service | Cost |
|---------|------|
| Vercel | Free tier / $20/mo Pro |
| Turso | Free tier / ~$5/mo |
| Cloudflare R2 | ~$0.015/GB, zero egress |
| Modal GPU | ~$0.03–0.07 per audiobook |

---

## Documentation

| File | Description |
|------|-------------|
| [CODEBASE_MASTERY_GUIDE.md](CODEBASE_MASTERY_GUIDE.md) | Deep architecture walkthrough |
| [AGENTS.md](AGENTS.md) | AI coding agent reference |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Vercel deployment guide |
| [TURSO_R2_SETUP.md](TURSO_R2_SETUP.md) | Database and storage setup |
| [F5-TTS-MODAL-SETUP.md](F5-TTS-MODAL-SETUP.md) | Modal GPU deployment |

---

## License

Private — All rights reserved