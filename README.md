# Echomancer v2

Transform documents into audiobooks with **Fish Audio** — default Narrator, optional voice cloning, Live Stream and whole-book download.

**Live app:** [echomancer-v2.vercel.app](https://echomancer-v2.vercel.app)

---

## Two ways to listen

| Mode | Description |
|------|-------------|
| **Live Stream** | Stream your book with Fish Audio (~1h listening cap) |
| **Whole book** | Offline generation → one downloadable audiobook file |
| **Live Listen** | Short Fish sample of a narrator (progressive HTTP stream) |
| **Paste text** | Skip the file upload — paste a chapter or notes on the home page |

**Price target:** ~**€4.50** for a typical take-home book. The actual quote is **dynamic** from length + engine (`src/lib/tts/pricing.ts`).

---

## Architecture

```
Frontend     Next.js 16 (React 19, TypeScript, Tailwind 4)
Database     Turso (edge SQLite)
Storage      Cloudflare R2
TTS          Fish Audio (Narrator + clones); OpenRouter optional for stock slug
Hosting      Vercel
```

```
Browser → POST /api/jobs
  stream   → GET /api/jobs/{id}/stream          (Vercel → Fish pipe)
  takehome → Trigger.dev takehome.advance → sections → concat → DFN 70/30 master → R2 full.*
```

Job creation only enqueues. Trigger.dev Cloud synthesizes Whole book so a
book finishes after the tab is closed. Live Listen and Live Stream stay on
Vercel.

### Ownership

Nothing is unowned: signed-out visitors get a signed anonymous session cookie;
Google sign-in upgrades that cookie to a durable `user_*` so a library survives
devices. A job that belongs to a different session responds 404. `SESSION_SECRET`
is required in production; Google sign-in also needs `AUTH_GOOGLE_ID` and
`AUTH_GOOGLE_SECRET` — see [DEPLOYMENT.md](DEPLOYMENT.md#sessions).

---

## Quick Start

### Prerequisites

- Node.js 20+
- Turso database
- Fish API key (cloning + Live Listen + direct Fish synth)
- Optional: OpenRouter API key (stock Narrator via OpenRouter)
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

# Signs anonymous / signed-in session cookies (required in production)
SESSION_SECRET=$(openssl rand -hex 32)
# AUTH_SECRET=... # optional; Auth.js reuses SESSION_SECRET when unset
# AUTH_GOOGLE_ID=...
# AUTH_GOOGLE_SECRET=...
# AUTH_URL=http://localhost:3000

# Fish Audio — cloning, Live Listen, and preferred synth path
FISH_API_KEY=...

# Optional — stock Narrator via OpenRouter when Fish key is absent
# OPENROUTER_API_KEY=sk-or-...

# Worker secrets
INTERNAL_JOB_SECRET=some-long-secret
CRON_SECRET=another-long-secret

# Uploads (keep both in sync)
MAX_UPLOAD_MB=512
NEXT_PUBLIC_MAX_UPLOAD_MB=512

# Pricing / limits (optional)
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

The schema creates itself on first request; `migrate-turso.sql` does the same for
a fresh database and is safe to re-run.

### Checks

```bash
npm run lint
npm run typecheck
npm run test:run
npm run build
```

Tests run the real route handlers against an in-memory libSQL database and a temp
storage directory, faking only the speech provider.

---

## API sketch

| Endpoint | Purpose |
|----------|---------|
| `POST /api/pdf/upload` | JSON presign `{ fileName, contentType, byteSize }` — browser PUTs to R2 |
| `POST /api/pdf/upload/{id}` | Complete after PUT; Trigger extracts `content.txt` |
| `GET /api/pdf/upload/{id}` | Poll extraction |
| `GET /api/tts/voices` | Catalog + optional `?charCount=` price estimates |
| `POST /api/tts/preview` | One-line narrator sample |
| `POST /api/jobs` | Create a `stream` or `takehome` job (enqueue only) |
| `GET /api/jobs` · `GET /api/jobs/{id}` | The caller's library / one job |
| `GET /api/jobs/{id}/stream` | Live listen audio |
| `POST /api/jobs/{id}/takehome` | Spawn a full book from a stream session |
| `GET /api/jobs/{id}/download` | Assembled audiobook |
| `GET /api/storage/{key}` | Owner-gated blob proxy |
| `GET /api/cron/process-jobs` | Worker drain (`CRON_SECRET`) |
| `POST /api/jobs/{id}/process` | Advance one job (`INTERNAL_JOB_SECRET`) |

---

## Docs

| File | Purpose |
|------|---------|
| [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) | Full technical design — **update on relevant architecture/product changes** |
| [AGENTS.md](AGENTS.md) | Agent / architecture guide |
| [TURSO_R2_SETUP.md](TURSO_R2_SETUP.md) | Database + storage |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Vercel deploy |

---

## License

Private project.
