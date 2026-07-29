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
10. [Identity, Ownership & Abuse Control](#10-identity-ownership--abuse-control)
11. [Jobs — The Central Abstraction](#11-jobs--the-central-abstraction)
12. [Try a Chapter (Live Stream)](#12-try-a-chapter-live-stream)
13. [Full Audiobook (Take-Home)](#13-full-audiobook-take-home)
14. [Audio Formats — PCM, WAV, MP3](#14-audio-formats--pcm-wav-mp3)
15. [Pricing & Cost Control](#15-pricing--cost-control)
16. [ETA & Progress UX](#16-eta--progress-ux)
17. [Storage — Turso + R2](#17-storage--turso--r2)
18. [Frontend Surfaces](#18-frontend-surfaces)
19. [Error Handling Philosophy](#19-error-handling-philosophy)
20. [Testing & Deployment](#20-testing--deployment)
21. [What We Explicitly Do Not Do](#21-what-we-explicitly-do-not-do)
22. [Glossary](#22-glossary)

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
│  proxy.ts                 issues the signed session cookie       │
│                                                                 │
│  /api/pdf/upload          extract + store + record ownership    │
│  /api/tts/voices          curated catalog + prices + ETA        │
│  /api/tts/preview         short fixed-line sample               │
│  /api/jobs                create (enqueue only) | list          │
│  /api/jobs/[id]/stream    live audio pipe                       │
│  /api/jobs/[id]/download  concat / full file                    │
│  /api/storage/[...]       owner-gated blob proxy                │
│                                                                 │
│  workers (machine-only):                                        │
│  /api/cron/process-jobs   scheduled drain   (CRON_SECRET)       │
│  /api/jobs/[id]/process   advance one job   (INTERNAL_JOB_...)  │
└───────┬─────────────────────────────┬───────────────────────────┘
        │                             │
        ▼                             ▼
┌───────────────────┐       ┌──────────────────────┐
│ Turso (libSQL)    │       │ Cloudflare R2        │
│ jobs · uploads    │       │ pdfs / sections /    │
│ usage · limits    │       │ full.*               │
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

1. **Vercel `maxDuration`** — a full novel cannot synthesize in one invocation. Take-home is chunked into ticks and waves with the cursor (`next_section_index`) in the database, so any later invocation resumes where the last one stopped.
2. **User requests must not wait on synthesis** — job creation enqueues and returns. A scheduled worker (`/api/cron/process-jobs`) does the work, so a book finishes whether or not a page is open.
3. **`after()` is unreliable here** — production showed fire-and-forget `after()` / void kicks often never running, so nothing load-bearing depends on them.
4. **No HTTP self-call loops on `/process`** — self-fetching the same route caused Vercel **508 Loop Detected**. Continuation is the lease plus the stored cursor.
5. **Concurrency must be lease-based, not time-based** — see §13.3. Reclaiming after a fixed idle window cannot distinguish a hung worker from a slow one.
6. **Browsers need playable containers** — Gemini PCM is wrapped to WAV (`pcm-wav.ts`) for `<audio>` and previews.
7. **Object keys are not secrets** — anything reachable by URL is gated on ownership, not obscurity.

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
| `audio-guard.ts` | "Did the provider actually send audio?" |
| `section-size.ts` | Per-model character ceilings + stream window |
| `schema-migrate.ts` | Idempotent table / column ensures |

### Identity & plumbing

| File | Purpose |
|------|---------|
| `src/proxy.ts` | Issues the session cookie before any route runs |
| `lib/auth/session.ts` | Mint / sign / verify session tokens |
| `lib/auth/guard.ts` | Ownership checks (`requireOwnedJob`, `ownsStoragePath`) |
| `lib/jobs/serialize.ts` | The single public JSON shape for a job |
| `lib/jobs/worker-auth.ts` | Secrets for the two worker routes |
| `lib/turso/uploads.ts` | Upload ownership records |
| `lib/rate-limit.ts` | Shared counters with per-route failure policy |
| `lib/document-formats.ts` | Accepted formats + upload ceiling (client-safe) |
| `src/test/{setup-env,harness}.ts` | In-memory libSQL + temp storage for route tests |

### API routes (`src/app/api/`)

| Route | Purpose |
|-------|---------|
| `pdf/upload` | Accept document, extract text, store |
| `tts/voices` | Catalog + listen subset + price/ETA |
| `tts/preview` | Narrator sample |
| `jobs` | Create (enqueue) + list the caller's library |
| `jobs/[id]` | Detail / delete / retry |
| `jobs/[id]/cancel` | Stop a running job |
| `jobs/[id]/stream` | Live listen |
| `jobs/[id]/takehome` | Spawn full book from stream |
| `jobs/[id]/download` | Download assembled audio |
| `jobs/[id]/process` | Worker: advance one job (`INTERNAL_JOB_SECRET`) |
| `cron/process-jobs` | Worker: scheduled drain (`CRON_SECRET`) |
| `storage/[[...path]]` | Owner-gated blob proxy from R2/local |

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
| **Tailwind 4 + two shadcn primitives** | Styling / primitives | Only `Button` and `Slider` are kept; the other 41 generated components and their Radix packages were removed once it was clear nothing imported them |
| **motion** | Light motion | Presence on picker / library without heavy animation libs |
| **Zod** | Request + catalog validation | Fail closed on bad job bodies / static JSON |
| **@libsql/client (Turso)** | Edge SQLite | Cheap, simple job store; good enough vs Postgres for this stage |
| **@aws-sdk/client-s3** | R2 (S3-compatible) | Durable audio/objects on Cloudflare |
| **unpdf / epub2 / mammoth** | Text extraction | Cover PDF / EPUB / DOCX without a separate microservice |
| **Vitest** | Unit tests | Fast feedback on split/ETA/catalog/persona |

We deliberately **do not** depend on a queue product (SQS, Inngest, etc.) yet. The `jobs` table plus a lease column *is* the queue, and Vercel Cron is the scheduler. That keeps ops simple at the cost of careful timeout and lease engineering — the price is paid in §13.

---

## 6. Configuration & Environment

### Required in production

| Variable | Purpose |
|----------|---------|
| `SESSION_SECRET` | Signs session cookies. Without it production refuses to issue identities — see §10.2 |
| `OPENROUTER_API_KEY` | Primary TTS |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Job DB |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Object storage |
| `INTERNAL_JOB_SECRET` | Protects `/api/jobs/[id]/process` |
| `CRON_SECRET` | Protects `/api/cron/process-jobs` |
| `NEXT_PUBLIC_APP_URL` | Absolute URLs / OpenRouter referer |

### Important knobs

| Variable | Default (approx) | Meaning |
|----------|------------------|---------|
| `PREMIUM_HD_ENABLED` / `PREMIUM_HD_ALLOWLIST` | off | Show/allow Minimax HD |
| `TTS_SECTIONS_PER_TICK` | 6 | Sections per tick when the budget allows |
| `TTS_WORKER_WAVE_BUDGET_MS` | 240000 | Wall clock a worker invocation may spend (inside a 300s `maxDuration`) |
| `TTS_CRON_JOBS_PER_RUN` | 3 | Jobs one cron run may advance |
| `TTS_LEASE_TTL_SECONDS` | 90 | Lease lifetime between heartbeats |
| `TTS_POLL_NUDGE_BUDGET_MS` | 8000 | Synthesis allowed on UI poll paths; `0` disables (see §13.4) |
| `MAX_UPLOAD_MB` / `NEXT_PUBLIC_MAX_UPLOAD_MB` | 25 | Upload ceiling, server and UI |
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

We only claim multi-accent variants where steering is real (`modelSupportsAccentVariants`). Other vendors get a single card labelled from their native locale — not four accent clones of the same unsteerable voice.

### Catalog rates (`usdPerMillionCharsForModel`)

OpenRouter `pricing.prompt` units are inconsistent across speech models. Confirmed vendor overrides (USD per million characters) win over derived values; implausible derived rates ($0.50–$500/M window) fall back so `pricing.ts` uses its defaults rather than misquoting the book.

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

### Style / accent honesty

`modelSupportsStyleInstructions()` gates OpenAI-style `instructions` / style prompts on preview, take-home sections, and stream windows. Gemini/OpenAI/google get style fields (Gemini prefers directed **input** instead of a separate prompt). Minimax, Microsoft, Qwen, and Grok accept the field over OpenRouter but do not audibly act on it — we send nothing rather than claim a delivery style the audio never matches. Accent **variant cards** remain Gemini-only for the same reason.

### Previews (`/api/tts/preview`)

- Fixed short line: *“Hi — I'm an AI narrator on Echomancer. Here's how I sound.”*
- **Not** taken from the uploaded book (fast + comparable).
- Gemini: wrap with `geminiDirectedInput`; **do not** send OpenRouter `prompt` (empty PCM incident).
- Non-Gemini: send `stylePrompt` only when `modelSupportsStyleInstructions` is true.
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

## 10. Identity, Ownership & Abuse Control

### 10.1 Why anonymous is not the same as unowned

Echomancer has no login. For a while that meant every row carried
`user_id = 'anonymous'`, which had a consequence that was easy to miss: there was
nothing to compare a request against. Anyone who held — or guessed — a job id
could list, stream, download or delete anyone else's audiobook, and
`/api/storage/**` served any object key to any caller.

The fix separates two ideas that had been conflated. A user can stay
**anonymous** (we never learn who they are) while still being
**authenticated** (we can tell one visitor from another).

### 10.2 Signed session cookies

`src/lib/auth/session.ts` mints an opaque id (`anon_<16 random bytes>`) and signs
it with HMAC-SHA256:

```
v1.<userId>.<issuedAt>.<base64url HMAC-SHA256(secret, "v1.<userId>.<issuedAt>")>
```

The token lives in an `httpOnly`, `sameSite=lax` cookie. `src/proxy.ts` issues one
to every visitor before a route runs, and also forwards it on an `x-ec-session`
request header so a route sees the freshly minted identity on the very first
request.

Nothing about that header is trusted: route handlers re-verify the signature
whatever the source, so a spoofed header on a path the proxy does not match is
rejected exactly like a forged cookie. Web Crypto is used rather than
`node:crypto` so the same module works in either runtime.

`SESSION_SECRET` (falling back to `INTERNAL_JOB_SECRET`) is **required in
production**. The tempting alternative — generate a random key when none is
configured — is worse than failing: each serverless instance would sign with a
different key, so a user's identity would change depending on which instance
answered, and their library would vanish and reappear.

### 10.3 Ownership checks

`src/lib/auth/guard.ts` is the one place that decides who may see what.

`requireOwnedJob()` loads a job and compares `user_id` to the session, throwing
**404** — not 403 — on a mismatch. Distinguishing "does not exist" from "exists
but is not yours" would turn the API into an existence oracle for job ids.

Storage is gated by resolving the key back to the resource that owns it, because
object keys are guessable and therefore not secrets:

| Key prefix | Owner lookup |
|------------|--------------|
| `audiobooks/<jobId>/…` | `jobs.user_id` |
| `pdfs/<uploadId>/…` | `uploads.user_id`, falling back to any job referencing the path |
| anything else | unreachable |

Because the player fetches these URLs from the same origin, the session cookie
rides along on `<audio src>` and range requests with no extra plumbing.

### 10.4 Trusting `pdfStoragePath`

Job creation takes a storage path from the browser. Two things have to happen
before it can be believed:

1. Zod pins the shape to `pdfs/<uuid>/content.txt`, so it cannot point at a
   generated audio object or attempt traversal.
2. The `uploads` table must contain a row for that path **and** this session.

Without step 2, a caller could narrate — and make us pay for — a document someone
else uploaded.

### 10.5 Rate limiting

Counters live in Turso (`src/lib/rate-limit.ts`) because an in-process `Map`
resets with every serverless isolate and enforces nothing. The upsert and read
are a single `INSERT … ON CONFLICT … RETURNING` so two concurrent requests cannot
both observe the pre-increment count.

The interesting decision is what happens when the counter itself is unavailable.
Every limiter used to fail **open**, which meant a Turso outage silently removed
all throttling from exactly the endpoints that spend money. Failure policy is now
explicit per route:

| Route | Limit | On counter failure |
|-------|-------|--------------------|
| `POST /api/jobs` | 5/min | **closed** |
| `POST /api/pdf/upload` | 10/min | **closed** |
| `GET /api/jobs/[id]/stream` | 20/min | **closed** |
| `POST /api/tts/preview` | 15/min | **closed** |
| `GET /api/tts/voices` | 60/min | **closed** |
| `GET /api/storage/**` | 600/min | open |

Storage stays open on purpose: it spends nothing upstream, and failing closed
would silence someone's audiobook over an unrelated database blip.

Identities prefer the session id over the IP — an IP is shared behind NAT and
trivially rotated — and raw IPs are hashed before they are stored, so limiter rows
are not a log of who visited.

### 10.6 Upload bounds

Text extraction runs in-process over the whole buffer, so the upload ceiling is a
memory bound as much as a storage one. `MAX_UPLOAD_MB` (default 25) is checked
against `Content-Length` *before* the body is buffered, then again against the
actual file size. `src/lib/document-formats.ts` holds the limit and the accepted
extensions in a Node-free module so the landing page can state the same rules the
server enforces; previously the UI advertised 100MB against a smaller server cap.

---

## 11. Jobs — The Central Abstraction

A **job** is one narration attempt for one document + one catalog voice.

### Key columns (Turso `jobs`)

| Column | Role |
|--------|------|
| `user_id` | Owning session (§10) — every read is scoped by it |
| `status` | `queued` → `processing` → `ready` / `failed` / `cancelled` |
| `job_kind` | `stream` \| `takehome` |
| `catalog_voice_id` / `provider_voice_id` / `tts_provider` | Voice identity |
| `tts_options` | JSON (model, stylePrompt, locale, …) |
| `segments_json` | Take-home section list |
| `next_section_index` | Cursor for ticks |
| `stream_cursor` / `stream_chars_used` / `stream_max_chars` | Live listen progress |
| `processing_lease_token` / `lease_expires_at` | Worker lease (§13.3) |
| `generation_started_at` | ETA / elapsed anchor |
| `price_estimate_eur` | Snapshot at create |
| `parent_job_id` | Stream → take-home lineage |
| `deleted_at` | Soft delete |

Sibling tables: `uploads` (who uploaded which document), `usage_logs` (characters
synthesized per action), `rate_limits` (shared counters).

Schema is evolved with **idempotent, additive-only** `ensureTtsJobColumns()`
(`schema-migrate.ts`) so production can gain tables and columns without a separate
migrator service. `migrate-turso.sql` expresses the same schema for a fresh
database and contains no `DROP`; new columns go in the `JOB_COLUMNS` list, not the
SQL file, because SQLite has no `ADD COLUMN IF NOT EXISTS`.

`cancelled` is deliberately a distinct status from `failed`: nothing went wrong, so
the UI does not offer a retry, and the worker queries skip it.

### Create (`POST /api/jobs`)

1. Require a session; rate-limit by it (fails closed).
2. Verify the caller owns `pdfStoragePath` via `uploads` (§10.4).
3. Resolve the catalog voice; enforce the allowlist + HD gate.
4. Persist the job as `queued` and **return immediately**.
5. UI routes to the player or library and polls.

Step 4 is the important one. Creation previously awaited a synthesis wave of up to
240 seconds so that generation would definitely start — which made the single
request the user waits on the slowest in the app, and put it at risk of a gateway
timeout. Now a worker owns that responsibility (§13.4).

---

## 12. Try a Chapter (Live Stream)

```
POST /api/jobs { jobKind: "stream", catalogVoiceId, … }
  → Player opens GET /api/jobs/{id}/stream
       → stream-session windows text from stream_cursor
       → provider.synthesizeStream
       → PCM gets a single WAV header for the session
       → advance cursor + char budget
```

When the function timebox ends, the player **reconnects** (`?t=timestamp`) and continues from `stream_cursor`. When the budget is exhausted, the UI offers **Save full audiobook**.

A stream claim allows only one reader per session: two concurrent readers would
both advance the cursor and spend the budget twice.

The cursor is only advanced for a window that produced **audible** bytes. A silent
window is retried once undirected and then fails the session — counting it as
delivered would skip that passage of the book permanently *and* charge it against
the listening allowance. To keep the guard from hurting time-to-first-sound, only
the first `MIN_AUDIBLE_BYTES` are inspected before the rest of the window is passed
straight through.

Player UX stages (`opening` → `preparing` → `buffering` → `playing` / `continuing`) exist because setting `audioUrl` early is not the same as hearing sound — users need an honest waiting state.

---

## 13. Full Audiobook (Take-Home)

### 13.1 Tick (`processTakehomeTick`)

1. Claim the job's **lease** (§13.3). If someone else holds it, return `busy` and
   synthesize nothing.
2. Load the document text and `splitTextForTts` it into sections. Section size
   comes from `section-size.ts`, which prefers the catalog's
   `maxCharsPerRequest` and otherwise falls back per model then per provider.
3. Synthesize up to `sectionsPerTick` sections, or until the deadline.
4. Upload each section to `audiobooks/<jobId>/sections/NNNN.*` and update
   `segments_json` + `progress` — every write conditioned on still holding the
   lease.
5. On the last section, concatenate to `audiobooks/<jobId>/full.*`, mark `ready`,
   and record usage.

Sections already marked `ready` are skipped, so a job resumed after a crash never
pays twice for work that already landed.

### 13.2 Wave (`runTakehomeWave`)

Many ticks inside **one** invocation until the job is done or
`TTS_WORKER_WAVE_BUDGET_MS` (240s) runs out — comfortably inside the route's 300s
`maxDuration`, leaving room to persist progress. When the budget ends with work
remaining the job returns to `queued` and the next worker pass continues.

### 13.3 Leases, not timeouts

Two workers must never synthesize the same section: that bills OpenRouter twice
and races on `segments_json`.

The earlier design reclaimed any job that had been `processing` for more than 75
seconds. The flaw is that "no progress for 75s" describes a hung worker *and* a
worker in the middle of one slow request — so any section slower than the window
was handed to a second worker and generated twice, at double cost.

A lease answers the question that a timeout cannot: *is the original worker still
alive?*

```
claim     UPDATE jobs SET processing_lease_token = <random>,
                          lease_expires_at = unixepoch() + TTL
          WHERE id = ? AND status IN ('queued','processing')
            AND (processing_lease_token IS NULL
                 OR lease_expires_at IS NULL
                 OR lease_expires_at <= unixepoch())

heartbeat UPDATE jobs SET lease_expires_at = unixepoch() + TTL
          WHERE id = ? AND processing_lease_token = ?      -- every TTL/3

write     UPDATE jobs SET … WHERE id = ? AND processing_lease_token = ?
          -- rowsAffected = 0  ⇒  LeaseLostError, abandon the tick
```

SQLite serializes writes, so of two racing claims exactly one sees
`rowsAffected = 1`. The heartbeat runs on a timer *during* synthesis, so a slow
section keeps its lease while a dead worker's expires. Conditioning every progress
write on the token means a worker that was reclaimed mid-flight cannot overwrite
its successor's state — it discovers the loss on its next write and gives up.

`releaseExpiredTakehomeLeases()` is the sweep that returns genuinely abandoned
jobs to `queued`. It is a single cheap `UPDATE`, so UI poll paths can call it.

### 13.4 Who runs the work

Only two routes synthesize, and neither is reachable by a browser:

| Route | Auth | Role |
|-------|------|------|
| `GET /api/cron/process-jobs` | `Authorization: Bearer $CRON_SECRET` | Scheduled drain (`vercel.json`; daily on Hobby — sub-daily schedules fail the whole deploy) |
| `POST /api/jobs/[id]/process` | `x-internal-secret: $INTERNAL_JOB_SECRET` | Advance one job |

The cron route needs no state of its own: it sweeps expired leases, takes the
oldest queued jobs, and advances them until its budget runs out. Because progress
lives in the row, concurrent runs are safe and nobody needs to be watching a page.

**The poll-nudge escape hatch.** `TTS_POLL_NUDGE_BUDGET_MS` (default 8000) lets
`GET /api/jobs` and `GET /api/jobs/[id]` run a bounded wave. This exists for a
platform reality: Vercel's Hobby plan permits roughly one cron invocation per day,
which would leave books stalled. Set it to `0` on a plan with frequent cron, and
polls become pure reads. Either way the cap is one section per nudge, versus the
25–240 second inline waves this replaced.

### 13.5 Empty and silent audio

A provider returning HTTP 200 with a bare WAV header, zero-filled samples, or a
handful of bytes is the failure mode most likely to reach a customer, because
stored unchecked it looks like success everywhere downstream — the finished book
simply has a silent gap and no error to explain it.

`audio-guard.ts` → `isEmptyOrSilentAudio()` rejects a buffer that is too short,
whose WAV `data` chunk is empty, or whose payload is entirely zero. It runs on
**every** path that consumes provider bytes: preview, take-home sections, and
stream windows. Previously only preview checked.

On silence a section retries **without accent direction** (over-steered Gemini
input is a documented cause of empty PCM), and then fails the job rather than
storing the gap.

### 13.6 Early listen

As soon as some segments are `ready`, the library shows **Ready to play** and the
player streams section files before the full concatenation exists.

### 13.7 Deleting a job

`pdfs/<uploadId>/` is **shared**: "Try a chapter" and "Save full audiobook" are two
jobs over one upload. Deletion therefore removes `audiobooks/<jobId>/` eagerly but
only removes the upload folder when no non-deleted sibling job still references
that `pdf_storage_path`. Without that check, deleting a chapter preview would break
the full audiobook made from the same file, and any retry of it.

---

## 14. Audio Formats — PCM, WAV, MP3

| Source | Wire format | Browser |
|--------|-------------|---------|
| Gemini (OpenRouter) | raw PCM 24 kHz mono | Wrap WAV (`ensureBrowserPlayable` / stream header) |
| Grok / Microsoft / many others | MP3 | Play as-is |
| Concat download | Prefer consistent container via `concat-audio.ts` | `/download` |

Empty PCM must never be wrapped and returned as a “successful” response — that
produced silent 44-byte WAVs which looked like “preview broken.” The guard now
covers take-home sections and stream windows too (§13.5).

---

## 15. Pricing & Cost Control

`pricing.ts` estimates **COGS** from character count × provider rate (or audio-hour rate), converts USD→EUR, applies markup + fixed overhead, and floors at a minimum.

Catalog cards carry `usdPerMillionChars` from `usdPerMillionCharsForModel()` (confirmed vendor overrides first, then a plausibility-checked derivation from OpenRouter `pricing.prompt`). Missing/implausible rates leave the field unset so the EUR estimator falls back to its defaults rather than quoting a wrong unit.

- **€4.50** is a **product target** for a typical standard book, not a hard cap.
- Stream path is cost-controlled by **budget**, not by charging per stream (today).
- HD voices are hidden/blocked unless premium gate allows — protects margin and UX.

---

## 16. ETA & Progress UX

OpenRouter does **not** expose TTS duration ETA. We estimate:

1. Pre-job: sections × latency-class seconds (`eta.ts`)
2. Soft labels early (“usually under a minute”) until we have live section timing
3. After ≥2 sections: rate-based remaining time
4. Always show **elapsed** while generating when timestamps exist

APIs expose `eta_seconds` / `eta_label` / `elapsed_seconds` / `elapsed_label` on job payloads.

---

## 17. Storage — Turso + R2

- **Turso** — job / upload / usage metadata and small JSON (segments). Never audio blobs.
- **R2** — source text/pdf objects, per-section audio, full audiobook.
- **Local `STORAGE_PATH`** — dev convenience when R2 isn’t configured.
- **`/api/storage/...`** — app-mediated read with range support, gated on
  ownership (§10.3). R2 is never exposed publicly, because an object key is
  guessable and would otherwise be the only thing protecting a customer's book.

---

## 18. Frontend Surfaces

### Voice picker

- Tabs: **Try a chapter** / **Get the whole book**
- Filters: gender, accent, vibe (full)
- Preview + Recently heard (localStorage)
- Create job with `voiceName` from friendly title

### Library (queue)

Status mental model: Ready · Generating · Starting · Ready to play · Listening ·
Failed · Cancelled — not raw `job_kind` jargon as the primary badge.

Cards are not clickable `<div>`s: "Listen" is a real link, so it is focusable,
announced, and openable in a new tab. Icon-only controls carry `aria-label`s that
name the book ("Delete The Quay"), progress bars are `role="progressbar"` with
values, and the polled list is a live region. Action rows that appear on hover also
appear on focus, so they are reachable from the keyboard.

Navigation has no standalone "Player" entry — a player always belongs to one
audiobook (`/dashboard/player/[id]`), and the old link pointed at a route with no
page.

### Player

- Stream banner + listening time used
- First-audio stages + warm-up hint
- Take-home progress with elapsed/ETA
- Section playlist when segments exist

Shared customer strings: `src/lib/ux-copy.ts`.

---

## 19. Error Handling Philosophy

1. **Provider errors stay in logs**; users see `userFriendlyError()` strings (credits, DRM, rate limits, empty preview, …).
2. **Prefer retryable queued state** over stuck `processing` after a tick crash — and release the lease so a successor can claim it.
3. **Fail closed on empty audio** everywhere (§13.5): 502 for previews, a failed section for take-home, a failed session for streams. Never 200 + silence.
4. **Allowlist at create** so disallowed narrators never enter the job table from the UI.
5. **404 over 403** for resources owned by another session, so ids cannot be enumerated (§10.3).
6. **Fail closed on missing counters** for costly routes, open for cheap ones (§10.5).

---

## 20. Testing & Deployment

### Tests (Vitest)

Two layers.

**Pure logic** — split-text, ETA, pricing, allowlist, personas, accent direction,
PCM/WAV, silence detection, section sizing, session tokens, rate-limit policy.

**Route level** — `src/test/harness.ts` runs the real handlers against a real
in-memory libSQL database (`TURSO_DATABASE_URL=":memory:"`) and a real temp
directory for storage, faking only the speech provider. That combination is what
makes the interesting cases testable without a network:

- `src/app/api/ownership.test.ts` — cross-session denial on list, detail, delete,
  retry, cancel, stream, download, take-home and storage; forged cookies; spoofed
  headers; worker-route secrets.
- `src/app/api/pipeline.test.ts` — upload → create → worker → ready → download;
  resume from the cursor; the cron drain; silent-audio failure; the HD gate.
- `src/lib/tts/process-job.test.ts` — lease races, slow vs dead worker, lease-lost
  write protection.
- `src/lib/tts/stream-session.test.ts` — the cursor is not advanced for silent
  windows.

Provider HTTP itself remains manual/integration against OpenRouter.

Before finishing work: `npm run lint`, `npm run typecheck`, `npm run test:run`,
`npm run build`.

### Deploy

- Hosting: **Vercel** production from `main`
- Preview deployments per branch
- **Caution:** Instant-promoting older Production rows can roll the live domain back while `main` stays correct. Prefer a fresh Production deploy of latest `main`.

---

## 21. What We Explicitly Do Not Do

- **No self-hosted TTS / GPU workers** in v2. The old Modal / MOSS / SGLang tree (`modal/`, deploy `*.ps1` scripts) has been **removed** from the repo — do not reintroduce it.
- **No voice cloning** from user samples. Clone-era routes (`/api/voice/analyze`, job webhooks, `voice-quality-checker`) are gone; `generation_mode` / `job_kind` default to `stock` / `takehome` (see `schema-migrate.ts` and `migrate-turso.sql`).
- **No unlimited free live narration** — stream is capped.
- **No “every OpenRouter speech model in the picker”** — curation is intentional.
- **No reliance on `after()` for correctness** of take-home generation.
- **No unowned rows.** `user_id = 'anonymous'` is not an identity; every job, upload and object resolves to a session (§10).
- **No public R2 bucket** and no "the key is secret enough" reasoning.
- **No time-based concurrency control** for workers — leases with heartbeats only (§13.3).
- **No synthesis inside a user-facing request.** Creation enqueues; workers generate.
- **No fail-open rate limits on routes that spend money.**
- **No claiming hard accents we can’t steer** without directed input; labels track locale/`accentHint` and synthesis direction.
- **No `WEBHOOK_SECRET` / Modal webhook callbacks** — take-home continuation is the lease plus the stored cursor, driven by the cron worker.

---

## 22. Glossary

| Term | Meaning |
|------|---------|
| **Catalog voice** | One sellable narrator card in our API/UI |
| **Provider voice id** | Upstream TTS voice name/id |
| **Take-home** | Full offline audiobook job |
| **Stream / Try a chapter** | Live listen session with budget |
| **Tick** | One process invocation slice synthesizing K sections |
| **Wave** | Multiple ticks awaited in one serverless invocation |
| **Nudge** | Bounded wave a UI poll may run when cron is too infrequent |
| **Lease** | Token + expiry proving one worker owns a job right now |
| **Heartbeat** | Periodic lease extension while a section is in flight |
| **Session** | Signed anonymous identity that owns jobs, uploads and objects |
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

---

## Maintenance policy

**Update this document whenever you change behavior that a future engineer (or agent) needs to understand without reading the full diff.** That includes, but is not limited to:

- Generation topology (stream / take-home / process ticks / nudges)
- Catalog curation, accent steering, preview emptiness rules
- Storage or schema assumptions (Turso columns, R2 layout)
- Pricing / stream budget knobs that affect product promises
- Removed legacy paths (so nobody revives them by accident)

Lightweight UI copy tweaks do not require a TDD edit unless they rename a product path (e.g. “Try a chapter”).

---

*This document reflects Echomancer v2 as of the OpenRouter-curated stock TTS
architecture (Gemini / Qwen / Microsoft / Grok / Minimax), with consumer UX paths
“Try a chapter” and “Get the whole book,” session-scoped ownership, and a
lease-based cron worker.*
