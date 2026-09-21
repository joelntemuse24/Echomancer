# Echomancer v2 — Technical Design (Code Walkthrough)

**Audience:** someone who will open the repo and follow along. This document is
organized as a **map of the code**, not a product brief. Every important module
is named; every major export is explained; end-to-end flows are traced through
concrete files and functions.

**Live app:** [echomancer.xyz](https://echomancer.xyz) (Vercel project
`echomancer-v2`). **As of 2026-09-20.**

**Companion docs:** `AGENTS.md` (agent/ops cheat sheet), `WORKER.md`
(Oracle Always Free + pm2 + Caddy), `DEPLOYMENT.md`, `TURSO_R2_SETUP.md`,
`README.md`.

---

## Table of Contents

1. [What the product is (one page)](#1-what-the-product-is-one-page)
2. [Repository map](#2-repository-map)
3. [Request lifecycle](#3-request-lifecycle)
4. [Identity & sessions](#4-identity--sessions)
5. [Ownership guards](#5-ownership-guards)
6. [Rate limiting](#6-rate-limiting)
7. [Database (Turso)](#7-database-turso)
8. [Schema & runtime migrations](#8-schema--runtime-migrations)
9. [Uploads & text extraction](#9-uploads--text-extraction)
10. [Storage abstraction (local + R2)](#10-storage-abstraction-local--r2)
11. [Storage HTTP proxy](#11-storage-http-proxy)
12. [Voice catalog](#12-voice-catalog)
13. [Personas, accents, style honesty](#13-personas-accents-style-honesty)
14. [TTS providers](#14-tts-providers)
15. [Audio formats & silence guards](#15-audio-formats--silence-guards)
16. [Jobs API — create & list](#16-jobs-api--create--list)
17. [Job detail, cancel, retry, delete](#17-job-detail-cancel-retry-delete)
18. [Live stream path](#18-live-stream-path)
19. [Take-home worker (always-on VM + leases)](#19-take-home-worker-always-on-vm--index-stable-fan-out)
20. [Download & concatenation](#20-download--concatenation)
21. [Pricing & ETA](#21-pricing--eta)
22. [Frontend surfaces](#22-frontend-surfaces)
23. [Errors & UX copy](#23-errors--ux-copy)
24. [Testing](#24-testing)
25. [Environment & deployment knobs](#25-environment--deployment-knobs)
26. [Invariants checklist](#26-invariants-checklist)
27. [Glossary](#27-glossary)

---

## 1. What the product is (one page)

Echomancer turns an uploaded document into listen-able audio. Customer stock
voices are **Standard** (Edge `en-US-AndrewNeural`), **Michelle** (Edge
`en-US-MichelleNeural`), **Clara** (curated Fish), and **Randolph** (Google
Cloud TTS `en-GB-Neural2-O`). Optional **Fish voice cloning** uses the direct
Fish API (`FISH_API_KEY`). There is **no self-hosted TTS**: the Whole-book VM
orchestrates Fish / Edge / Google APIs; it does not run Fish locally.

Two customer paths:

| Customer language | `job_kind` | What the code does | Host |
|-------------------|------------|--------------------|------|
| Live Stream | `stream` | Pipe provider audio live; cap chars/time; store **no** audio | Vercel |
| Get the whole book | `takehome` | Freeze speakable sections → synthesize → R2 → remux / master | Oracle Always Free VM |

`generation_mode` is always `"stock"` in v2. The narrator page forks
**Standard** vs **Clone** before any catalog.

Rough money: take-home price is dynamic from character count × voice rate
(`src/lib/tts/pricing.ts`). Product target ≈ **€4.50** for a typical novel —
not a hard ceiling.

### Production topology (2026-09-20)

| Piece | Live host |
|-------|-----------|
| App | Next.js on Vercel (`echomancer.xyz` / project `echomancer-v2`) |
| Database / objects | Turso + Cloudflare R2 |
| Document extract | Cloudflare Workers (`workers/extract`, wrangler name `echomancer-extract`). Vercel `after()` fallback. **Not Trigger.dev.** Voice pick stays unblocked while extract runs. |
| Whole-book TTS | Always-on Oracle Cloud Always Free Ampere VM: `VM.Standard.A1.Flex`, **2 OCPU / 12 GB**, Ubuntu aarch64. Node + pm2 process `echomancer-takehome`. Binds **`127.0.0.1:8788` only**. Stay on this Always Free shape; do not recommend paid Oracle shapes. `WORKER_CONCURRENCY=1`. |
| TLS / `WORKER_URL` | **Caddy on the VM** terminates HTTPS for `worker.echomancer.xyz`. DNS A record lives on **Vercel** (apex `echomancer.xyz` uses Vercel nameservers). The domain is **not** a Cloudflare DNS zone. Vercel `WORKER_URL` + `WORKER_SECRET` call the worker over HTTPS. |
| Named Cloudflare Tunnel | Optional in the runbook, but **blocked** unless a Cloudflare zone exists. Do **not** use `trycloudflare.com` quick tunnels as production `WORKER_URL`. |
| Trigger.dev | **Legacy fallback** in the repo (`takehome.advance` / `takehome.drain`). **Not** the production Whole-book runner. Extract `upload.extract` / `upload.drain` are no-ops. |

---

## 2. Repository map

```
src/
  proxy.ts                     # Next.js middleware (anonymous session mint)
  app/
    page.tsx                   # Landing upload
    layout.tsx                 # Fonts, theme, toaster
    dashboard/
      layout.tsx               # Nav shell
      voice/page.tsx           # Narrator picker + job create
      queue/page.tsx           # Library + polling
      player/[id]/page.tsx     # Playback
      resources/page.tsx       # Static how-to
    api/
      pdf/upload/              # JSON presign (tiny). Browser PUTs to R2.
      pdf/upload/[id]/         # complete + poll extraction
      pdf/upload/[id]/object/  # local PUT when R2 is unset
      jobs/                    # Create / list
      jobs/[id]/               # Detail / delete / retry
      jobs/[id]/stream/        # Live listen
      jobs/[id]/takehome/      # Promote stream → full book
      jobs/[id]/process/       # Internal worker (one job)
      jobs/[id]/download/      # Assembled file
      jobs/[id]/cancel/
      cron/process-jobs/       # Queue drain
      storage/[[...path]]/     # Ownership-gated file proxy
      tts/voices/              # Catalog
      tts/preview/             # Short paid preview
      auth/[...nextauth]/      # Auth.js Google OAuth + CSRF
      auth/logout/             # Sign out → fresh anon cookie
      me/                      # Signed-in profile for chrome
      health/
  lib/
    auth/{session,guard,google,authjs,identity,actions,sign-out}.ts
    rate-limit.ts
    jobs/{serialize,worker-auth,takehome-dispatch,takehome-worker-client,trigger-api,trigger-takehome,trigger-extract,trigger-secrets}.ts
    turso.ts + turso/{jobs,uploads,cloned-voices,clone-uploads}.ts
    storage/index.ts + r2-storage.ts
    uploads/{extract,http,rate-limit}.ts
    text-extraction.ts + document-formats.ts + clone-sample-formats.ts + upload-client.ts
    tts/…                      # Entire synthesis stack
                               # speakable-text.ts (TTS script sanitizer)
                               # clone-sample-audio.ts (WAV PCM cleanup, no ffmpeg)
                               # clone-sample-quality.ts (pass/warn/fail gate, no SNR)
                               # mastering.ts + mastering-worker.ts (VM DFN 0.4/0.6 + 44.1/192)
    validation.ts, errors.ts, errors-ui.ts, ux-copy.ts
  worker/{takehome-server,takehome-loop,takehome-http,auth}.ts
  hooks/useAudioProcessor.ts
  test/{harness,setup-env}.ts
scripts/oracle/                # Always Free VM bootstrap (pm2 / Caddy / smoke)
workers/extract/               # Cloudflare Worker: document parse next to R2
workers/takehome/Dockerfile    # Optional Whole-book image (multi-arch DFN)
docker-compose.yml             # Optional Docker path (pm2 is primary)
WORKER.md                      # Oracle Always Free + pm2 + Caddy runbook
migrate-turso.sql              # Additive SQL mirror of runtime migrator
vercel.json                    # Empty schema on Hobby (no native cron)
```

---

## 3. Request lifecycle

```
Browser
  │
  ▼
src/proxy.ts
  • If SESSION_SECRET configured: read cookie / mint anon session
  • Existing user_* cookies are left alone
  • Overwrites request header x-ec-session with verified token
  • Sets ec_session cookie when newly minted
  │
  ▼
Route handler (App Router)
  • Re-verifies session via resolveSessionUserId() — never trusts header alone
  • Rate limit (Turso-backed)
  • Ownership / machine auth as needed
  │
  ├─► Turso (jobs, uploads, rate_limits, usage_logs)
  ├─► Storage (local FS or R2) via lib/storage
  ├─► Extract: Cloudflare Worker (`EXTRACT_WORKER_URL`) or Vercel `after()`
  └─► TTS: Edge / Fish / Google (Vercel for live; Oracle VM for Whole book)
```

**Why proxy + re-verify:** proxy issues identity early so every page gets a
cookie; handlers re-HMAC-check so a forged `x-ec-session` cannot impersonate.

---

## 4. Identity & sessions

### `src/lib/auth/session.ts`

Every visitor starts anonymous (`anon_<32 hex>`). Google sign-in upgrades the
same httpOnly `ec_session` cookie to a durable `user_*` id. Auth.js is only the
OAuth broker — it is not the source of ownership.

| Export | Role |
|--------|------|
| `SESSION_COOKIE` (`ec_session`) | httpOnly cookie name |
| `SESSION_HEADER` (`x-ec-session`) | Internal header proxy sets |
| `getSessionSecret()` | `SESSION_SECRET` → fallback `INTERNAL_JOB_SECRET` → **throws** in prod if missing; uses known dev secret locally |
| `getAuthSecret()` | `AUTH_SECRET` → `SESSION_SECRET` → `INTERNAL_JOB_SECRET` → **throws** in prod if missing |
| `isSessionConfigured()` | Boolean wrapper for proxy (must not throw) |
| `newAnonymousUserId()` | `anon_<32 hex>` |
| `newDurableUserId()` | `user_<32 hex>` — never a Google `sub` |
| `signSessionToken()` | `v1.<userId>.<issuedAt>.<hmac>` |
| `verifySessionToken()` | Timing-safe HMAC; user id must match `anon_[0-9a-f]{32}` or `user_[\w-]{1,64}` |
| `mintSession()` / `mintSessionFor()` | New anon token, or a token for a known id |
| `readSession(req)` | Header first, then cookie; always re-verifies |
| `resolveSessionUserId(req)` | **Single resolver** used by routes |
| `readOrMintSession(req)` | Upload may mint on first visit |
| `attachSessionCookie(res, session)` | Sets cookie options (httpOnly, SameSite=Lax, Secure in prod, 1y) |
| `stripAuthjsSessionCookies(res)` | Expires Auth.js session cookies so they cannot fight `ec_session` |

**Invariant:** production must not invent a random per-instance secret — that
would make every serverless isolate a different “you” and empty the library.

### Google sign-in (`src/lib/auth/google.ts`, `authjs.ts`)

| Piece | Role |
|-------|------|
| Auth.js v5 Google provider | CSRF + OAuth callback at `/api/auth/*` |
| `users` table | `id` (`user_*`), `google_sub` (unique), email, name, image, created_at |
| `completeGoogleSignIn()` | Upsert by `google_sub`, merge this browser's `anon_*` rows, mint `user_*` cookie |
| `mergeAnonymousOwnership()` | `UPDATE` jobs / uploads / cloned_voices **only** where `user_id = anon_*` |
| `POST /api/auth/logout` | Fresh `anon_*` cookie; previous library is no longer visible |
| Chrome | Header “Sign in” (no provider name). Signed-in name opens a menu (Settings / Library / Dark mode / Sign out). Sign out is not a standalone top-right control. |

Same Google account on two browsers gets the same `user_*`. Missing
`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` fails closed (503
`GOOGLE_AUTH_NOT_CONFIGURED`) when someone tries to start sign-in; anonymous
upload and Live Listen still work.

### `src/proxy.ts`

```ts
export async function proxy(request: NextRequest) {
  if (!isSessionConfigured()) return NextResponse.next();
  let session = await readSession(request);
  let minted = false;
  if (!session) { session = mintSession(); minted = true; }
  // overwrite header so clients cannot smuggle identity
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(SESSION_HEADER, session.token);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  if (minted) attachSessionCookie(res, session);
  return res;
}
```

Matcher skips Next static assets / favicon.

---

## 5. Ownership guards

### `src/lib/auth/guard.ts`

| Export | Behavior |
|--------|----------|
| `requireSession(req)` | No valid session → **401** `SESSION_REQUIRED` |
| `requireOwnedJob(req, id, columns?)` | Load non-deleted job; wrong `user_id` → **404** (not 403); missing → 404 |
| `ownsUploadPath(userId, path)` | Match `uploads.storage_path` or `source_path` |
| `ownsStoragePath(userId, path)` | `audiobooks/<jobId>/…` → `jobs.user_id`; `pdfs/<uploadId>/…` → `uploads.user_id`, with legacy fallback to jobs by `pdf_storage_path LIKE` |

**404 vs 401 vs empty list:**

| Situation | Response |
|-----------|----------|
| No session on owned job detail | 401 |
| Session but wrong/missing job | 404 |
| No session on `GET /api/jobs` | `[]` (empty library) |
| No session / wrong owner on `/api/storage` | 404 (avoid key probing) |

Projection rule for `requireOwnedJob`: callers may request columns, but must
always include fields they later read (`id`, `user_id`, …).

---

## 6. Rate limiting

### `src/lib/rate-limit.ts`

Counters live in Turso table `rate_limits` (not memory) because Vercel isolates
do not share RAM.

| Export | Role |
|--------|------|
| `createRateLimiter(max, windowMs, { onError })` | Fixed window; atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING count` |
| `rateLimitIdentity({ userId, ip })` | `u:<id>` or `ip:<sha256 truncated>` |
| `clientIp(req)` | `x-forwarded-for` first hop, else `x-real-ip` |

**Fail policy:**

- Costly routes (create, upload, stream, preview, catalog): `onError: "closed"` → deny if DB fails.
- Storage proxy: fail **open** so a Turso blip does not brick playback.

Typical caps (see each route): upload 10/min, jobs 5/min, preview 15/min, storage 600/min.

---

## 7. Database (Turso)

### `src/lib/turso.ts`

| Export | Role |
|--------|------|
| `getTursoClient()` | Singleton libSQL; needs `TURSO_DATABASE_URL` (+ optional `TURSO_AUTH_TOKEN`) |
| `query` / `queryOne` / `execute` | Thin wrappers |
| `transaction(fn)` | Write transaction with commit/rollback |
| `closeTursoClient()` | Test seam |

### `src/lib/turso/jobs.ts`

| Export | Role |
|--------|------|
| `getJob(id)` | Full non-deleted row; **no** ownership check |
| `updateJob(id, patch)` | Dynamic SET for status/progress/audio/error/… |
| `deleteJob(id)` | Soft delete: `deleted_at = unixepoch()` |
| `resetJob(id)` | Coarse requeue helper (route-level retry does a fuller reset) |
| `logUsage(…)` | Best-effort insert into `usage_logs`; **never throws** |

### `src/lib/turso/uploads.ts`

| Export | Role |
|--------|------|
| `recordUpload({ id, userId, storagePath, sourcePath, … })` | Ownership proof (paste + ready extracts) |
| `insertPendingUpload(…)` | Row created at presign (`status: pending`) |
| `getUploadForUser(userId, storagePath)` | Exact match on extracted `content.txt` path **and** `status = ready` — used by job create |
| `getUploadById` / `getUploadByIdForUser` | Worker and poll/complete |

---

## 8. Schema & runtime migrations

### `migrate-turso.sql`

Additive SQL for humans / ops. **Must not** `DROP TABLE jobs`. Mirrors what the
runtime migrator creates.

### `src/lib/tts/schema-migrate.ts`

| Export | Role |
|--------|------|
| `ensureTtsJobColumns()` | Idempotent. Cold isolates first check whether the live schema is already current (one round-trip). Otherwise `CREATE TABLE IF NOT EXISTS` for `jobs`, `uploads`, `usage_logs`, `cloned_voices`, `clone_uploads`, `fish_inflight`, `users` (batched); `ALTER TABLE … ADD COLUMN` for `JOB_COLUMNS`, `UPLOAD_COLUMNS`, and `USER_COLUMNS` (`google_sub`, `email`, `name`, `image`, `created_at`); then indexes (`idx_users_google_sub` unique) |
| `resetSchemaMigrationCache()` | Tests |

Important columns on `jobs` (non-exhaustive):

- Identity: `id`, `user_id`, `deleted_at`
- Source: `book_title`, `pdf_storage_path`, `char_count`
- Voice: `tts_provider`, `provider_voice_id`, `catalog_voice_id`, `tts_options`, `voice_name`
- Kind: `generation_mode`, `job_kind` (`stream` \| `takehome`)
- Progress: `status`, `progress`, `current_section`, `total_sections`, `next_section_index`, `segments_json`
- Stream: `stream_cursor`, `stream_chars_used`, `stream_max_chars`
- Lease: `processing_lease_token`, `lease_expires_at`, `processing_started_at`, `generation_started_at`
- Output: `audio_storage_path`, `duration_seconds`, `price_estimate_eur`, `parent_job_id`, `error_message`

Statuses used in practice: `queued`, `processing`, `ready`, `failed`, `cancelled`.

`users` (`id` = `user_*`, unique `google_sub`) is additive. A pre-existing
`users` table without `google_sub` is healed with `ALTER TABLE ADD COLUMN`
(CREATE TABLE IF NOT EXISTS is a no-op on that leftover). Uniqueness is the
`idx_users_google_sub` index — SQLite cannot ADD a UNIQUE / NOT NULL column.

Called at the top of upload/job/worker/auth routes so cold DBs self-heal.

---

## 9. Uploads & text extraction

### `src/lib/document-formats.ts` (browser-safe)

Shared by landing page and upload route:

- `SUPPORTED_DOCUMENT_*`, `detectFormat(name, mime)`
- `maxUploadMb()` / `maxUploadBytes()` from `MAX_UPLOAD_MB` **and**
  `NEXT_PUBLIC_MAX_UPLOAD_MB` (keep both in sync — browser only sees the public one)
- Default cap **512 MB** (`DEFAULT_MAX_UPLOAD_MB`). This is a product ceiling for
  whole books and phone scans, **not** Vercel’s ~4.5MB function body limit.
  Keep `MAX_UPLOAD_MB` and `NEXT_PUBLIC_MAX_UPLOAD_MB` in sync. If either is
  still set to `25` in Vercel env, update both to `512`.

### `src/lib/text-extraction.ts` (server-only)

| Path | Library / tool |
|------|----------------|
| PDF | `unpdf` |
| EPUB | `epub2` (temp file) |
| DOCX | `mammoth` |
| TXT | UTF-8 |
| RTF | control-word strip |
| MOBI/AZW | Calibre `ebook-convert` if present |

Then normalizes: hyphenation across line breaks, page markers, soft wrap joins,
blank-line collapse. Rejects under `MIN_EXTRACTED_CHARS` (50).

### Speakable text — `src/lib/tts/speakable-text.ts`

`toSpeakableText` runs **after extract / paste, before `content.txt` is stored**
(and again when Whole book / Live Stream load the book, so older extracts stay
safe). Char counts and Fish spend then match what is spoken.

It strips emails (including spaced `name @ google . com` so Fish cannot spell
the domain or say “punct” for “.”), URLs, arXiv / DOI / ISSN / copyright lines,
and obvious academic cover metadata (author lists with footnote marks,
affiliations like “Google Brain”, venue lines like “31st Conference…” /
“Proceedings of”, Google figure-reproduction grants, “Equal contribution…”
credit blocks, and “Work performed while at …”) when the rest of the document
has body prose. Venue matching is **local** (not `[\\s\\S]*$` through EOF) so a
glued PDF paragraph cannot delete Abstract / Introduction. Glued academic
extracts are split at headings (Abstract, Introduction, Background, numbered
sections, Chapter/Part) **on the same line** so headings are never fused into
the next sentence. Long high-chars/sentence blocks get paragraph breaks back;
short “A sentence.” loops and already-broken novels are left alone. Title,
Abstract, Introduction, and real sentences stay. Novel bylines are not eaten.
Idempotent. Does **not** rewrite product copy. Does **not** insert Fish pause
tags — those are applied at synthesis time.

After the academic peel, `normalizeSpeakableText`
(`src/lib/tts/normalize-speakable.ts`) applies **general** PDF/OCR hygiene —
not essay- or voice-specific rewrites:

| Default | What happens |
|---------|----------------|
| Footnote glyphs `* ∗ † ‡ §` | Stripped when they would be spoken |
| Editorial `[like this]` | Unwrap; keep inner text |
| Numeric citations `[1]`, `[12-14]` | Dropped (do not speak the numbers) |
| ALL-CAPS heading lines | Title Case (`THE TWO CITIES` → `The Two Cities`). Short acronyms like `USA` stay. |
| Lone Roman section lines (`I`–`XX`…) | Treated as a paragraph break; not spoken |
| Whitespace | Collapse runs; keep `\n\n` paragraph structure |
| Fish `[break]` / `[long-break]` | Preserved |

No literary restyling. No Bloom / Caesar / title-specific word lists.

Wired from: `extractUploadedDocument`, `POST /api/text/upload`,
`loadBookText` (take-home), `createStreamAudioIterator` (Live Stream), and
optional Live Listen sample text on `/api/tts/live`.

### Narration script — `src/lib/tts/narration-script.ts`

Audiobook pacing is **pauses and phrasing**, not slower vowels. Fish S2
honors `[break]` (short) and `[long-break]` (extended) in the `text` field
([emotion / special-effect cues](https://docs.fish.audio/developer-guide/core-features/emotions)).
S1 `(break)`, blog `[pause]`, SSML `<break>`, and ffmpeg `atempo` are not used.

`toFishNarrationScript` takes speakable text and:

- puts `[long-break]` after headings and between paragraphs
- puts `[break]` between long academic sentences (high chars/sentence)
- may put **one** `[break]` after a mid comma on sentences longer than
  `LONG_SENTENCE_COMMA_BREAK_CHARS` (220), via `decideLongSentenceCommaBreak`
- never inserts a break after every `and` / `that` / comma
- leaves short dialogue untagged so it does not chop every beat
- is idempotent

Light keyword emotion tags stay **Fish-only** for Live. Whole-book Fish /
clone uses the OpenRouter section tagger (see below). Delivery is still
pacing + official S2 cues, not a prose rewrite.

Whole-book knobs are **not invisible constants**. `resolveDeliverySettings`
(`src/lib/tts/delivery-settings.ts`) derives adaptive defaults from the book
(sentence length, punctuation density, ALL-CAPS / Roman headings, quote
ratio, length). Users can override them on the narrator page (**Narration
delivery**: pauses, joins, titles, tone). Choices persist on `jobs.tts_options`
and in `localStorage`. Live Stream (`createStreamAudioIterator`) and Live
Listen (`/api/tts/live`) resolve the same knobs from the book / sample plus
`jobs.tts_options` or request `ttsOptions`. Soft crossfade stays Whole-book
concat only.

`narrationScriptForSynthesis(text, providerId, { deliveryPrefix, pauseStyle })`
inserts Fish `[break]` / `[long-break]` for **Fish, Edge, and Google**.
OpenRouter / Gemini / Grok stay untagged — they would speak the words.
Google maps those pause tags to SSML `<break time="300ms" />` /
`<break time="700ms" />` in `ssml-pauses.ts`. Edge Read Aloud rejects
custom `<break>` markup (websocket 1007 "SSML is invalid"), so the same
IR becomes punctuation breaths inside the stock speak/voice/prosody
envelope. Rate / `speakingRate` stay unchanged.

**Emotion / style tags stay Fish-spoken only.** Live Listen / Live Stream
keep the light keyword heuristics in `narration-script.ts`. Whole-book
**Fish, Edge, and Google** jobs run **one logical** OpenRouter chat tagger
(`src/lib/tts/fish-cue-tagger.ts`) on the frozen speakable before
the existing chapter/paragraph packer (`packSpeakableSections`) splits it.
The model may only insert official Fish S2 square-bracket cues;
`sanitizeFishS2TaggedText` allowlists tags and rejects any prose rewrite.
Timeout ceiling defaults to **40_000 ms** (`FISH_CUE_TAGGER_TIMEOUT_MS`,
clamp 1s–120s) for the whole pass — a max, not a wait. Each chunk also has a
**12s** abort so one slow shard cannot burn the budget. Default model is
`deepseek/deepseek-v4-flash` (`FISH_CUE_TAGGER_MODEL`; paid-cheap, not a
`:free` router slug). Long speakables are split on paragraph boundaries
(~3k chars) and tagged in **parallel (4)**. Reasoning is disabled
(`reasoning.effort=none`) so thinking models cannot spend the timeout
before emitting tags. Set `FISH_CUE_TAGGER=0` to disable. Missing key /
timeout / HTTP error / rewrite fail-open **per chunk** to the original
slice, then packing continues. The job is marked **ready on dry concat**
(loudnorm remux); DeepFilter remaster overwrites `full.*` afterwards and
must not delay Make→ready. Fan-out (`TTS_TAKEHOME_FANOUT=5`), ordered
remux, and the Fish-bound wall-clock floor are unchanged.

At synth time, Fish keeps emotion/tone tags. Edge / Google run
`stripFishDeliveryCues` / `stripNonPauseFishCues` so those tags are
**never spoken as words**, then the existing pause IR mapping applies:
Google SSML `<break>`, Edge punctuation breaths (never custom `<break>`,
which is websocket 1007). OpenRouter / Gemini / Grok stay untagged.

Whole book and Live pass `deliveryPrefix` from the
resolved settings. Set `TTS_WHOLE_BOOK_DELIVERY_PREFIX=0` to disable the
prefix globally. Live Stream cursor still advances over the untagged
speakable window so offsets do not drift.

Whole-book Fish section 0 uses `latency: "balanced"` so the player can start
sooner; sections 1+ use `latency: "normal"` (API: most stable quality).
`chunk_length` is 300 (API max / default). A silent-audio retry stays on
`normal`. Live Listen / Live Stream keep `latency: "balanced"`.

`src/lib/tts/narration-pace.ts` sets Fish `prosody.speed` (0.75–1.0) from
**speech WPM** (`duration − silence` when known). Target is **150–155**
(constant `152`). Pause ratio is not a reason to skip — PR44 hit 0.127
silence share at **194 speech WPM**. No ffmpeg / atempo.

First section is not stuck at 1.0: `initialNarrationSpeed` starts clones and
dense academic at **0.85** (typical Fish speech ~190 WPM). Stock Narrator on
conversational prose stays **1.0**. Live Listen / Live Stream pass the same
speed (`latency: "balanced"`). Persist `narrationSpeed` on `tts_options` and
recalibrate after measured sections.

Player pills (`src/lib/player/playback-speed.ts`) add listen-time **0.8** and
**0.9**. That is `HTMLAudioElement.playbackRate`, not Fish generation speed.

### Document upload — presign + R2 PUT + near-request extract

Vercel never buffers the document. Hobby `FUNCTION_PAYLOAD_TOO_LARGE` is ~4.5MB.

Extract is **not** Trigger.dev and **not** VM-worker work. Parsing (unpdf /
mammoth / JSZip) is CPU-light and sits next to R2 on Cloudflare Workers
(`workers/extract`). The always-on Oracle VM is Whole-book TTS only
(minutes, ffmpeg, DeepFilterNet). Voice selection is unblocked while extract
runs in the background.

1. **`POST /api/pdf/upload`** — JSON `{ fileName, contentType, byteSize }`
   - `readOrMintSession()`, fail-closed rate limit, format + ceiling checks
   - Inserts `uploads` row (`status: pending`) owned by the session
   - Returns `{ uploadId, putUrl, putHeaders, storagePath }`
   - Production: R2 presigned PUT (`getUploadUrl`). Dev/tests without R2:
     `putUrl` is `/api/pdf/upload/<id>/object`
   - Does **not** require `TRIGGER_SECRET_KEY`
2. **Browser `PUT putUrl`** — file bytes go to R2 (CORS required) or the local
   object route. Secrets never leave the server.
3. **`POST /api/pdf/upload/[id]`** — complete: HEAD the object (no download),
   then `dispatchUploadExtract`:
   - `EXTRACT_WORKER_URL` + secret → POST Cloudflare Worker (202 + `waitUntil`)
   - tests / local → `extractUploadedDocument` in-process
   - production without Worker → inline extract when `byte_size` ≤ 8MB,
     else `after(() => extractUploadedDocument)` (GET re-nudges)
   Worker reject is **503** `EXTRACT_WORKER_FAILED`. Does **not** enqueue
   `upload.extract` on Trigger.
4. **Cloudflare Worker** `workers/extract` — R2 binding (or S3-compatible
   fallback) + Turso HTTP → `extractTextFromDocument` → `toSpeakableText` →
   `content.txt` → `status: ready`. Paid CPU limit 5 min (`cpu_ms = 300000`).
5. Voice step polls **`GET /api/pdf/upload/[id]`** in the background (landing
   does not wait). GET re-nudges stuck `uploaded` (20s) or `extracting` (180s).
   Trigger `upload.extract` / `upload.drain` are no-ops (`src/trigger/extract-upload.ts`).
6. Job create still requires a **ready** `uploads` row for `content.txt`
   (`TEXT_NOT_READY` 409 while extract is still running).

Multipart `POST /api/pdf/upload` is rejected (`USE_PRESIGN`).

Missing session secret in production → **503** (deliberate).

### `POST /api/text/upload` — paste intake

Same ownership/storage contract without file extraction:

1. JSON `{ text, title? }` (50–500_000 chars after trim)
2. `toSpeakableText` then write `pdfs/<uuid>/content.txt` only
3. `recordUpload(format: "txt", fileName: title)`
4. Return `{ storagePath, fileName, charCount, source: "paste", … }`

Landing page offers **Upload** | **Paste text**; both continue to
`/dashboard/voice` (no path yet). The voice step forks **Standard** vs
**Clone** before any catalog.

---

## 10. Storage abstraction (local + R2)

### `src/lib/storage/index.ts`

Single façade used by workers and upload:

| Export | Role |
|--------|------|
| `uploadFile(dir, name, data, contentType)` | R2 if configured, else FS |
| `downloadFile(path)` | Buffer |
| `deleteFile` / `listFiles` / `getFileMetadata` / `fileExists` | Same split |
| `getPublicUrl(path)` | Always `/api/storage/<path>` — never raw R2 URLs in the app |

Local root: `STORAGE_PATH` or `./data/storage` (dev) / `/tmp` on Vercel without R2.

### `src/lib/r2-storage.ts`

Configured when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
are set. S3-compatible client against Cloudflare R2. `getUploadUrl` mints a
short-lived **PUT** with **Content-Type signed only** (not Content-Length —
browser `fetch` cannot set that header, and a signed length 400s the PUT).
`getFile` currently
**buffers the whole object** (known P2 leftover — range serving still goes
through the HTTP proxy after a full fetch). Browser PUTs require a bucket CORS
policy — see `TURSO_R2_SETUP.md`.

Path conventions:

```
pdfs/<uploadId>/source.<ext>
pdfs/<uploadId>/content.txt
audiobooks/<jobId>/speakable.txt       # frozen speakable script
audiobooks/<jobId>/sections.json       # frozen chapter/paragraph pack
audiobooks/<jobId>/sections/0000.mp3   # or .wav
audiobooks/<jobId>/full.mp3
```

Paths are predictable → **not** secrets; ownership is enforced in the proxy.

---

## 11. Storage HTTP proxy

### `GET /api/storage/[[...path]]` — `src/app/api/storage/[[...path]]/route.ts`

1. Reject empty / `.` / `..` / absolute segments
2. No session → **404**
3. Rate limit fail-open
4. `ownsStoragePath` → else 404
5. Optional `?download=` filename for `Content-Disposition`
6. Load from R2 or local; wrap `.pcm` as WAV; honor `Range` → 206

Headers: `Cache-Control: private, no-store`, `Accept-Ranges: bytes`.

---

## 12. Voice catalog

### Allowlist — `src/lib/tts/catalog/allowlist.ts`

- Allowed vendors: `edge`, `fish-audio`, `google`, `qwen`, `minimax`, `microsoft`, `x-ai`, `xai`
- Hard-blocked substrings: `zonos`, `kokoro`, `deepgram`, `orpheus`, `sesame`,
  `voxtral`, `aura-`
- `MINIMAX_SEEDED_VOICES`: OpenRouter advertises empty voices for MiniMax;
  we seed known system voice IDs

### Live expansion — `src/lib/tts/catalog/openrouter-catalog.ts`

| Function | Role |
|----------|------|
| `usdPerMillionCharsForModel(modelId, pricingPrompt)` | Confirmed overrides first (Fish free 0 / Fish paid 15, MiniMax HD 100 / Turbo 60, MAI-Voice-2 22 / Flash 15, Qwen Plus 20 / Flash 15, Grok 15). Else derive `prompt × 1e6`; reject outside **$0.50–$500**/M and return `undefined` |
| `expandModel(model)` | One card per `(model × voice)`; Gemini English → 4 accent variants; others get native-locale accent only |
| `fetchOpenRouterCatalogVoices()` | List speech models → expand → sort by price |

### Catalog API — `src/lib/tts/catalog/index.ts`

| Function | Role |
|----------|------|
| `listCatalogVoices(filters)` | Slim catalog: Standard, Michelle, Clara, Randolph; clones merged in voices API |
| `getCatalogVoice(id)` | Static / `clone:…` (user-scoped) / `research:` / live `or:…` / legacy `fish-narrator` |
| `getDefaultCatalogVoice()` | Standard (`standard`) |
| `isVoiceAvailable(voice, hdEnabled)` | Hide HD unless gate allows (fish clones always listed) |

### Fish voice cloning + live HTTP stream

| Piece | Role |
|-------|------|
| `FISH_API_KEY` | Native Fish API — create model + synthesize clones / Fish catalog |
| `POST /api/tts/clones/upload` | JSON presign `{ fileName, contentType, byteSize }` → PUT URL for `clones/<id>/sample.<ext>`. Ownership in `clone_uploads`. |
| `POST /api/tts/clones` | JSON `{ uploadId, title? }` → download stored sample → **quality gate** (`analyzeCloneSampleBuffer` on 16-bit WAV; fail → 422 `SAMPLE_QUALITY`, no Fish) → `cleanupCloneSample` → Fish `POST /model` → `cloned_voices` (same id). Multipart rejected (`USE_PRESIGN`). App max **32 MB**; Vercel body is JSON-only. |
| Catalog id | `clone:<uuid>` · provider `fish` · `providerVoiceId` = Fish reference id |
| Synth path | Standard / Michelle → `edgeTtsProvider`. Clara → `fishTtsProvider` with curated `reference_id`. Randolph → `googleTtsProvider` (`en-GB-Neural2-O`). User clones → `fishTtsProvider` with account `reference_id` when `FISH_API_KEY` is set. Legacy `fish-narrator`: same Fish endpoint **without** `reference_id`. Never send OpenRouter catalog UUIDs as `reference_id`. |
| Live preview | `GET/POST /api/tts/live` opens Fish HTTP first, then pipes **chunked** MP3 (`latency=balanced`). Fish 4xx before bytes → JSON, never HTML `/500`. |
| Stream path | `synthesizeStream` yields Fish response body chunks (not a buffered unary clip) |
| Table | `cloned_voices` (session-scoped, soft-delete); `clone_uploads` (pending sample PUT) |

Fish also has a WebSocket `/v1/tts/live` for LLM token streaming; Echomancer does
**not** proxy it — previews and listen already have full text, so HTTP chunked
streaming is enough and fits serverless.

### `GET /api/tts/voices`

Returns `{ voices, listenVoices, source, openRouterConfigured, researchPreview, slimCatalog, … }`
with optional price/ETA when `charCount` is passed. App ships a slim catalog
(Standard, Michelle, Clara, Randolph + session clones).

---

## 13. Personas, accents, style honesty

### `src/lib/tts/accent-prompt.ts`

| Export | Honesty rule |
|--------|--------------|
| `modelSupportsAccentVariants(modelId)` | **Only Gemini** → multi-accent cards + directed input |
| `modelSupportsStyleInstructions(modelId)` | OpenAI / Gemini / google; **false** for Minimax & Microsoft (and thus Qwen/Grok by omission) |
| `geminiDirectedInput(text, accent)` | Embeds accent in spoken input (short vs long form) |
| `narrationStylePrompt(accent)` | Soft copy — aggressive “IMPORTANT” prompts caused empty PCM |

### `src/lib/tts/resolve-style-prompt.ts`

Priority: explicit `ttsOptions.stylePrompt` → catalog `stylePrompt` →
locale/accent-derived narration prompt.

### `src/lib/tts/voice-persona.ts`

| Export | Role |
|--------|------|
| `stripVoiceIdDecorations` / `friendlyVoiceName` | Human labels from ugly provider ids |
| `inferAccent` | `accentHint` → locale → heuristics (**never** `qualityNotes`) |
| `inferVibe` | calm / warm / upbeat / smooth / dramatic / clear |
| `isListenFriendly` / `isTakehomeFriendly` | Live vs full-book curation |
| `enrichCatalogVoice` | Friendly name, accent, vibe, flags |
| `curateListenVoices` | Short diverse listen menu; one card per underlying voice |

### Where style is applied

Preview, stream windows, and `synthesizeSection` all gate:

```ts
stylePrompt =
  supportsDirection || !supportsStyle || attempt > 0
    ? undefined
    : resolveStylePrompt(...)
```

Gemini attempt 0 uses `geminiDirectedInput`; retries drop direction.

---

## 14. TTS providers

### `src/lib/tts/providers/index.ts`

```ts
resolveStockAdapter({ provider, model, catalogVoiceId })
// Edge stock (standard / michelle) → edge adapter
// Clara / curated Fish stock → fish adapter (with reference_id)
// Randolph / provider google → google Cloud TTS (before OpenRouter)
// Fish clones + leftover Fish catalog models (when FISH_API_KEY) → fish
//   legacy fish-narrator omits native reference_id; clones send it
// if OPENROUTER_API_KEY → openrouter adapter
// else direct gemini / grok
```

### `src/lib/tts/providers/edge.ts` + `src/lib/tts/edge-tts.ts`

**Standard / Michelle** path. Talks to Microsoft Edge’s undocumented Read Aloud
websocket (`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`)
with a `Sec-MS-GEC` token — the same protocol as current Python `edge-tts`.
No Azure Speech subscription. Output is MP3. Voice id is `en-US-AndrewNeural`
(Standard) or `en-US-MichelleNeural` (Michelle). Handshake must pin Chromium
full `143.0.3650.75` → `Sec-MS-GEC-Version=1-143.0.3650.75` (`.96` hangs with
no `turn.end`), query order `TrustedClientToken`, `ConnectionId` (lowercase
hex), `Sec-MS-GEC`, `Sec-MS-GEC-Version`, and Cookie `muid=<32 hex uppercase>;`.
Node `ws` delivers text frames as `Buffer` with `isBinary=false` — classify
those as text so `Path:turn.end` ends the turn. Treating them as audio drops
the terminator and hangs `/api/tts/preview` until the 30s isolate timeout.

**Reliability / ToS:** Microsoft can change headers, rate-limit, or shut the
consumer endpoint down. This is not a contractual API. If synthesis starts
failing with handshake 403s or a hang, update `Sec-MS-GEC` / Chromium full
version in `edge-tts.ts` to match current `edge-tts` (`constants.py`) or
replace the adapter with paid Azure Speech.

### `src/lib/tts/browser-speech.ts`

Live Listen for Edge stock uses `window.speechSynthesis` **only** when the
browser exposes the matching neural (Andrew / Michelle). Otherwise the
picker falls back to `POST /api/tts/preview`. Never picks a random system
voice. Clara uses Fish HTTP live preview. Randolph always uses Google Cloud
TTS via preview / the job worker.

### `src/lib/tts/providers/openrouter.ts`

| Function | Role |
|----------|------|
| `listOpenRouterSpeechModels()` | `GET /models?output_modalities=speech`, ~10 min cache |
| `synthesizeOpenRouter` | POST `/audio/speech`; Gemini → PCM; others → MP3; `instructions` **only** for `openai/` models |
| `streamOpenRouter` | Same endpoint, streamed body |

**Do not** send a separate OpenRouter `prompt` for Gemini — empty PCM incident.

### Direct fallbacks

- `gemini.ts` — Google `generateContent`, L16 PCM → WAV wrap
- `google.ts` — Cloud TTS REST, MP3 (pseudo-stream = full buffer once). **Randolph** (`en-GB-Neural2-O`, Jan 2025 successor of `en-GB-Neural2-B`). Requires `GOOGLE_TTS_API_KEY` / `GOOGLE_API_KEY` or `GOOGLE_TTS_ACCESS_TOKEN`.
- `grok.ts` — xAI TTS, MP3 stream

### Types — `src/lib/tts/types.ts`

`CatalogVoice`, `SynthesizeInput/Result`, `TtsProviderAdapter`, `JobSegment`,
`PriceEstimate`, `JobKind`, `StockProvider`.

---

## 15. Audio formats & silence guards

### `src/lib/tts/pcm-wav.ts`

- Detect raw PCM; parse `rate=` from content type
- `pcmToWav` / `ensureBrowserPlayable`
- `sniffAudioContentType` via magic bytes
- `stripWavHeader` for concatenation

### `src/lib/tts/clone-sample-audio.ts`

CPU-only WAV PCM cleanup after the sample is read from storage (not from the
request body). **No ffmpeg / ffmpeg.wasm** (bundle size + Hobby 60s + must not
sit on the Vercel hot path).

| Export | Role |
|--------|------|
| `parseWavPcm` | 16-bit PCM WAV only; else `null` |
| `highPassPcm` | 4th-order high-pass (~100 Hz) to cut rumble / room boom |
| `noiseGatePcm` | Envelope gate on the quiet floor |
| `normalizePeakPcm` | Peak-normalize toward −1 dBFS (0.89) |
| `cleanupCloneSample` | WAV → mono PCM → filter → re-wrap WAV; **mp3/m4a/ogg passthrough** |

Fish `enhance_audio_quality` is still set; this pass just reduces room copied
into the clone. Browser-side trim/transcode can come later.

### `src/lib/tts/clone-sample-quality.ts`

Hard bar on clone samples so phone-in-a-room refs are rejected **before**
Fish `POST /model`. Cleaning tools (Adobe / Resemble / DeepFilterNet) do not
rescue baked-in echo — the UI tells people to re-record.

| Export | Role |
|--------|------|
| `evaluateCloneSampleQuality(metrics)` | Pure decision. Inject precomputed metrics in tests (Sep 2026 calibration: phone 2.4s / cleaned 1.2s fail; Wolfe 0.62s / studio2 0.43s pass). **SNR is never a hard fail.** |
| `CLONE_SAMPLE_QUALITY_THRESHOLDS` | 12–180s; `clip_frac > 0.001`; `speech_frac < 0.25`; speech level outside −45…−8 dB; `rt60 > 0.95` fail / `> 0.75` warn; `reverb_proxy > 0.40` and RT60 unknown or `> 0.75` → `echo_in_speech` |
| `measureCloneSamplePcm` | Frame RMS, clip fraction, decay-fit RT60, late/early reverb proxy |
| `analyzeCloneSampleBuffer` | `clone-sample-quality-analyze.ts` — 16-bit WAV only (server). Compressed → `null` (browser Web Audio checks those) |
| `analyzeCloneSampleFile` | Client `AudioContext.decodeAudioData` → same decision module |

JSON: `{ ok, verdict: pass\|warn\|fail, headline, primary_message, user_action, fails[], warns[], metrics }`. Fail headline: “This sample isn't good enough to clone well.” Primary action: re-record, don’t clean. Warn still creates the clone.

### `src/lib/tts/audio-guard.ts`

| Export | Role |
|--------|------|
| `isEmptyOrSilentAudio(buf)` | Too short, empty WAV data chunk, all-zero payload, tiny MP3 stub, or HTML/JSON error body |
| `isEmptyOrSilentStreamPayload(bytes, sawNonZero)` | Stream equivalent |
| `hasNonZeroByte` | Live stream early-exit from buffering |

Applied on **preview**, **take-home sections**, **stream windows**. Silence is
never stored as a successful segment and never advances the stream cursor.

### Split / window size

| Module | Role |
|--------|------|
| `speakable-text.ts` → `toSpeakableText` | Strip unspeakable tokens + academic cover; restore headings / paragraph breaks |
| `normalize-speakable.ts` → `normalizeSpeakableText` | Footnotes, editorial brackets, ALL-CAPS titles; lone Roman lines become `Chapter II` headings; Fish cue brackets preserved |
| `narration-script.ts` → `toFishNarrationScript` | Fish `[break]` / `[long-break]` IR at synth time (Fish / Edge / Google) |
| `narration-script.ts` | Light Fish-only emotions (Live); seminar prefix on academic text only (never fiction / Edge / Google) |
| `fish-s2-cues.ts` | Official S2 allowlist + sanitize / no-rewrite gate |
| `fish-cue-tagger.ts` | OpenRouter chat tagger: DeepSeek Flash default; long speakables paragraph-chunked in parallel (Fish / Edge / Google, before packing) |
| `ssml-pauses.ts` → `fishPausesToSsmlBody` | Map Fish pause tags to Google SSML `<break time="…ms" />` |
| `ssml-pauses.ts` → `fishPausesToEdgeProsodyText` | Map Fish pause tags to Edge-safe `…` / paragraph breaths (no `<break>`; Edge 1007) |
| `narration-script.ts` → `decideLongSentenceCommaBreak` | At most one mid-comma breath on sentences longer than 220 chars |
| `split-text.ts` → `packSpeakableSections` | Chapter-aware paragraph packer; page-number lines are layout, not speech boundaries |
| `frozen-script.ts` | First take-home claim writes `speakable.txt` + `sections.json` (cue-tag pass then pack for Fish / Edge / Google); later ticks never re-split or re-download the book |
| `section-size.ts` | Hosted Fish target **8000** / hard max **9200**; Edge/Google catalog limits unchanged; `STREAM_WINDOW_CHARS = 480` for Live Listen; Fish take-home section 0 stays ~2000 for TTFA |

---

## 16. Jobs API — create & list

### Validation — `src/lib/validation.ts`

- `uploadStoragePathSchema`: exact `pdfs/<uuid>/content.txt`
- `createJobSchema`: `mode: stock`, `jobKind`, path, optional voice fields, `charCount`, `parentJobId`

### `POST /api/jobs` — `src/app/api/jobs/route.ts`

**Enqueue only — never synthesizes.**

1. Session required (401)
2. Rate limit fail-closed
3. Zod parse
4. `getUploadForUser` — wrong path → 404
5. Resolve catalog / default voice; allowlist; HD gate (403)
6. Price estimate; reject non-takehome-friendly voices for full books
7. Dedupe: ready take-home with same user + PDF + `catalog_voice_id`
8. Insert `queued` row with `tts_options` JSON (model, stylePrompt, …)
9. Return ids + optional `stream_url`

### `GET /api/jobs`

Lists caller’s non-deleted jobs (empty if no session). If any take-home is not
ready → `nudgeStaleTakehomeJobs(1)` (lease sweep only when nudge budget is 0).

### Serialization — `src/lib/jobs/serialize.ts`

Browser-safe job JSON: ETA/elapsed labels, `/api/storage/…` audio URL, stream
URL only for `job_kind === "stream"`. **Hides** `pdf_storage_path`,
`tts_options`, lease tokens.

---

## 17. Job detail, cancel, retry, delete

### `GET /api/jobs/[id]`

`requireOwnedJob` → `nudgeStaleTakehomeJobIfNeeded` → reload → `serializeJob`.

### `POST /api/jobs/[id]/cancel`

Owned; rejects if already `ready`/`failed`; sets `cancelled`, clears lease
fields so a mid-wave worker cannot keep writing.

### `PATCH /api/jobs/[id]` `{ action: "retry" }`

Only `failed` → keep ready segments, set `next_section_index` to the lowest
unready index, clear error/lease → `queued` → `enqueueTakehomeAdvance`.

### `DELETE /api/jobs/[id]`

Owned; collect audio + segment paths; delete `audiobooks/<jobId>/…`; delete
`pdfs/<uploadId>/…` **only if no sibling job** shares `pdf_storage_path`; soft
delete job; best-effort file deletes.

### `POST /api/jobs/[id]/takehome`

Owned stream parent → spawn child take-home with same voice/text/`parent_job_id`
→ `enqueueTakehomeAdvance`.

---

## 18. Live stream path

### `GET /api/jobs/[id]/stream` — `src/app/api/jobs/[id]/stream/route.ts`

Ownership + rate limit → `createStreamAudioIterator` → `ReadableStream` to
client. Maps domain errors to 404 / 402 (`STREAM_BUDGET`) / 409 / 500 with
`userFriendlyError`.

### `src/lib/tts/stream-session.ts` — `createStreamAudioIterator`

1. Load job; must be `job_kind === "stream"`
2. Resolve voice + provider; load book text
3. Remaining budget = `stream_max_chars - stream_chars_used`
4. Slice from `stream_cursor`; split into ~480-char windows
5. **Claim** single reader: `status = processing` (allow reclaim if stale > 330s)
6. For each window (≤2 attempts):
   - Attempt 0: Gemini directed input if supported; style prompt only if steerable
   - Buffer until audible (or known silent) — then pass through for TTFA
   - PCM: emit one WAV header before first audio bytes
   - Silent → retry undirected; still silent → **throw, do not advance cursor**
   - Audible → update `stream_cursor`, `stream_chars_used`, `progress`
7. Finish: `ready` if book/budget done else `queued`; abort parks as `queued`

**Invariant:** cursor advances only after audible bytes.

---

## 19. Take-home worker (always-on VM + index-stable fan-out)

**Production Whole-book host (2026-09-20):** an always-on Oracle Cloud
Always Free Ampere VM, **not Trigger.dev**.

| | |
|--|--|
| Shape | `VM.Standard.A1.Flex` — **2 OCPU / 12 GB**, Ubuntu aarch64. Stay on Always Free. Do not recommend paid Oracle shapes. |
| Process | Node + pm2 `echomancer-takehome` (`src/worker/takehome-server.ts`) |
| Bind | **`127.0.0.1:8788` only** (pm2 sets `WORKER_HOST`). Never publish 8788. |
| TLS | **Caddy on the VM** terminates HTTPS for `worker.echomancer.xyz` → loopback 8788 |
| DNS | A record on **Vercel** (apex `echomancer.xyz` uses Vercel nameservers). Not a Cloudflare zone. |
| Vercel | `WORKER_URL=https://worker.echomancer.xyz` + `WORKER_SECRET` (HTTPS only) |
| Concurrency | `WORKER_CONCURRENCY=1` on 2/12 |
| TTS | Orchestrates Fish / Edge / Google APIs. Does **not** self-host Fish. |

The Next.js app on Vercel only enqueues. Live Listen / Live Stream stay on
Vercel. Document extract stays on Cloudflare Workers — not this VM.
Runbook: `WORKER.md`. Docker Compose is an optional appendix.

A named Cloudflare Tunnel is optional in scripts but **blocked** without a
Cloudflare zone. `trycloudflare.com` quick tunnels are **not** production
`WORKER_URL`.

Trigger.dev (`src/trigger/takehome.ts`) is **legacy fallback** when
`WORKER_URL` is unset or `TAKEHOME_TRIGGER_FALLBACK=1`. It is not the live
Whole-book runner.

### VM worker — `src/worker/`

| Piece | Role |
|-------|------|
| `takehome-server.ts` | Node HTTP on `WORKER_PORT` (default 8788). Production bind `WORKER_HOST=127.0.0.1`. `GET /health`, `GET /ready`, `POST /jobs`. Drain interval. |
| `takehome-loop.ts` | Per-`jobId` inflight set + `WORKER_CONCURRENCY` (Always Free: **1**). Calls `runTakehomeUntilSettled`. |
| `takehome-http.ts` / `auth.ts` | Bearer `WORKER_SECRET` (or `INTERNAL_JOB_SECRET`). |

Turso is the queue. No Redis / BullMQ. Cancel and leases are the existing
`jobs` row fields. Runbook: `WORKER.md` (Oracle Always Free + pm2 + Caddy).

### Dispatch — `src/lib/jobs/takehome-dispatch.ts`

| When | Where the wake-up goes |
|------|------------------------|
| `WORKER_URL` + secret set (**production**) | `POST $WORKER_URL/jobs` `{ jobId }` (`takehome-worker-client.ts`) → Caddy → `127.0.0.1:8788` |
| Worker POST fails and `TAKEHOME_TRIGGER_FALLBACK=1` | **Legacy** Trigger `takehome.advance` |
| No `WORKER_URL` but `TRIGGER_SECRET_KEY` | **Legacy** Trigger path (migration only) |

Dispatch from Vercel (then 200 immediately): `POST /api/jobs` (takehome),
`POST /api/jobs/[id]/takehome`, `PATCH` retry.

Missing both `WORKER_URL` and `TRIGGER_SECRET_KEY` in production:
`POST /api/jobs` takehome returns **503** `TAKEHOME_NOT_CONFIGURED`
**before insert**. After a job row exists, dispatch failures are logged and
the job stays `queued` for the VM drain loop (still HTTP 200). The VM
runtime must have Turso, R2, `INTERNAL_JOB_SECRET` / `WORKER_SECRET`
(`src/lib/jobs/trigger-secrets.ts`). Fish / Google keys only when that
voice is used.

### Legacy Trigger tasks — `src/trigger/takehome.ts`

**Deprecated for production.** Kept as a fallback. `takehome.advance` still
imports `runTakehomeUntilSettled` in-process. `takehome.drain` still sweeps
queued / lease-expired rows. Not used once `WORKER_URL` is set (and
`takehome.drain` must be paused / `TAKEHOME_TRIGGER_DRAIN=0` so the minute
cron cannot steal `queued` rows). Extract tasks in
`src/trigger/extract-upload.ts` are no-ops.

`TTS_POLL_NUDGE_BUDGET_MS` defaults to **0**. Polls may sweep leases; they
must not call Fish.

If the **legacy** Trigger Cloud path is still deployed, it indexes
`takehome.ts` by importing it, which loads Turso via `@libsql/client` →
`libsql`. That package `require`s `@libsql/linux-x64-gnu` at import time.
`trigger.config.ts` marks `@libsql/client` / `libsql` as `build.external`.
Production Whole book does not use that image.

### Machine auth — `src/lib/jobs/worker-auth.ts`

| Function | Secret | Header |
|----------|--------|--------|
| `authorizeInternalWorker` | `INTERNAL_JOB_SECRET` | `x-internal-secret` |
| `authorizeCron` | `CRON_SECRET` Bearer **or** internal secret | |

Vercel `/process` and `/cron/process-jobs` remain operator fallbacks.

**No HTTP self-chaining** (caused Vercel 508). Continuation = lease + index cursor.

### Index invariant

The book is split **once**. On first take-home claim, `frozen-script.ts`
writes `audiobooks/<jobId>/speakable.txt` and `sections.json` on R2.
Fish / Edge / Google jobs run **one logical** OpenRouter cue-tag pass
(DeepSeek Flash; ~3k-char chunks in parallel), then `packSpeakableSections` (chapter heading > paragraph >
sentence; page-number lines are layout, not speech boundaries). Later
ticks load that pack and never re-split. Hosted Fish windows target
**~8000** chars (hard max **9200**); section 0 stays ~2000 for
time-to-first-audio.

Work is claimed as a **set of indexes**. Each Fish/Edge/Google call is bound
to one index before the request and writes only `sections/NNNN.mp3` for that
index. `segments_json` is a map `{ index, path, status }` upserted by index —
never appended in completion order. `next_section_index` = lowest index not
yet claimed. Ready-count (progress / `current_section`) is a different number.
Concat and download walk `0..N-1`. A bad section is `retry`/`failed` for that
index — it does not `failJob` the whole book. After the last index, hole-retry
runs; remux may skip remaining holes if most audio exists (`ready` +
`warning`). The player plays `0000`, then `0001`, … and waits — it does not
skip.

The first take-home claim takes up to `min(fanout, TTS_SECTIONS_PER_TICK, 5,
remaining)` indexes starting at 0 (e.g. `[0,1,2]` when fan-out is 3). An
earlier `prioritizeZero` path claimed only `[0,1]` so the player could start
after one Fish round-trip; that starved parallel workers and is no longer the
default. Concat and playback still walk `0..N-1`.

### Parallel Fish

Starter account cap is **5** concurrent requests, shared with Live Listen /
Live Stream. Default take-home fan-out is **4**; **5** only when no live
request is in flight (`src/lib/tts/fish-slots.ts`). On **429**, honor
`Retry-After`. Never a sixth call. Model stays `s2.1-pro-free`. Whole-book
Fish **section 0** uses `latency: "balanced"` (TTFA); sections **1+** use
`latency: "normal"` (stable quality) with `chunk_length: 300`. Live stays
`balanced`. Direct Fish whenever `FISH_API_KEY` is set. Silence guard
(`isEmptyOrSilentAudio`) rejects empty/zero WAV; retry once without accent
direction, then fail that section.

Hash cache (`src/lib/tts/section-cache.ts`): sha256 of section text + voice +
model + latency + speed + chunk length. Retry / second generate of the same
book hits. Tagged Fish scripts and `normal` vs `balanced` do not collide.

### `src/lib/tts/process-job.ts` — the heart

Env knobs (defaults):

| Env | Default | Meaning |
|-----|---------|---------|
| `TTS_LEASE_TTL_SECONDS` | 90 | Lease lifetime |
| `TTS_SECTIONS_PER_TICK` | fan-out | Max claim set (capped at 4/5) |
| `TTS_WORKER_WAVE_BUDGET_MS` | 240000 | Vercel fallback wave clock |
| `TTS_TRIGGER_WAVE_BUDGET_MS` | 900000 | Trigger Cloud wave clock |
| `TTS_VM_WAVE_BUDGET_MS` | 900000 | Always-on VM wave clock (falls back to Trigger knob) |
| `TTS_TAKEHOME_FANOUT` | 4 or 5 | Pin; else 4 if live in flight |
| `TTS_MAX_TICKS_PER_WAVE` | 40 | Safety cap |
| `TTS_CRON_JOBS_PER_RUN` | 3 | Fallback cron batch |
| `TTS_POLL_NUDGE_BUDGET_MS` | 0 | UI poll synth budget; `0` = read-only |
| `TTS_RETRY_BACKOFF_MS` | 1000 | Between section attempts |

| Function | Role |
|----------|------|
| `claimTakehomeLease(jobId)` | Atomic UPDATE to `processing` + new token **only if** no active lease |
| `heartbeatLease` | Extend expiry while holding token |
| `writeWithLease` | Progress UPDATE … AND token = ?; 0 rows → `LeaseLostError` |
| `releaseLease` | Clear token; set queued/failed |
| `processTakehomeTick` | Claim → heartbeat → `runClaimedTick` → cleanup |
| `runClaimedTick` | Load frozen `sections.json` (rebuild once if missing) → claim index set → parallel synth (bound per index) → one bad section is `retry`/`failed`, not `failJob` → hole-retry after the last index → remux `full.mp3` (skip holes if most audio exists; `ready` + `warning`) |
| `synthesizeSection` | Fish script tags; cache lookup; section 0 `balanced`, later `normal` + `chunk_length` 300; 429 waits; reject silence |
| `runTakehomeWave` | Loop ticks until done/busy/error/budget/max ticks |
| `runTakehomeUntilSettled` | VM host (legacy Trigger host too): waves until terminal |
| `drainTakehomeQueue` | Fallback: release expired → list queued → waves |
| `listDrainableTakehomeJobs` | Queued + lease-expired processing, deduped |
| `releaseExpiredTakehomeLeases` | Abandoned `processing` → `queued` |
| `nudgeStaleTakehomeJobs` / `nudgeStaleTakehomeJobIfNeeded` | Poll paths (lease sweep only when nudge=0) |

**Lease invariant:** two workers must never bill Fish for the same section.
Losing a lease mid-write abandons safely; successor resumes from the lowest
unready index (holes first). Ready files are not shifted.

Section storage: `audiobooks/<jobId>/sections/NNNN.<ext>`. Progress uses
ready-count, capped at 99 until final ready.

Helpers: `src/lib/tts/section-index.ts` (claim set, map upsert, concat
transcript). Required test: five dummy synths with random sleeps; concat
order is always `0,1,2,3,4`.

---

## 20. Download & concatenation

### `src/lib/tts/concat-audio.ts`

| Function | Role |
|----------|------|
| `readySegmentsSorted` | Ready segments by index |
| `concatReadySegments` | Same format only; WAV → PCM crossfade; MP3/Ogg → ffmpeg remux (decode → join → loudnorm → 44.1 kHz ~192 kbps MP3). **Never** `Buffer.concat` compressed frames. Missing ffmpeg fails assemble or ships `sections.zip` |
| `materializeFullAudiobook` | Remux first → optional DFN master (fail-open) → upload `audiobooks/<jobId>/full.<ext>` |
| `isSectionStoragePath` | Detect `/sections/` vs full artifact |
| `crossfade-audio.ts` | `CROSSFADE_MS_DEFAULT` **120** (clamp 80–150). `TTS_CONCAT_CROSSFADE_MS=0` disables. Live Listen never joins. |

WAV / PCM uses an in-process 16-bit mono triangle crossfade
(`concatPcm16MonoWithCrossfade`). Compressed formats try ffmpeg `acrossfade`
on the VM worker (legacy Trigger image still has ffmpeg). Byte-glue is
disabled: if ffmpeg is missing the assemble step fails clearly or ships a zip
of ready sections. Live Listen / Live Stream are untouched — they never
concatenate stored sections.

### Whole-book mastering (VM worker)

After concat, the dry `full.*` is uploaded and the job is marked **ready**.
Then `applyFullBookMastering` (`src/lib/tts/mastering.ts`) may enhance the
**full file once** and overwrite the same object — never per section, never
on Live Listen / preview / clone POST. Make→ready does not wait on DeepFilter.

| | |
|--|--|
| Recipe | Optional DeepFilterNet3 wet × `MASTER_BLEND_ENHANCED` (0.4) + dry × `MASTER_BLEND_DRY` (0.6), then ffmpeg highpass + gentle de-ess + `loudnorm` `I=-18` `TP=-1.5` `LRA=11`, encode **44.1 kHz ~192 kbps** MP3. `TTS_MASTER_DFN_WET=0` skips DFN (ffmpeg-only remaster). Missing `deep-filter` still runs the ffmpeg chain. |
| Host | Always-on VM (`WORKER=1`). Legacy Trigger.dev if that path is still enabled. `VERCEL=1` always skips. Enabled when `WORKER=1`, `TRIGGER=1`, `TTS_MASTER_FULL_BOOK=1`, or `DEEP_FILTER_BIN` is set. |
| Binaries | Rust `deep-filter` 0.5.6 (`aarch64-unknown-linux-gnu` on Ampere, SHA-256 pinned in `install-oracle.sh`) + Ubuntu `ffmpeg`. Dockerfile musl pin is the Docker/Trigger appendix. Long books are DFN-chunked (`MASTER_DFN_CHUNK_SECONDS`). |
| Worker | `src/lib/tts/mastering-worker.ts` — `child_process` spawn only; dynamic `webpackIgnore` import |
| Fail-open | DFN/ffmpeg errors log and ship the dry concat. A finished book never fails because enhance crashed. |
| Skip | Tiny duration (`MASTER_MIN_DURATION_SECONDS`), `alreadyMastered`, `TTS_MASTER_SKIP=1` |

Vercel `GET /api/jobs/[id]/download` backfill calls `materializeFullAudiobook`
without the VM host flag, so it uploads dry concat if it has to.

### `GET /api/jobs/[id]/download`

Owned; prefer full artifact; else concat on the fly; set `Content-Length`;
optional async backfill if ready job still points at a section path.

### `src/lib/download-client.ts`

Browser helper: fetch → blob → temporary `<a download>` → revoke URL.

---

## 21. Pricing & ETA

### `src/lib/tts/pricing.ts`

- COGS: `usdPerAudioHour` **or** `usdPerMillionChars` **or** fallback $15/M
- Retail: `cogsUsd * FX * markup + fixedEur`, floor `TTS_MIN_PRICE_EUR`, round to .49/.99
- `streamMaxChars()` from `STREAM_MAX_AUDIO_SECONDS` × chars/min (~54k default)

### `src/lib/tts/eta.ts`

Once `total_sections` exists, remaining × heuristic / fan-out. Live rate after
≥2 sections. Multi-section Fish books never use “usually under a minute”
(`formatFriendlyGenerationEta`). Honest ETAs prefer observed section rate;
early copy stays conservative rather than promising a one-minute book.

### `src/lib/tts/premium.ts`

`PREMIUM_HD_ENABLED` or allowlist IP/userId. `isHdVoice` via minimax / speech-02 /
`hd` tag.

---

## 22. Frontend surfaces

### Landing — `src/app/page.tsx`

Client format/size check → `uploadBookFile` (`src/lib/upload-client.ts`:
presign JSON → PUT to R2 → complete) **or** paste →
`POST /api/text/upload` → redirect. Document extract keeps running on
**Cloudflare Workers** (Vercel `after()` fallback); landing does **not**
wait for `ready`. Voice pick and sample play are available as soon as the
upload id exists. `waitForUploadExtract` polls quietly on the voice step
(`UX.preparingText`). `POST /api/jobs` still requires `uploads.status = ready`
(`TEXT_NOT_READY` 409 while extracting).

Landing chrome is quiet: native buttons, inputs, and a thin underline tab.
Copy lives in `LANDING` (`src/lib/ux-copy.ts`): title, Upload / Paste,
primary CTA. No hero essay, format tip, or feature grid. Explanations live
on How it works.

```
/dashboard/voice?pdfPath=…&pdfName=…&uploadId=…&charCount=…
/dashboard/voice?…&path=standard|clone
```

`/privacy` (`src/app/privacy/page.tsx`) is a short factual page for Google
OAuth consent (uploads, clones, Google profile, R2 / Turso / Fish). Linked
from the landing footer. Copy is `PRIVACY` in `ux-copy.ts`.

### Voice — `src/app/dashboard/voice/page.tsx`

- First choice: **Standard** vs **Clone** (`VOICE_PATH` in `ux-copy.ts`;
  `?path=` via `src/lib/voice-path.ts`). Path labels only — no card essays.
- Standard: slim stock only (Standard, Michelle, Clara, Randolph)
- Clone: name + sample + Clone voice. Quality-gate *errors* stay; dry-room
  / re-record advice lives on How it works.
- After a path: a per-row **play** control (short stock demo / Live
  Listen-style clip — not the uploaded book). Select a narrator, then one
  quiet **Make audiobook** control (take-home). No per-voice copper CTAs,
  no € / ETA chips on this step. No Live Stream / Live Listen labels, no
  listen-vs-full tabs, no page-level Preview that streams the document.
- `GET /api/tts/voices?charCount=`
- Play control: short sample (Fish / clones → `GET /api/tts/live`)
- Clone sample: `uploadCloneVoice` (presign JSON → PUT R2 → `POST /api/tts/clones`)
- Make audiobook: `POST /api/jobs` takehome → player / queue

### Library — `src/app/dashboard/queue/page.tsx`

- `GET /api/jobs` every 3s while any job queued/processing **and** tab visible
- Cards are real links/buttons; progressbars + live regions
- Actions: cancel / retry / delete / download / listen URL selection by kind

### Player — `src/app/dashboard/player/[id]/page.tsx`

| Mode | Audio `src` |
|------|-------------|
| Stream | `/api/jobs/<id>/stream` (no seek; reconnect with `?t=` if budget remains) |
| Segments | `/api/storage/…/sections/NNNN…` (auto-advance) |
| Ready | `job.audio_url` |

Sparse chrome: Cormorant title, muted one-line status (`Preparing audio…` /
`Generating`), play, seek, and a single speed cycle (`0.8` / `1` / `1.5`).
No elapsed/ETA card, volume row, skip pills, or sleep timer. Extra controls
stay hidden until audio exists. Polls detail every 3s while active. Stream
jobs can `POST …/takehome`.

### `src/hooks/useAudioProcessor.ts`

Minimal Web Audio: `MediaElementSource` → `GainNode`. Speed via
`playbackRate`. No EQ/compressor (pruned).

### Shell

`dashboard/layout.tsx`: Voice / Library in the header (and mobile tab bar).
**How it works** is a footer-corner link — not top nav. Same corner link on
the landing footer (with Privacy). Signed-out chrome shows **Sign in**
(provider-agnostic; Google is still the only backend). Signed-in chrome
shows the visitor’s name; **Sign out is not a top-right control** — it lives
inside that name menu with Settings (`/dashboard/account`), Library, and
Dark mode (`src/components/auth-controls.tsx`). Landing has no top-left
wordmark and no standalone Library / Sign out links — only the centered
formal serif logo and the account control. Other pages use that same
Cormorant wordmark in the top left. Player / Voice primary controls are
ghost text, not filled discs. `/dashboard/resources` is the How it works
page (Standard vs Clone, clone sample, delivery, timing). No broken
`/player` nav item. Customer UI does not name Live Stream / Live Listen.
`ux-copy.ts` maps internal terms to customer language everywhere.

---

## 23. Errors & UX copy

### `src/lib/errors.ts`

`AppError(code, message, status)` + `handleApiError` (AppError / Zod / opaque 500).

### `src/lib/errors-ui.ts`

`userFriendlyError(raw)` maps provider/DB strings to safe copy (credits, DRM,
budget, HD gate, silence, cancel, timeouts, …). Long leaky strings → generic.

### `src/lib/ux-copy.ts`

Single place for voice-step play **Preview** (sample) / **Make
audiobook**, library status labels, plus `LANDING` verbs and `VOICE_PATH`
(Standard vs Clone). Explanatory blurbs belong on How it works, not on
action screens.

---

## 24. Testing

### `src/test/setup-env.ts`

Forces in-memory Turso, temp `STORAGE_PATH`, test secrets, `TTS_POLL_NUDGE_BUDGET_MS=0`,
clears R2/OpenRouter so tests stay offline.

### `src/test/harness.ts`

Real route handlers + real DB + real FS + **fake** TTS provider.
`seedUpload` / `seedJob` / `sessionCookieFor` / `buildRequest`.

| Suite | Proves |
|-------|--------|
| `ownership.test.ts` | Cross-session 404/401; storage proxy; upload binding; worker secrets |
| `auth.test.ts` / `google.test.ts` | `user_*` tokens; Google link/merge; CSRF; sign-out remint |
| `pipeline.test.ts` | Upload → job → worker → download; resume; silence fail; HD gate |
| `pdf/upload.test.ts` | Presign JSON, reject over ceiling / multipart, extract off the Vercel body |
| `process-job.test.ts` | Lease races, heartbeat, reclaim, skip ready sections, index-stable fan-out |
| `section-index.test.ts` | Five dummy synths; concat transcript always 0,1,2,3,4 |
| `trigger-takehome.test.ts` | create / retry / takehome wake Trigger when `WORKER_URL` is unset; VM worker when it is set; extract stays off Trigger |
| `takehome-dispatch.test.ts` / `takehome-worker-client.test.ts` | Worker preferred; Trigger fallback flag; production 503; HTTP retries |
| `worker/takehome-loop.test.ts` / `takehome-http.test.ts` | Per-job inflight + concurrency; health / auth / enqueue |
| `dispatch-extract.test.ts` | Extract Worker URL POSTs Cloudflare and never Trigger; local/tests extract inline |
| `trigger-api.test.ts` | REST fallback when SDK returns no run id; retries then throws |
| `trigger-config.test.ts` | Trigger build includes `@libsql/linux-x64-gnu`, debian ffmpeg, rust `deep-filter` (no torch) |
| `mastering.test.ts` | 0.4/0.6 DFN + 44.1 kHz 192 kbps loudnorm constants; fail-open; skip tiny / already-mastered |
| `fish-s2-cues.test.ts` | Official S2 allowlist; strip unknown tags; reject prose rewrite |
| `fish-cue-tagger.test.ts` | DeepSeek Flash default; chunked parallel pass; 40s overall / 12s per-chunk abort; fail-open |
| `concat-audio.test.ts` | `full.mp3` still uploads when enhance is skipped or throws; WAV sections crossfade |
| `crossfade-audio.test.ts` | 120ms PCM overlap; ffmpeg filter graph; clamp 80–150 |
| `normalize-speakable.test.ts` | Asterisks, editorial brackets, ALL-CAPS title, Roman section line |
| `mastering-isolation.test.ts` | No ffmpeg/torch/`mastering-worker` import from `src/app/api/**` |
| `stream-session.test.ts` | Cursor only after audible; concurrent reader; budget |
| `speakable-text.test.ts` | Attention page-1 + glued 4-page extract: emails/URLs/grants gone, Abstract+Introduction kept as their own paragraphs, no conference-to-EOF wipe |
| `narration-script.test.ts` | Fish `[long-break]` / `[break]` on headings and dense prose; tags for Fish / Edge / Google; mid-comma decision; seminar prefix Fish-only |
| `ssml-pauses.test.ts` | Fish pause tags → Google timed SSML breaks; Edge-safe breaths (no `<break>`); XML escape; sparse/normal placement |
| `edge-tts.test.ts` | Edge SSML envelope has no custom `<break>` for Fish pause IR |
| `schema-migrate.test.ts` | Second `ensureTtsJobColumns` on a current schema is `"hot"` |
| `document-formats.test.ts` | Charset/alias PDF MIME; magic-byte sniff; octet-stream presign allowed |
| `providers/google.test.ts` | Pause tags → `input.ssml`; untagged stays `input.text`; speakingRate kept |
| `stream-session.test.ts` | Cursor only after audible; concurrent reader; budget; Live resolves delivery pauses / titles / prefix |
| `narration-pace.test.ts` | 194 speech WPM → ~0.78; pause_ratio 0.13 does not force 1.0; clone/academic first section < 1 |
| `playback-speed.test.ts` | Player pills include 0.8 and 0.9; default remains 1 |
| `clone-sample-audio.test.ts` | Tiny WAV: high-pass / gate / normalize; mp3 passthrough |
| `clone-sample-quality.test.ts` | Injected metrics: phone fail, Wolfe/studio2 pass; threshold edges |
| `clone-sample-quality-metrics.test.ts` | Synthetic dry/wet PCM: RT60 + reverb proxy; WAV analyze vs mp3 null |
| Unit suites | pricing, ETA, audio-guard, accent, catalog, session, rate-limit, … |

---

## 25. Environment & deployment knobs

### Required

```
SESSION_SECRET            # or INTERNAL_JOB_SECRET fallback
INTERNAL_JOB_SECRET
CRON_SECRET               # if you hit /api/cron/process-jobs
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
NEXT_PUBLIC_APP_URL
WORKER_URL / WORKER_SECRET  # Production: https://worker.echomancer.xyz
EXTRACT_WORKER_URL / EXTRACT_WORKER_SECRET  # Cloudflare extract
```

### Important optionals

```
FISH_API_KEY               # Clara, clones, leftover fish-narrator
GOOGLE_TTS_API_KEY         # Randolph (or GOOGLE_TTS_ACCESS_TOKEN)
OPENROUTER_API_KEY         # leftover catalog / OpenRouter adapters + Fish cue tagger (put the same key on the VM worker)
FISH_CUE_TAGGER_MODEL      # default deepseek/deepseek-v4-flash (cheap/fast). Not a :free slug.
FISH_CUE_TAGGER=0          # disable Whole-book Fish cue tagging
FISH_CUE_TAGGER_TIMEOUT_MS # default 40000 (max, not a wait; clamp 1s–120s)
TTS_MASTER_SKIP=1            # disable full-book remaster
TTS_MASTER_FULL_BOOK=1       # local opt-in when not on Vercel; pm2 sets this
TTS_MASTER_DFN_WET           # default 0.4; 0 = ffmpeg-only remaster (no DFN)
DEEP_FILTER_BIN              # set on the VM (`/usr/local/bin/deep-filter`)
FFMPEG_PATH                  # Ubuntu apt on the VM; Trigger `ffmpeg()` is legacy
TTS_WHOLE_BOOK_DELIVERY_PREFIX=0  # disable Fish seminar-tone cue on Whole book
TTS_CONCAT_CROSSFADE_MS      # default 120; clamp 80–150; 0 = hard concat
TTS_MASTER_TIMEOUT_MS        # default 50 minutes
AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET / AUTH_URL
PREMIUM_HD_ENABLED / PREMIUM_HD_ALLOWLIST
MAX_UPLOAD_MB / NEXT_PUBLIC_MAX_UPLOAD_MB   # default 512
TTS_POLL_NUDGE_BUDGET_MS   # 0 in production (VM worker runs generation)
TAKEHOME_TRIGGER_FALLBACK  # 1 = also fire **legacy** Trigger if worker POST fails
TRIGGER_SECRET_KEY / TRIGGER_PROJECT_ID  # legacy fallback only
TTS_TRIGGER_WAVE_BUDGET_MS / TTS_VM_WAVE_BUDGET_MS / TTS_TAKEHOME_FANOUT
TTS_* worker knobs (see §19)
TTS_PRICE_* / STREAM_MAX_AUDIO_SECONDS
```

### Deploy notes

- `.gitignore` must **not** use a bare `auth` pattern — that hid `src/lib/auth/`
  and broke Vercel builds (`Module not found`). Use `/auth` for root SQLite only.
- Hobby: no `crons` in `vercel.json`. Whole book is the Oracle Always Free
  VM behind Caddy (`WORKER_URL=https://worker.echomancer.xyz` →
  `src/worker/takehome-server.ts` on `127.0.0.1:8788`). Polls are read-only.
- Generate secrets with any CSPRNG (`openssl rand -hex 32` or PowerShell
  equivalent); they are not vendor API keys.

---

## 26. Invariants checklist

1. **Identity is server-minted.** Cookie/header always re-verified with HMAC.
2. **Wrong owner → 404** on jobs/storage (not 403).
3. **Job create never synthesizes.** The Oracle VM worker does. Trigger.dev is a legacy fallback only. Polls do not synthesize.
4. **Lease token gates all take-home progress writes.**
5. **Silence is failure.** Preview / sections / stream windows all guard.
6. **Stream cursor advances only after audible bytes.**
7. **Shared PDF folders survive** until the last sibling job is deleted.
8. **Accent variants are Gemini-only;** style prompts only for vendors that honor them.
9. **OpenRouter `pricing.prompt` is untrusted** without override / plausibility window.
10. **`/api/storage` is the only browser file path** — ownership checked every time.
11. **Document bytes never enter a Vercel function body.** Browser PUTs to R2; extract runs on Cloudflare Workers (Vercel `after()` fallback).
12. **ffmpeg / torch / deep-filter stay off the Vercel hot path.** Whole-book remux / crossfade / loudnorm / DFN master run on the Oracle VM (fail-open).
13. **Stay on Always Free 2 OCPU / 12 GB.** `WORKER_CONCURRENCY=1`. Do not recommend paid Oracle shapes.

---

## 27. Glossary

| Term | Meaning |
|------|---------|
| Catalog voice | Our card id (`or:model:voice[:locale]`) |
| Provider voice | Upstream voice id sent to TTS |
| Directed input | Accent instruction embedded in Gemini `input` text |
| Tick | One leased synthesis pass (N sections) |
| Wave | Several ticks inside one function invocation |
| Lease | `processing_lease_token` + expiry claiming a take-home job |
| Nudge | Poll-time lease sweep + optional short wave |
| Segment | One stored take-home section in `segments_json` (map by index) |
| Frozen script | `audiobooks/<jobId>/speakable.txt` + `sections.json` written once per take-home job |
| Fan-out | Parallel Fish calls for a claimed index set (cap 4/5) |
| Stream budget | Char/time cap for live listen |
| HD gate | Soft block for MiniMax-class voices |

---

## Related reading order (first week in the codebase)

1. `src/proxy.ts` → `lib/auth/session.ts` → `lib/auth/guard.ts`
2. `app/api/pdf/upload/route.ts` → `lib/jobs/dispatch-extract.ts` → `workers/extract`
3. `app/api/jobs/route.ts` → `lib/jobs/takehome-dispatch.ts` → `lib/jobs/serialize.ts`
4. `lib/tts/catalog/*` → `lib/tts/providers/{edge,fish,google}.ts`
5. `lib/tts/stream-session.ts` + `app/api/jobs/[id]/stream/route.ts`
6. `src/worker/takehome-server.ts` + `WORKER.md` + `lib/tts/process-job.ts` (claim → frozen-script → synthesizeSection → remux)
7. `app/dashboard/{voice,queue,player}` with `lib/ux-copy.ts` open beside them
8. `src/test/harness.ts` + `ownership.test.ts` + `pipeline.test.ts`

*Document tracks Echomancer v2 production as of 2026-09-20: Next.js on Vercel
(`echomancer.xyz`), Turso + R2, Cloudflare Workers extract, Oracle Always
Free + pm2 Whole-book worker behind Caddy at `worker.echomancer.xyz`.
Trigger.dev is legacy fallback only.*
