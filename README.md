# Echomancer v2

Transform documents into audiobooks with **AI narrators via OpenRouter** — stock TTS voices (default) or **premium HD models** like Minimax Speech-02 HD.

**Live app:** [echomancer-v2.vercel.app](https://echomancer-v2.vercel.app)

---

## What’s new

| Mode | Description |
|------|-------------|
| **Listen now** | Live stream from OpenRouter TTS voices (~1h cap) |
| **Full audiobook** | Offline take-home generation → downloadable sections |
| **HD Premium** | Minimax Speech-02 HD and similar high-quality models (soft-gated) |

**Price target:** ~**€4.50** for a typical standard take-home book. Actual quote is **dynamic** from length + engine (`src/lib/tts/pricing.ts`).

---

## Architecture

```
Frontend     Next.js 16 (React 19, TypeScript, Tailwind 4)
Database     Turso (edge SQLite)
Storage      Cloudflare R2
Stock TTS    OpenRouter (Google · Gemini · Grok · Minimax · OpenAI)
HD Premium   Minimax Speech-02 HD via OpenRouter (soft-gated)
Hosting      Vercel
```

### Stock (default)

```
Browser → POST /api/jobs (stream | takehome)
  stream   → GET /api/jobs/{id}/stream  (provider audio pipe)
  takehome → POST /api/jobs/{id}/process (sections → R2, self-chain)
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- Turso database
- At least one TTS API key (OpenRouter preferred — covers all speech models)
- Optional: R2 for production storage

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

# Soft premium gate for HD voices (Minimax etc.)
PREMIUM_HD_ENABLED=false
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
```

```bash
npm run dev
```

---

## API sketch

| Endpoint | Purpose |
|----------|---------|
| `GET /api/tts/voices` | Catalog + optional `?charCount=` price estimates |
| `POST /api/jobs` | Create `stock` stream/takehome job |
| `GET /api/jobs/{id}/stream` | Live listen audio stream |
| `POST /api/jobs/{id}/process` | Take-home section worker (internal secret) |
| `POST /api/jobs/{id}/takehome` | Spawn full book from a stream session |

---

## Docs

| File | Purpose |
|------|---------|
| [AGENTS.md](AGENTS.md) | Agent / architecture guide |
| [TURSO_R2_SETUP.md](TURSO_R2_SETUP.md) | Database + storage |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Vercel deploy |

---

## License

Private project.
