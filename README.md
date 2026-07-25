# Echomancer v2

Transform documents into audiobooks with **stock AI narrators** (default) or **custom voice cloning** (premium).

**Live app:** [echomancer-v2.vercel.app](https://echomancer-v2.vercel.app)

---

## What’s new

| Mode | Description |
|------|-------------|
| **Listen now** | Live stream from Google / Gemini 2.5 / Grok TTS (~1h cap) |
| **Full audiobook** | Offline take-home generation → downloadable sections |
| **Clone (premium)** | MOSS-TTS voice clone on Modal GPU (soft-gated) |

**Price target:** ~**€4.50** for a typical standard take-home book. Actual quote is **dynamic** from length + engine (`src/lib/tts/pricing.ts`).

---

## Architecture

```
Frontend     Next.js 16 (React 19, TypeScript, Tailwind 4)
Database     Turso (edge SQLite)
Storage      Cloudflare R2
Stock TTS    Google WaveNet/Neural2 · Gemini 2.5 Flash TTS · Grok TTS
Clone TTS    MOSS-TTS via Modal (premium)
Hosting      Vercel
```

### Stock (default)

```
Browser → POST /api/jobs (stream | takehome)
  stream   → GET /api/jobs/{id}/stream  (provider audio pipe)
  takehome → POST /api/jobs/{id}/process (sections → R2, self-chain)
```

### Clone (premium)

```
Browser → Modal /generate_audiobook → webhooks → ready MP3
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- Turso database
- At least one stock TTS API key (Google and/or Gemini and/or xAI)
- Optional: Modal + MOSS for premium clone; R2 for production storage

### Install

```bash
git clone https://github.com/joelntemuse24/Echomancer.git
cd Echomancer
npm install
```

### Environment

```bash
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token

# Stock TTS — preferred: single OpenRouter key (lists all speech models live)
OPENROUTER_API_KEY=sk-or-...

# Optional direct providers if not using OpenRouter
# GOOGLE_TTS_API_KEY=...
# GEMINI_API_KEY=...
# XAI_API_KEY=...

# Soft premium gate for MOSS clone
PREMIUM_CLONE_ENABLED=false
INTERNAL_JOB_SECRET=some-long-secret

# Pricing knobs (optional)
TTS_PRICE_MARKUP=2.0
TTS_PRICE_FIXED_EUR=0.5
STREAM_MAX_AUDIO_SECONDS=3600

# Storage
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=echomancer-audio

NEXT_PUBLIC_APP_URL=http://localhost:3000

# Premium clone only
MOSS_AB_VARIANT=sglang
MODAL_MOSS_SGLANG_TTS_URL=https://...
WEBHOOK_SECRET=...
```

```bash
npm run dev
```

---

## API sketch

| Endpoint | Purpose |
|----------|---------|
| `GET /api/tts/voices` | Catalog + optional `?charCount=` price estimates |
| `POST /api/jobs` | Create `stock` stream/takehome or `clone` job |
| `GET /api/jobs/{id}/stream` | Live listen audio stream |
| `POST /api/jobs/{id}/process` | Take-home section worker (internal secret) |
| `POST /api/jobs/{id}/takehome` | Spawn full book from a stream session |

---

## Docs

| File | Purpose |
|------|---------|
| [AGENTS.md](AGENTS.md) | Agent / architecture guide |
| [TURSO_R2_SETUP.md](TURSO_R2_SETUP.md) | Database + storage |
| [MOSI_API_SETUP.md](MOSI_API_SETUP.md) | MOSS / Modal clone |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Vercel deploy |

---

## License

Private project.
