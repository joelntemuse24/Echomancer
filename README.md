# Echomancer v2

Transform PDFs into audiobooks with custom AI voice cloning.

Upload a document, provide a short voice sample, and Echomancer generates a full audiobook narrated in that voice using **MOSS-TTS** on Modal GPU workers.

**Live app:** [echomancer-v2.vercel.app](https://echomancer-v2.vercel.app)

---

## Architecture

```
Frontend     Next.js 16 (React 19, TypeScript, Tailwind 4)
Database     Turso (edge SQLite)
Storage      Cloudflare R2
TTS          MOSS-TTS-v1.5 via Modal (SGLang-Omni on A100-80GB)
Hosting      Vercel (serverless API + dashboard)
```

```
Browser → Vercel API → Turso (jobs) + R2 (files)
                    ↓
              Modal /generate_audiobook
                    ↓
         GPU workers synthesize audio → upload MP3 to R2
                    ↓
         Webhooks update job progress → frontend polls
```

---

## MOSS variants (`MOSS_AB_VARIANT`)

| Variant | Backend | Use when |
|---------|---------|----------|
| **sglang** (production) | SGLang-Omni on Modal A100-80GB | Best speed + fidelity balance |
| **delay** | MossTTSDelay-8B transformers | Maximum clone fidelity |
| **local** | MOSS Local-Transformer | Faster, lighter |
| **api** | MOSI Studio hosted API | No GPU ops (see `MOSI_API_SETUP.md`) |

---

## Quick Start (Local Dev)

### Prerequisites

- Node.js 18+
- [Turso](https://turso.tech/) database
- [Modal](https://modal.com/) account with MOSS-TTS deployed
- Optional: [Cloudflare R2](https://developers.cloudflare.com/r2/) bucket

### 1. Clone and install

```bash
git clone https://github.com/joelntemuse24/Echomancer.git
cd Echomancer
npm install
```

### 2. Configure environment

Create `.env.local` (see `TURSO_R2_SETUP.md` for infra details):

```bash
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token

MOSS_AB_VARIANT=sglang
MODAL_MOSS_SGLANG_TTS_URL=https://<user>--echomancer-sglang-tts-fastapi-app.modal.run/generate_batch
MODAL_TTS_URL=https://<user>--echomancer-sglang-tts-fastapi-app.modal.run/generate_batch

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=echomancer-audio

WEBHOOK_SECRET=...
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 3. Run locally

```bash
npm run dev
```

---

## Deploy Modal TTS

```powershell
# Production default (SGLang)
.\deploy-sglang.ps1

# Rollback / A/B variants
.\deploy-moss-tts.ps1      # delay + local transformers
.\deploy-mosi-api-tts.ps1  # hosted MOSI API
```

Then set Vercel env vars and redeploy:

```bash
npx vercel --prod
```

---

## Modal apps

| App | File | GPU |
|-----|------|-----|
| SGLang MOSS-TTS | `modal/sglang_tts_server.py` | A100-80GB |
| MOSS Delay-8B | `modal/moss_tts_server.py` | A100 |
| MOSS Local | `modal/moss_local_tts_server.py` | L40S |
| MOSI API proxy | `modal/mosi_api_tts_server.py` | CPU |

Shared orchestration: `modal/tts_shared.py`, `modal/emotion_instruct.py`

---

## Docs

| File | Purpose |
|------|---------|
| [TURSO_R2_SETUP.md](TURSO_R2_SETUP.md) | Database + storage setup |
| [MOSI_API_SETUP.md](MOSI_API_SETUP.md) | Hosted MOSI API + SGLang notes |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Vercel deployment |

---

## License

Private project.