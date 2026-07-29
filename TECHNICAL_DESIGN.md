# Echomancer v2 — Technical Design Document

**Audience:** A reader who is comfortable reading TypeScript/React but sits somewhere between beginner and intermediate in full-stack product engineering. This document explains not just *what* the code does, but *why* it’s written the way it is — naming conventions, design trade-offs, and the domain knowledge that informs the pipeline.

**Live app:** [echomancer-v2.vercel.app](https://echomancer-v2.vercel.app)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Domain Primer: Documents → Speech](#2-domain-primer-documents--speech)
3. [Architecture at a Glance](#3-architecture-at-a-glance)
4. [File Inventory](#4-file-inventory)
5. [Dependency Stack & Why Each Was Chosen](#5-dependency-stack--why-each-was-chosen)
6. [Configuration & Environment](#6-configuration--environment)
7. [Voice Catalog — Discovery & Curation](#7-voice-catalog--discovery--curation)
8. [Personas, Accents & Previews](#8-personas-accents--previews)
9. [Upload & Text Extraction](#9-upload--text-extraction)
10. [Jobs — The Central Abstraction](#10-jobs--the-central-abstraction)
11. [Try a Chapter (Live Stream)](#11-try-a-chapter-live-stream)
12. [Full Audiobook (Take-Home)](#12-full-audiobook-take-home)
13. [Audio Formats — PCM, WAV, MP3](#13-audio-formats--pcm-wav-mp3)
14. [Pricing & Cost Control](#14-pricing--cost-control)
15. [ETA & Progress UX](#15-eta--progress-ux)
16. [Storage — Turso + R2](#16-storage--turso--r2)
17. [Frontend Surfaces](#17-frontend-surfaces)
18. [Error Handling Philosophy](#18-error-handling-philosophy)
19. [Testing & Deployment](#19-testing--deployment)
20. [What We Explicitly Do Not Do](#20-what-we-explicitly-do-not-do)
21. [Glossary](#21-glossary)

---

## 1. Project Overview

Echomancer turns uploaded documents (PDF, EPUB, DOCX, TXT, …) into listen-able audiobooks using **third-party TTS** routed through **OpenRouter**. There is no self-hosted TTS cluster and no voice cloning in v2.

### The Core Product Thesis

Most people don’t want to configure models, codecs, or “providers.” They want:

1. Upload a book.
2. Hear a narrator that fits (accent / vibe).
3. Either **try a chapter now** (~1 hour listening budget) or **get the whole book** as a downloadable file.
4. See a price that feels fair for a take-home copy (product target ≈ **€4.50** for a typical novel — dynamic, not a hard ceiling).

### Two Generation Paths

| Customer language | Internal `job_kind` | What happens |
|-------------------|---------------------|--------------|
| **Try a chapter** | `stream` | Pipe provider audio live; capped by char / time budget |
| **Get the whole book** | `takehome` | Split text → synthesize sections → store on R2 → concat / download |

Both paths use the same stock TTS pipeline (`generation_mode: "stock"`). Premium HD voices (e.g. Minimax) use that same pipeline but are **soft-gated** in the UI and at job creation.

### Why This Shape

- **OpenRouter as the umbrella** — one API key, one speech endpoint shape, live model/voice discovery. Optional direct Google / Gemini / Grok adapters remain as fallbacks.
- **Serverless-friendly jobs** — Vercel functions have hard time limits. Take-home work is chunked into **ticks** / **waves**, claimed atomically, and resumed via polls + nudges — not a single long worker.
- **Consumer language over infra jargon** — UI copy says “Try a chapter” / “Save full audiobook,” not “stream budget” / “take-home.” Mapping lives in `src/lib/ux-copy.ts`.

---

## 2. Domain Primer: Documents → Speech

### 2.1 TTS (Text-to-Speech)

A TTS model takes text and returns audio bytes. Providers differ on:

- **Voice IDs** (e.g. Gemini `Achernar`, Microsoft `en-US-Harper:MAI-Voice-2`)
- **Output format** (Gemini via OpenRouter → raw **PCM**; many others → **MP3**)
- **Style control** (OpenAI-like `instructions`; Gemini prefers accent/style baked into the **input** text — a separate OpenRouter `prompt` field has produced **empty PCM** in production)

### 2.2 Characters, Sections, and Audio Hours

Books are long. Providers have per-request character limits (`maxCharsPerRequest`). We **split** book text into sections (`split-text.ts`), synthesize section-by-section for take-home, and estimate listening length from character count (`CHARS_PER_AUDIO_HOUR ≈ 54_000`).

### 2.3 Catalog Voice vs Provider Voice

| Term | Meaning |
|------|---------|
| `providerVoiceId` | What the TTS API expects (`Achernar`, `eve`, …) |
| `catalog_voice_id` | Our stable card id, e.g. `or:google/gemini-…:Achernar:en-GB` |
| Accent variant | Same `providerVoiceId`, different locale / `accentHint` / directed input |

Accent variants **must** dedupe take-home jobs by `catalog_voice_id`, not only `providerVoiceId`, or British and American cards collide.

### 2.4 Stream Budget

Live listen is intentionally capped (~1 hour of audio via `STREAM_MAX_AUDIO_SECONDS` / char budget). It’s a sample of the book, not free unlimited narration. Saving a full audiobook is a separate take-home job (optionally spawned from a stream via `parent_job_id`).

---

## 3. Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser (Next.js App Router)                                    │
│  Upload → Voice picker → Library / Player                       │
└───────────────┬─────────────────────────────────────────────────┘
                │ HTTPS
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Vercel — Next.js API routes (Node runtime)                      │
│                                                                 │
│  /api/pdf/upload          extract + store source text           │
│  /api/tts/voices          curated catalog + prices + ETA        │
│  /api/tts/preview         short fixed-line sample               │
│  /api/jobs                create stream | takehome              │
│  /api/jobs/[id]/stream    live audio pipe                       │
│  /api/jobs/[id]/process   take-home section tick (secret)       │
│  /api/jobs/[id]/download  concat / full file                    │
└───────┬─────────────────────────────┬───────────────────────────┘
        │                             │
        ▼                             ▼
┌───────────────────┐       ┌──────────────────────┐
│ Turso (libSQL)    │       │ Cloudflare R2        │
│ jobs row + JSON   │       │ pdfs / sections /    │
│ progress fields   │       │ full.wav             │
└───────────────────┘       └──────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│ OpenRouter /api/v1/audio/speech       │
│ Gemini · Qwen · Microsoft · Grok ·    │
│ Minimax (HD, soft-gated)              │
└───────────────────────────────────────┘
```

### Design Constraints That Drove This

1. **Vercel `maxDuration`** — a full novel cannot synthesize in one invocation. Take-home uses short waves, DB cursors (`next_section_index`), and library poll nudges.
2. **`after()` is unreliable here** — production taught us that fire-and-forget `after()` / void kicks often never run. Take-home work that matters is **awaited in-request** (create path + poll nudge).
3. **No HTTP self-call loops on `/process`** — self-fetching the same route caused Vercel **508** loops. Continuation is in-process waves + later poll nudges, not recursive HTTP to self.
4. **Browsers need playable containers** — Gemini PCM is wrapped to WAV (`pcm-wav.ts`) for `<audio>` and previews.

---

## 4. File Inventory

### Product / docs

| File | Purpose |
|------|---------|
| `README.md` | Quick start, API sketch |
| `AGENTS.md` | Short agent-oriented architecture + env |
| `TECHNICAL_DESIGN.md` | This document |
| `DEPLOYMENT.md` | Vercel deploy notes |
| `TURSO_R2_SETUP.md` | Database + object storage setup |

### Core TTS library (`src/lib/tts/`)

| File | Purpose |
|------|---------|
| `types.ts` | Catalog / synth / job-facing types |
| `providers/openrouter.ts` | Primary synth + model listing |
| `providers/{google,gemini,grok}.ts` | Optional direct fallbacks |
| `providers/index.ts` | Adapter resolution |
| `catalog/allowlist.ts` | Vendors we sell; hard rejects (Zonos, Kokoro, …) |
| `catalog/openrouter-catalog.ts` | Expand OR models → voice cards + Gemini accents |
| `catalog/index.ts` | List / get catalog (live OR → static fallback) |
| `catalog/voices.json` | Static fallback voices |
| `voice-persona.ts` | Friendly names, accent inference, Listen curation |
| `accent-prompt.ts` | Soft style copy + Gemini directed input |
| `preview-text.ts` | Fixed one-liner + empty-audio detection |
| `split-text.ts` | Section chunking for take-home |
| `process-job.ts` | Take-home ticks, waves, nudges, zombie recovery |
| `stream-session.ts` | Live listen windowing + budget |
| `pcm-wav.ts` | PCM ↔ WAV for browsers |
| `concat-audio.ts` | Assemble full download |
| `pricing.ts` | Dynamic EUR estimate |
| `eta.ts` | Wall-clock ETA / elapsed helpers |
| `premium.ts` | HD soft gate |
| `schema-migrate.ts` | Idempotent `jobs` column ensures |

### API routes (`src/app/api/`)

| Route | Purpose |
|-------|---------|
| `pdf/upload` | Accept document, extract text, store |
| `tts/voices` | Catalog + listen subset + price/ETA |
| `tts/preview` | Narrator sample |
| `jobs` | Create + list (+ nudge stale take-homes) |
| `jobs/[id]` | Detail / delete / retry |
| `jobs/[id]/stream` | Live listen |
| `jobs/[id]/process` | Internal take-home tick |
| `jobs/[id]/takehome` | Spawn full book from stream |
| `jobs/[id]/download` | Download assembled audio |
| `storage/[[...path]]` | Authenticated-ish blob proxy from R2/local |

### Dashboard UI (`src/app/dashboard/`)

| Page | Purpose |
|------|---------|
| `voice` | Narrator picker (Try a chapter / Whole book) |
| `queue` | Library with status / ETA / elapsed |
| `player/[id]` | Playback, stream stages, early sections |
| `resources` | FAQ / guidance |

---

## 5. Dependency Stack & Why Each Was Chosen

| Package | Role | Why |
|---------|------|-----|
| **Next.js 16** | App Router UI + API | One deployable on Vercel; RSC + route handlers |
| **React 19** | UI | Team default; client islands for player/voice |
| **TypeScript** | Types across API + lib | Catalog and job shapes change often |
| **Tailwind 4 + shadcn/ui** | Styling / primitives | Fast product UI without a bespoke design system repo |
| **motion** | Light motion | Presence on picker / library without heavy animation libs |
| **Zod** | Request + catalog validation | Fail closed on bad job bodies / static JSON |
| **@libsql/client (Turso)** | Edge SQLite | Cheap, simple job store; good enough vs Postgres for this stage |
| **@aws-sdk/client-s3** | R2 (S3-compatible) | Durable audio/objects on Cloudflare |
| **unpdf / epub2 / mammoth** | Text extraction | Cover PDF / EPUB / DOCX without a separate microservice |
| **Vitest** | Unit tests | Fast feedback on split/ETA/catalog/persona |

We deliberately **do not** depend on a queue product (SQS, Inngest, etc.) yet. The job table + poll nudge is the queue. That keeps ops simple at the cost of careful timeout engineering.

---

## 6. Configuration & Environment

### Required in production

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | Primary TTS |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Job DB |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Object storage |
| `INTERNAL_JOB_SECRET` | Protects `/api/jobs/[id]/process` |
| `NEXT_PUBLIC_APP_URL` | Absolute URLs / OpenRouter referer |

### Important knobs

| Variable | Default (approx) | Meaning |
|----------|------------------|---------|
| `PREMIUM_HD_ENABLED` / `PREMIUM_HD_ALLOWLIST` | off | Show/allow Minimax HD |
| `TTS_SECTIONS_PER_TICK` | 6 (env) | Sections per process tick when budget allows |
| `TTS_NUDGE_WAVE_BUDGET_MS` | 25000 | Short wave on library poll |
| `TTS_START_WAVE_BUDGET_MS` | 240000 | Longer wave on create |
| `STREAM_MAX_AUDIO_SECONDS` | 3600 | Live listen cap |
| `TTS_PRICE_MARKUP` / `TTS_PRICE_FIXED_EUR` / `TTS_USD_TO_EUR` / `TTS_MIN_PRICE_EUR` | 2.0 / 0.5 / 0.92 / 1.99 | Retail estimate |

Dev-only: `STORAGE_PATH=./data/storage` when R2 is not configured.

---

## 7. Voice Catalog — Discovery & Curation

### Live discovery

1. `listOpenRouterSpeechModels()` → `GET /models?output_modalities=speech` (cached ~10 min).
2. `expandModel()` turns each allowlisted model’s `supported_voices` into catalog cards.
3. Minimax often advertises empty voices — we **seed** known system voice IDs.

### Allowlist (`catalog/allowlist.ts`)

**Allowed vendors:** `google` (Gemini), `qwen`, `minimax`, `microsoft`, `x-ai` / `xai` (Grok).

**Hard-blocked substrings:** `zonos`, `kokoro`, `deepgram`, `orpheus`, `sesame`, `voxtral`, `aura-`, …

Why: open catalogs flood the picker with slow or poorly labeled narrators. Curation is a product feature, not just an implementation detail.

### Gemini accent expansion

Gemini English voices are expanded into American / British / Australian / Irish cards (`accent-prompt.ts` + `openrouter-catalog.ts`) with:

- Distinct `catalog` ids (`…:en-GB`)
- `accentHint` + locale
- Directed synthesis input (not a fragile separate `prompt`)

### Static fallback

If OpenRouter listing fails, `voices.json` + enrich still powers a minimal catalog so the app degrades instead of showing zero narrators.

---

## 8. Personas, Accents & Previews

### Friendly names (`voice-persona.ts`)

Raw IDs like `en-US-Harper:MAI-Voice-2` must not become **“En Us Harper.”** We strip BCP-47 locale prefixes and provider suffixes, then optionally append `· American` for English accents.

### Accent inference order

1. Explicit `accentHint` (trusted)
2. Locale (`en-GB` → british, …)
3. Voice-id heuristics
4. Default English → American; non-English → `other`

### Previews (`/api/tts/preview`)

- Fixed short line: *“Hi — I'm an AI narrator on Echomancer. Here's how I sound.”*
- **Not** taken from the uploaded book (fast + comparable).
- Gemini: wrap with `geminiDirectedInput`; **do not** send OpenRouter `prompt` (empty PCM incident).
- If audio is empty/silent → retry plain text → else **502** (never return a 44-byte fake WAV as success).
- Client caches object URLs per voice id for instant replay.

### Listen curation

Listen menu prefers fast, non-HD voices and **one card per underlying `providerVoiceId`**, with accent diversity across *different* narrators — not the same voice listed four times as four accents.

---

## 9. Upload & Text Extraction

Upload hits `/api/pdf/upload` (name is historical; multiple formats are accepted).

`text-extraction.ts` normalizes PDF / EPUB / DOCX / TXT / RTF into plain text stored under the storage layer. Downstream jobs only need `pdf_storage_path` + `char_count`.

Failure modes we surface in UI language (`errors-ui.ts`): scanned/image PDFs, DRM, empty files, unsupported formats.

---

## 10. Jobs — The Central Abstraction

A **job** is one narration attempt for one document + one catalog voice.

### Key columns (Turso `jobs`)

| Column | Role |
|--------|------|
| `status` | `queued` → `processing` → `ready` / `failed` |
| `job_kind` | `stream` \| `takehome` |
| `catalog_voice_id` / `provider_voice_id` / `tts_provider` | Voice identity |
| `tts_options` | JSON (model, stylePrompt, locale, …) |
| `segments_json` | Take-home section list |
| `next_section_index` | Cursor for ticks |
| `stream_cursor` / `stream_chars_used` / `stream_max_chars` | Live listen progress |
| `generation_started_at` | ETA / elapsed anchor |
| `price_estimate_eur` | Snapshot at create |
| `parent_job_id` | Stream → take-home lineage |
| `deleted_at` | Soft delete |

Schema is evolved with **idempotent** `ensureTtsJobColumns()` (`schema-migrate.ts`) so production can add columns without a separate migrator service.

### Create (`POST /api/jobs`)

1. Rate-limit.
2. Resolve catalog voice; enforce allowlist + HD gate.
3. Persist job; for take-home **await** `continueTakehome()` inline so generation actually starts on Vercel.
4. Return `jobId` + status; UI routes to player or library.

---

## 11. Try a Chapter (Live Stream)

```
POST /api/jobs { jobKind: "stream", catalogVoiceId, … }
  → Player opens GET /api/jobs/{id}/stream
       → stream-session windows text from stream_cursor
       → provider.synthesizeStream
       → PCM gets a single WAV header for the session
       → advance cursor + char budget
```

When the function timebox ends, the player **reconnects** (`?t=timestamp`) and continues from `stream_cursor`. When budget is exhausted, UI offers **Save full audiobook**.

Player UX stages (`opening` → `preparing` → `buffering` → `playing` / `continuing`) exist because setting `audioUrl` early is not the same as hearing sound — users need an honest waiting state.

---

## 12. Full Audiobook (Take-Home)

### Tick (`processTakehomeTick`)

1. Atomically claim a `queued` / eligible job.
2. Load book text; `splitTextForTts` into sections.
3. Synthesize up to `sectionsPerTick` (or until deadline).
4. Upload each section to R2; update `segments_json` + progress.
5. When done, concat to `full.wav` (or equivalent) and mark `ready`.

### Wave (`runTakehomeWave`)

Runs multiple ticks inside **one** invocation until done or budget exhausted. Used on:

- Job create (longer budget)
- Library poll nudge (short budget so `GET /api/jobs` doesn’t 504)

### Stale / zombie recovery

If a job sits `queued`/`processing` without progress, list/detail paths **nudge** a short inline wave. Claims and `processing_started_at` prevent two workers from double-synthesizing forever.

### Early listen

As soon as some segments are `ready`, the library shows **Ready to play** and the player can stream section files before the full concat exists.

---

## 13. Audio Formats — PCM, WAV, MP3

| Source | Wire format | Browser |
|--------|-------------|---------|
| Gemini (OpenRouter) | raw PCM 24 kHz mono | Wrap WAV (`ensureBrowserPlayable` / stream header) |
| Grok / Microsoft / many others | MP3 | Play as-is |
| Concat download | Prefer consistent container via `concat-audio.ts` | `/download` |

Empty PCM must never be wrapped and returned as a “successful” preview — that produced silent 44-byte WAVs and looked like “preview broken.”

---

## 14. Pricing & Cost Control

`pricing.ts` estimates **COGS** from character count × provider rate (or audio-hour rate), converts USD→EUR, applies markup + fixed overhead, and floors at a minimum.

- **€4.50** is a **product target** for a typical standard book, not a hard cap.
- Stream path is cost-controlled by **budget**, not by charging per stream (today).
- HD voices are hidden/blocked unless premium gate allows — protects margin and UX.

---

## 15. ETA & Progress UX

OpenRouter does **not** expose TTS duration ETA. We estimate:

1. Pre-job: sections × latency-class seconds (`eta.ts`)
2. Soft labels early (“usually under a minute”) until we have live section timing
3. After ≥2 sections: rate-based remaining time
4. Always show **elapsed** while generating when timestamps exist

APIs expose `eta_seconds` / `eta_label` / `elapsed_seconds` / `elapsed_label` on job payloads.

---

## 16. Storage — Turso + R2

- **Turso** — job metadata and small JSON (segments). Not for multi‑MB audio blobs.
- **R2** — source text/pdf objects, per-section audio, full audiobook.
- **Local `STORAGE_PATH`** — dev convenience when R2 isn’t configured.
- **`/api/storage/...`** — app-mediated read (range requests for playback).

---

## 17. Frontend Surfaces

### Voice picker

- Tabs: **Try a chapter** / **Get the whole book**
- Filters: gender, accent, vibe (full)
- Preview + Recently heard (localStorage)
- Create job with `voiceName` from friendly title

### Library (queue)

Status mental model: Ready · Generating · Starting · Ready to play · Listening · Failed — not raw `job_kind` jargon as the primary badge.

### Player

- Stream banner + listening time used
- First-audio stages + warm-up hint
- Take-home progress with elapsed/ETA
- Section playlist when segments exist

Shared customer strings: `src/lib/ux-copy.ts`.

---

## 18. Error Handling Philosophy

1. **Provider errors stay in logs**; users see `userFriendlyError()` strings (credits, DRM, rate limits, empty preview, …).
2. **Prefer retryable queued state** over stuck `processing` after a tick crash.
3. **Fail closed on empty audio** for previews (502) instead of 200 + silence.
4. **Allowlist at create** so disallowed narrators never enter the job table from the UI.

---

## 19. Testing & Deployment

### Tests (Vitest)

Focus on pure logic: split-text, ETA, pricing, allowlist, personas, accent direction, PCM/WAV, preview emptiness helpers. Provider HTTP is mostly integration/manual against OpenRouter.

### Deploy

- Hosting: **Vercel** production from `main`
- Preview deployments per branch
- **Caution:** Instant-promoting older Production rows can roll the live domain back while `main` stays correct. Prefer a fresh Production deploy of latest `main`.

---

## 20. What We Explicitly Do Not Do

- **No self-hosted TTS / GPU workers** in v2 (Modal/MOSS paths are historical).
- **No voice cloning** from user samples as the default product.
- **No unlimited free live narration** — stream is capped.
- **No “every OpenRouter speech model in the picker”** — curation is intentional.
- **No reliance on `after()` for correctness** of take-home generation.
- **No claiming hard accents we can’t steer** without directed input; labels track locale/`accentHint` and synthesis direction.

---

## 21. Glossary

| Term | Meaning |
|------|---------|
| **Catalog voice** | One sellable narrator card in our API/UI |
| **Provider voice id** | Upstream TTS voice name/id |
| **Take-home** | Full offline audiobook job |
| **Stream / Try a chapter** | Live listen session with budget |
| **Tick** | One process invocation slice synthesizing K sections |
| **Wave** | Multiple ticks awaited in one serverless invocation |
| **Nudge** | Short inline wave triggered by library polling |
| **PCM** | Raw pulse-code samples (Gemini); needs WAV wrapper for browsers |
| **HD / Premium** | Higher-cost models (e.g. Minimax), soft-gated |
| **Allowlist** | Vendors permitted in catalog + job create |
| **Directed input** | Accent/style instruction embedded in Gemini `input` text |
| **COGS** | Estimated provider cost before markup |

---

## Related Docs

- [README.md](./README.md) — setup and API sketch
- [AGENTS.md](./AGENTS.md) — condensed agent guide
- [TURSO_R2_SETUP.md](./TURSO_R2_SETUP.md) — infra
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Vercel

---

*This document reflects Echomancer v2 as of the OpenRouter-curated stock TTS architecture (Gemini / Qwen / Microsoft / Grok / Minimax), with consumer UX paths “Try a chapter” and “Get the whole book.” Update it when generation topology or storage assumptions change.*
