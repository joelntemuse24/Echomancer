# Echomancer v2 — Technical Design (Code Walkthrough)

**Audience:** someone who will open the repo and follow along. This document is
organized as a **map of the code**, not a product brief. Every important module
is named; every major export is explained; end-to-end flows are traced through
concrete files and functions.

**Live app:** [echomancer.xyz](https://echomancer.xyz) (Vercel project
`echomancer-v2`). **Audited against `main` at
`a975b427156d56ead20d2666264f251fb8d3803b` (#248) on 2026-11-07.**

**Companion docs:** `AGENTS.md` (agent/ops cheat sheet), `WORKER.md`
(VPS + pm2 + Caddy), `DEPLOYMENT.md`, `TURSO_R2_SETUP.md`,
`README.md`, [`docs/s2-gpu-staging-runbook.md`](docs/s2-gpu-staging-runbook.md)
(GPU procedure, not a second design). Playback/clip recovery is in
[`docs/playback-clipping-reliability.md`](docs/playback-clipping-reliability.md).
Lane arithmetic is in [`docs/s2-lane-budget.md`](docs/s2-lane-budget.md).

## How to read claims

This file is the code walkthrough. It is not a release note, and a sentence
here is not a live-host probe. Read each claim as one of these:

| Class | What it means |
|-------|----------------|
| **Implemented** | What current source does. The path is named. |
| **Code default** | The value when the env var is unset. |
| **Deploy override** | A live setting that is not the code default. `/ready` and `status()` do not show a Modal autoscaler override. |
| **Measured** | A number from a named job, a fixture, or an offline calculation. Not a promise for the next book. |
| **Goal** | A product target the code does not enforce. About €4.50 for a typical take-home book is a goal. |
| **Not verified** | This repository does not prove it. Do not treat a blank runbook checklist as a completed proof. |

**Not verified by this audit, and not proven by the checks that already exist:**

- No authenticated end-to-end book was rendered for this documentation change.
  None is recorded in the repo after the allowance removal (#248). The offline
  acceptance test (`src/test/acceptance/book-path.acceptance.test.ts`) drives
  orchestration with a fake provider. The operator reported 137 targeted
  offline tests passing on the #248 roll; this change did not re-run them.
- A direct endpoint smoke is not the book path and is not a listening check.
  #246's smoke was that kind of check.
- `modal run …::cover` calls that land on an already-warm container id do not
  prove that every GPU type has a snapshot of this recipe. The runbook's own
  rule is 2–3 snapshots per GPU type, judged by wall-clock restore
  (`placement_kind`), not by `boot=restored`. Compilation stays off the book
  path (`MODAL_S2_COLD_WAIT_MS`, hard ceiling 180 s). There are no always-on
  GPUs: `min_containers` is 0.
- Job `75944dc9` was not regenerated. Its stored audio and the existing
  section cache were left in place. The code changes stop a *new* book from
  being assembled that way. They do not repair that file.
- This audit did not call Modal, Vercel, or the VM, and it did not read
  production secrets.

**Operator-reported deploy state (2026-11-07, Dublin), cross-checked only
where the repo can check it:**

- #248 is reported deployed and healthy on the Contabo take-home VM and on
  Vercel production (`READY`). The worker code does not name a cloud vendor
  (`src/worker/takehome-server.ts`). "Contabo" is that report, not a string
  the process checks.
- Modal app name in source is `echomancer-s2-clone`
  (`modal/s2_clone_service.py`, overridable with `S2C_APP_NAME`). Code default
  `S2C_VERSION` is `"9"`. The fingerprint of the current source defaults
  (`snapshot_fingerprint` in `modal/s2_contract.py`: version 9, `H100!`, batch
  32, unit ceiling 560, merge 260, history anchor first, pauses 0.22/0.4/0.96,
  `S2_SPECTRAL_CHAIN`, sampling `0.9,0.9`) is `aa02126d8267`. That calculation
  used the source constants only. It is the same id operators reported for the
  image that has not been redeployed since #246. It is not a live `/ready`
  reading. A Modal deployment counter such as "v6" is not a constant in this
  repo.
- Reported runtime autoscaler: `min_containers=0`, `max_containers=4`,
  `scaledown_window=180`, applied with `update_autoscaler` after deploy. Code
  defaults are `S2C_MAX_CONTAINERS=1` and `S2C_SCALEDOWN=300`
  (`container_limits` in `modal/s2_contract.py`). A plain `modal deploy` resets
  the override, and `/ready` keeps reporting the deploy-time env. Re-apply
  after every deploy. See step 8 of the runbook.
- `MODAL_S2_READY_URL` and `MODAL_S2_SYNTHESIZE_URL` were reported set on
  Vercel. The repo does not store those hostnames. A ready URL is never
  derived from the batch URL.

There is no per-account or global character allowance on clone generation.
The old caps (500,000 per account per day, 2,000,000 global) are gone, not
raised. `MODAL_S2_USER_DAILY_CHARS` and `MODAL_S2_GLOBAL_DAILY_CHARS` are
inert. Usage is still written to `usage_logs` (`action: "modal_s2_clone"`)
and a failed insert does not stop the book
(`recordModalCloneUsage` in `src/lib/tts/providers/modal-clone-guard.ts`).
A real provider auth, quota, or billing error is still an error and keeps
the provider's message.

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

Echomancer turns an uploaded document into listen-able audio. The slim catalog
(`SLIM_STOCK_VOICE_IDS` in `src/lib/tts/standard-voice.ts`) is five voices:
**Andrew** (Edge `en-US-AndrewNeural`, catalog id `standard`), **Echomancer
Andrew** (`echomancer-andrew`, self-hosted Paradee, `src/lib/tts/providers/paradee.ts`),
**Ava** (Edge `en-US-AvaNeural`, not Dragon HD), **Libby** (Edge
`en-GB-LibbyNeural`), and **Ryan** (Edge `en-GB-RyanNeural`). Clara and Michelle
stay resolvable for books already made with them and are not listed. A new
request that names Clara uses Libby. Randolph is not synthesized. A stored
Randolph book still plays and downloads; a new request that names Randolph or
Google uses Andrew. Optional **Fish voice cloning** trains on the direct Fish
API (`FISH_API_KEY`). Clone synthesis uses the self-hosted S2-Pro container
when `MODAL_S2_TTS_URL` is set (`modal/s2_clone_service.py`) and otherwise
direct Fish — the same voice, because Fish trained the reference. Drama 3 is
gone: it re-cloned the raw sample through a hosted model, so its take was a
neighbour of the customer's voice. `CLONE_TTS_PROVIDER=fish` skips the
container. With no URL, clones never call Modal. There is no customer control
for clone emotion, for Fish generation speed (`prosody.speed` is chosen in
`src/lib/tts/narration-pace.ts`), or for narration pauses, joins, and titles.
`src/app/dashboard/narration-delivery-controls.tsx` only reads a leftover
`localStorage` pref; no screen renders those controls. The Seminar / Plain
toggle is gone. The player does have a listen-time `playbackRate` (0.8–1.5,
default 1.15×, `src/components/player-speed-control.tsx`). That control does
not re-synthesize.

A take-home book pins its engine once (`jobs.provider_pin`) and keeps it for the
whole book; a cold GPU pool parks the book (`MODAL_S2_DEFER_MS`, default 25 min)
instead of switching narrator, and only a spent budget switches it, with a
warning on the job. A book stored under the old `drama3` pin is re-pinned to
`modal` or `fish` on its next tick. The Whole-book
VM orchestrates those APIs; it does not run Fish on the VM itself.

Two customer paths:

| Customer language | `job_kind` | What the code does | Host |
|-------------------|------------|--------------------|------|
| Live Stream | `stream` | Pipe provider audio live; cap chars/time; store **no** audio | Vercel |
| Get the whole book | `takehome` | Freeze speakable sections → synthesize → R2 → remux / master | Always-on VPS worker |

`generation_mode` is always `"stock"` in v2. The Voice tab opens on the
slim pile (Andrew, Echomancer Andrew, Ava, Libby, Ryan). Clone is the other path.

Rough money: take-home price is dynamic from character count × voice rate
(`src/lib/tts/pricing.ts`). Product target ≈ **€4.50** for a typical novel —
a goal, not a hard ceiling.

### Production topology

Implemented hosts, plus the deploy report from the claim-class section above.

| Piece | Where it runs |
|-------|----------------|
| App | Next.js on Vercel (`echomancer.xyz` / project `echomancer-v2`). Live Listen and Live Stream stay here. |
| Database / objects | Turso + Cloudflare R2 |
| Document extract | Always-on VM, child process of `echomancer-takehome` (`POST /extract`). Cloudflare `workers/extract` only when that worker is unreachable or unhealthy. **Not Trigger.dev.** Voice pick stays unblocked while extract runs. |
| Whole-book orchestration | Always-on Ubuntu VPS. Node + pm2 process `echomancer-takehome`. Binds **`127.0.0.1:8788` only**. Code default `WORKER_CONCURRENCY=1`. Reported host on 2026-11-07: Contabo. The process does not check the vendor. |
| Clone synthesis | Modal app `echomancer-s2-clone` when `MODAL_S2_TTS_URL` is set. One GPU per container, `min_containers=0`. The VM does not run the GPU. Direct Fish is the other engine for the same reference. |
| Stock synthesis | Edge Read Aloud for Andrew, Ava, Libby, and Ryan. Paradee for Echomancer Andrew. Fish for a stored Clara book and for clones pinned to `fish`. Google Cloud TTS is not called. |
| TLS / `WORKER_URL` | **Caddy on the VM** terminates HTTPS for `worker.echomancer.xyz`. DNS A record lives on **Vercel** (apex `echomancer.xyz` uses Vercel nameservers). The domain is **not** a Cloudflare DNS zone. Vercel `WORKER_URL` + `WORKER_SECRET` call the worker over HTTPS. |
| Trigger.dev | **Legacy fallback** in the repo (`takehome.advance` / `takehome.drain`). **Not** the production Whole-book runner. Extract `upload.extract` / `upload.drain` are no-ops. The copy still deployed on Trigger is old and still claims `queued` rows every minute until that schedule is turned off in the Trigger dashboard. |

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
      player/[id]/page.tsx     # Playback + optional transcript
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
      tts/voices/              # Slim catalog + session clones
      tts/preview/             # Short stock preview
      tts/live/                # Fish chunked preview / listen
      tts/clones/              # Train a clone from a stored sample
      tts/clones/[id]/preview/ # Replay a stored clone MP3; POST renders once
      auth/[...nextauth]/      # Auth.js Google OAuth + CSRF
      auth/email/              # Email sign-in link (Resend)
      auth/logout/             # Sign out → fresh anon cookie
      text/upload/             # Paste or public URL, same content.txt shape
      clips/                   # Server YouTube clip queue (allowlisted email)
      me/                      # Signed-in profile for chrome
      log/                     # Client-side pick/upload failure reports
      health/
  lib/
    auth/{session,guard,google,authjs,identity,actions,sign-out}.ts
    rate-limit.ts
    jobs/{serialize,worker-auth,takehome-dispatch,takehome-worker-client,trigger-api,trigger-takehome,trigger-secrets}.ts
    turso.ts + turso/{jobs,uploads,cloned-voices,clone-uploads}.ts
    storage/index.ts + r2-storage.ts
    uploads/{extract,http,rate-limit}.ts
    text-extraction.ts + document-formats.ts + clone-sample-formats.ts + upload-client.ts
    file-pick.ts                # Pick-time read + sniff + visible errors (phones / Drive)
    tts/…                      # Entire synthesis stack
                               # speakable-text.ts (TTS script sanitizer)
                               # clone-sample-audio.ts (WAV PCM cleanup, no ffmpeg)
                               # clone-sample-quality.ts (pass/warn/fail gate, no SNR)
                               # mastering.ts + mastering-worker.ts (podcast delivery chain + 44.1/192; DFN opt-in)
    validation.ts, errors.ts, errors-ui.ts, ux-copy.ts
  worker/{takehome-server,takehome-loop,takehome-http,auth}.ts
  hooks/useAudioProcessor.ts
  test/{harness,setup-env}.ts
modal/                         # S2-Pro clone service, contract, warm/cover
scripts/oracle/                # VPS worker bootstrap (pm2 / Caddy / smoke)
scripts/s2/                    # Staging HTTP smoke (synthetic clip only)
workers/extract/               # Cloudflare Worker: document parse next to R2
workers/takehome/Dockerfile    # Optional Whole-book image (multi-arch DFN)
docker-compose.yml             # Optional Docker path (pm2 is primary)
WORKER.md                      # VPS + pm2 + Caddy runbook
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
  ├─► Extract: Node worker `POST /extract` (Cloudflare if that POST fails, then Vercel)
  └─► TTS: Edge / Paradee / Fish on the request path for live;
        Whole book on the VPS worker; clones on Modal or direct Fish
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

### Email sign-in (`src/lib/auth/email-login.ts`)

Passwordless links through Resend, next to Google. Enabled only when
`RESEND_API_KEY` and `AUTH_EMAIL_FROM` are set (`emailEnabled` on
`ViewerIdentity`); otherwise `POST /api/auth/email` is 503
`EMAIL_LOGIN_NOT_CONFIGURED` and the header keeps its Google-only behaviour.

| Piece | Role |
|-------|------|
| `POST /api/auth/email` | JSON `{ email, next? }`. Rate limited per address (3 / 10 min) and per IP (20 / h), both fail-closed. Never reveals whether an account exists. Resend failure is 502 `EMAIL_SEND_FAILED`. |
| `email_login_tokens` | `token_hash` (SHA-256 only), `email`, `expires_at` (15 min), `used_at`. Consumed by one `UPDATE … WHERE used_at IS NULL AND expires_at > now RETURNING`, so two confirms cannot both win. |
| Link origin | `AUTH_URL` / `NEXT_PUBLIC_APP_URL`, never the request `Host` in production (a spoofed host would mail the token to another site). |
| `/sign-in/confirm?token=` | Loading it consumes nothing, so mail scanners cannot burn the token. |
| `POST /api/auth/email/verify` | Same-origin form POST only (`Origin` must match; `Sec-Fetch-Site: cross-site` is refused), otherwise a foreign site could sign a visitor into the attacker's account and move their anonymous library onto it. Merges this browser's `anon_*` rows, sets the `user_*` cookie, redirects to a same-site `next`. |
| `upsertVerifiedEmailUser()` | One account per verified mailbox: reuses a `users` row whose `email_verified = 1` (Google or email). A new one stores `google_sub = 'email:<address>'` because SQLite cannot relax `NOT NULL` on the existing column. |

If the same verified address later signs in with Google, `upsertGoogleUser`
rewrites that `email:` placeholder to the real Google subject, so the account
(and its library) is not split. A Google address Google did not verify is never
linked.

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
| `createRateLimiter(name, max, windowMs, { onError })` | Fixed window; atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING count`. Row key `name:max:windowMs:windowStart`, so two routes with the same budget keep separate counters (`jobs-create`, `jobs-takehome`, `tts-live`, …) |
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
| `updateJob(id, patch)` | Dynamic SET for status/progress/audio/error/… |
| `deleteJob(id)` | Soft delete: `deleted_at = unixepoch()` |
| `logUsage(…)` | Best-effort insert into `usage_logs`; **never throws** |

### `src/lib/turso/uploads.ts`

| Export | Role |
|--------|------|
| `recordUpload({ id, userId, storagePath, sourcePath, … })` | Ownership proof (paste + ready extracts) |
| `insertPendingUpload(…)` | Row created at presign (`status: pending`) |
| `getOwnedUploadByPath(storagePath, userId)` | Exact match on extracted `content.txt` path for this owner — used by job create |
| `getUploadById` / `getUploadByIdForUser` | Worker and poll/complete |

---

## 8. Schema & runtime migrations

### `migrate-turso.sql`

Additive SQL for humans / ops. **Must not** `DROP TABLE jobs`. Mirrors what the
runtime migrator creates.

### `src/lib/tts/schema-migrate.ts`

| Export | Role |
|--------|------|
| `ensureTtsJobColumns()` | Idempotent. Cold isolates first check whether the live schema is already current (one round-trip, including `cloned_voices.accent`). Otherwise `CREATE TABLE IF NOT EXISTS` for `jobs`, `uploads`, `usage_logs`, `cloned_voices`, `clone_uploads`, `fish_inflight`, `users`, `email_login_tokens`, `youtube_search_cache` (batched); `ALTER TABLE … ADD COLUMN` for `JOB_COLUMNS`, `UPLOAD_COLUMNS`, `USER_COLUMNS` (`google_sub`, `email`, `name`, `image`, `created_at`), and `CLONED_VOICE_COLUMNS` (`accent`, plus nullable `source_kind`, `source_url`, `source_start_sec`, `source_end_sec`, `source_consented_at`); then indexes (`idx_users_google_sub` unique) |
| `resetSchemaMigrationCache()` | Tests |

Important columns on `jobs` (non-exhaustive):

- Identity: `id`, `user_id`, `deleted_at`
- Source: `book_title`, `pdf_storage_path`, `char_count`
- Voice: `tts_provider`, `provider_voice_id`, `catalog_voice_id`, `tts_options`, `voice_name`
- Kind: `generation_mode`, `job_kind` (`stream` \| `takehome`)
- Progress: `status`, `progress`, `current_section`, `total_sections`, `next_section_index`, `segments_json`
- Stream: `stream_cursor`, `stream_chars_used`, `stream_max_chars`
- Lease: `processing_lease_token`, `lease_expires_at`, `processing_started_at`, `generation_started_at`
- Output: `audio_storage_path`, `duration_seconds`, `price_estimate_eur`, `parent_job_id`, `error_message`, `warning`
- Clone engine: `provider_pin` (`modal` / `fish`; a legacy `drama3` value is read and re-pinned, never synthesized), `clone_wait_started_at`

Statuses used in practice: `queued`, `waiting`, `processing`, `ready`, `failed`, `cancelled`. `waiting` is a take-home whose file is still being read. The deployed Trigger drain only claims `queued` and `processing`, so a parked book is inserted and released as `waiting`. SQLite cannot alter a CHECK: when a live `jobs` table rejects `waiting` or `cancelled`, `ensureTtsJobColumns` copies the rows into a new table and renames it.

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
| PDF | `unpdf` ≥ 1.8.1, per-page lines (`mergePages: false`) then line unwrap |
| EPUB | JSZip spine (`h1`–`h3` kept as chapter titles) |
| DOCX | `mammoth` HTML (heading styles); raw text if HTML fails. Input is always `{ arrayBuffer }`; `{ buffer }` only when `Buffer.isBuffer` accepts it |
| TXT | UTF-8 |
| RTF | control-word strip |
| MOBI/AZW | Calibre `ebook-convert` if present |

DOCX always passes mammoth a copied `{ arrayBuffer }`
(`bytes.buffer.slice(byteOffset, byteOffset + byteLength)`). `{ buffer }` is
added only when `Buffer.isBuffer(Buffer.from(bytes))` is true. The extract
Worker bundles mammoth's browser unzip, which opens `arrayBuffer`. A Worker
Buffer polyfill can exist while `isBuffer` is false; sending that object as
the only file option throws "Could not find file in options". Node (Vercel
`after()` and tests) still receives `buffer` when `isBuffer` accepts it. The
voice page maps that string through `userFriendlyError`.

Then normalizes through the shared `normalizeSourceText`
(`src/lib/source-text.ts`): conservative end-of-line dehyphenation (keep the
hyphen when the next line is capitalized), page markers, list flattening, and a
line unwrap that keeps headings and paragraph breaks instead of space-joining
every single newline. Blank-line paragraphs (TXT, EPUB, DOCX) stay intact.
Rejects under `MIN_EXTRACTED_CHARS` (50).

A valid EPUB navigation/spine, PDF outline, HTML heading list, DOCX heading style,
or printed contents tree is used first during extraction and take-home freezing.
There is **no model in this path**: the detector, the embedding topic placer, and
the candidate chooser that used to sit here all guessed structure the source
already had, and the corpus showed them replacing a correct 65-chapter outline
with a 1-chapter one. A book with no markers gets labelled length parts
(`src/lib/length-parts.ts`, `source: "sections"`) rather than invented titles.
Timing reuses the MP3-frame / speakable-text path, so tapping a chapter seeks to
its measured `startSeconds`.

### The canonical block model — `src/lib/blocks.ts`

Structured sources already know where their headings are. Reducing them to one
flat string and then re-finding those headings with regexes is what produced
every detection failure in the corpus, so a structured extractor now returns an
**ordered block list** plus chapter markers that point at **block indexes**:

```ts
type BookBlock = {
  kind: "heading" | "para" | "list-item" | "quote" | "verse"
      | "table" | "caption" | "footnote" | "scene-break";
  level?: number;          // 1-6, headings only
  text: string;
  source?: { page?: number; spine?: number; id?: string };
};
```

`ExtractedDocument` carries that list in `blocks`, the markers in `outline`, and
each block's offset in the narration in `blockStart`. `resolveChapters` uses
them directly (`src/lib/block-chapters.ts`), so nothing searches the prose for a
title.

| File | Role |
|---|---|
| `blocks.ts` | the block shape, the furniture labels (cover, title page, contents, copyright, licence, colophon, Gutenberg), Gutenberg header/footer removal |
| `html-blocks.ts` | HTML into blocks: `h1`–`h6` become headings with their level; lists, quotes, captions, and real table rows get their own kinds; the existing chrome rules (link-only rows, trending rails, language menus) still drop page furniture |
| `block-projection.ts` | **the one place a block's char offset is decided.** The narration string stays the shared `normalizeSourceText` + `toSpeakableText` pass, so `content.txt` is byte-identical to before; only offsets are derived, by locating each block in order |
| `block-chapters.ts` | block indexes to `chapters.json`: furniture filtering, source-level nesting, a distinct-position gate for a per-paragraph NCX, a contents-table drop, and `chooseOutline` |
| `epub-blocks.ts` | spine into blocks, and each TOC href resolved to the block carrying its `#fragment` id (else a heading whose text is the label, else the file's first block once) |
| `pdf-blocks.ts` | laid-out PDF lines into heading/paragraph blocks tagged with their page, and an outline destination resolved to the block on its page whose heading matches |
| `length-parts.ts` | labelled length-based parts for a book with no chapter markers, and `outlineLooksUnmarked` |
| `chapter-classifier.ts` | the optional local zero-shot model (see `docs/chapter-corpus-results.md`) |

`compactPage` in `pdf-furniture.ts` now keeps the visual line records (minus
their per-glyph items), so the block pass reads the same lines the furniture
pass used instead of parsing every page a second time.

The same extract writes `pdfs/<uploadId>/chapters.json` (`version`, `source`,
`chapters[]` with `title`, `level`, `charStart`, `charEnd` into `content.txt`,
optional `subtitle` and `children`, and `match`, the source line generation
should break on when it differs from the display title). `source` may be
`printed-toc`. A contents page is parsed in order; body headings after that
page confirm each part. Topic children are kept only for a mapped page number
or one verbatim title match inside that part.
A printed contents page may only **confirm** the headings found in the body: it
is used when it names at least as many distinct chapters as the body does, so
Moby-Dick's 71-row contents page no longer replaces its 135 real chapters. A
`heading-lines` book with no chapter labels at all *and* only shouted headings
(Ulysses) gets labelled length-based parts instead (`source: "sections"`).

The **top level is the chapter list**. `src/lib/chapter-levels.ts` re-levels and
re-nests the finished tree for every detection path: the source's own nesting
first, then sub-section numbering (`2.1` under `2`, `A.2` under `A`), then
heading depth (`h1`/`h2` chapters, `h3`+ children), then Book/Part/Article
container lines in a flat list. A title that satisfies none of those stays a
top-level chapter.

PDF outline destinations resolve to a page index and then a char offset.
The offset is kept when the title is a heading on that page, or the same
words occur anywhere on the page once whitespace is folded (a citation may
precede them). A contents-page hit is rejected. A short all-caps numbered
line (`3 BERT`) and a decimal heading with a comma or a version token
(`4.2 SQuAD v1.1`) stay. `5 White` does not. Appendix lines (`A.2`, `B`,
`B.1`) stay their own paragraphs. Subsections printed in the body and
missing from the outline are added and nested under the entry they extend.
`scripts/rechapter-takehome.ts` re-runs detection and rewrites the chapter
files for a finished job. Section durations are MP3 frame counts (Xing/LAME
or a frame walk; ffprobe on a local file), scaled so they end on the
measured `full.mp3`. A stored `section-starts.json` is reused when its total
is already within 3 seconds of that file. A heading inside a section is
timed from the speakable text up to that heading (or its paragraph start,
see below), with section offsets relocated into the speakable text. `--dry-run` with a job
id prints that list and writes nothing. A write copies the existing chapter
files to a timestamped sibling first. `--asr-snap` is off unless passed, and
only runs when `faster-whisper` or `whisper` is on PATH. It asks for word
timestamps, matches a number word to its digits, and leads the spoken word
by 0.5 s. A local `full.mp3`
gets an in-place ID3 chapter rewrite when the new tag fits the existing
padding; object storage is left unchanged, because patching the header would
re-upload the book. EPUB reads the NCX (`application/x-dtbncx+xml`) or the
EPUB 3 `nav` document first and maps each entry to the **block** its
`href#fragment` id names (see the block model above), so twelve chapters that
share one spine file no longer all land on the same place; spine headings are
the fallback when the TOC resolves to fewer markers than the book prints. PDF
reads the outline (`getOutline`, nesting kept as `level`) when it has at least
two entries and resolves each destination to the block on its page whose
heading text matches. DOCX uses mammoth
HTML heading styles, `Title`/`Subtitle` through the style map, and — when no
styled headings exist — short fully-bold paragraphs (three or more). PDF and
TXT without an outline use heading lines after unwrap, including Foreword /
Coda / Notes. Paste-text and link uploads write the same file from heading
lines. Detection runs before title-casing; display titles are Title Case for
ALL-CAPS lines with Roman numerals kept (`CHAPTER IV` → `Chapter IV`), capped
at 120 chars, and a label repeated under different Books or Parts is prefixed
(`Book One · Chapter I`). A dense run of five or more bare `Chapter N` labels
with no text between them (a Contents table) is dropped whole, including its
book lines; an outline that matches under half its entries yields to the
body's own heading lines, and a single title covering the book is ignored.
Abstract, Acknowledgements, and References stay when the outline omits them
and the body has that heading.
Title-page scraps before the first real body heading (Preface, Introduction,
Chapter, Part), plus ISBN, edition, copyright, Library of Congress, and
publisher lines, and one- or two-word or mid-phrase fragments, are dropped
from that list. A one-word heading with a real body (Notes, a short chapter)
stays. `Preface.` is that heading with a period. A line of only Roman
numerals (`II., III., IV., V.,`) is a contents row and is not a title.
If the printed-toc or destination step throws, resolution falls back to
exact-key alignment. `content.txt` still becomes `ready`. An empty outline
(`source: "none"`) is only what remains when that fallback also throws. `GET /api/pdf/upload/[id]` attaches `chapters`
once the row is ready. The voice page lists them and does not block narrator
choice.

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

**Links and web leftovers.** Before the bare-URL rules run,
`stripLinkAndSymbolNoise` turns `[label](https://…)` into its label, so a
markdown link is never left as `[label](`. A URL or email behind a preposition
takes the preposition with it (“Read it at https://…” → “Read it”), because
deleting only the address leaves a dangling clause. Emoji and pictographs are
removed, `[sic]` / `[emphasis]` are deleted rather than spoken, and one pass of
entity decoding means a page copied as HTML cannot be read as “amp”.
`@handle` mentions are dropped after the address rules, so an email never
loses its local part.

**One pass for every source.** `normalizeSourceText` (`src/lib/source-text.ts`)
is the single paragraph pass. `normalizeExtractedText` (document extract),
`POST /api/text/upload` (paste or fetched page), and `readPublicUrl` all call
it, so a paste, a web page, and an uploaded `.txt` holding the same words
produce the same speakable string. It runs on extracted text only: HTML tag
stripping and page-region choice stay in `html-article.ts`, and document
parsing stays in `text-extraction.ts`.

The pass drops control characters and page furniture, flattens lists and
tables, then unwraps each blank-line block with the same `unwrapPdfLines` the
PDF path uses. A paste and a PDF of the same page therefore dehyphenate
identically, and a hard-wrapped paste no longer becomes one run-on paragraph.
A hyphen between number words is kept (“seventy-three”), because the hyphen
is part of the word. A blank line that falls in the middle of a sentence is
joined back: the first block does not end in `.!?:;"”’`, and the next starts
with a letter. “they ultimately create” / “wealth.” is one sentence, and so is
“the commanding” / “Heights”. A short title-case heading, a Chapter / Part
line, or a bare section numeral stays above the sentence that follows it. A
duplicated drop cap (“R Ravi avi wakes”) collapses to the word (“Ravi
wakes”). The pass is idempotent, so a second copy of the same words settles on
the same string.

`toSpeakableText` collapses a drop cap again on its own input, so callers that
skip the shared pass (live preview, frozen script) still get that repair.

**Lists and tables.** `flattenListsAndTables` gives every bullet, numbered
item and table row its own paragraph before paragraphs are formed, because a
blank-line join would otherwise fuse a list into one sentence and the narrator
would read the bullet character and the pipe columns aloud. A bullet marker is
dropped; a list numeral is kept so a numbered step is spoken as an ordinal.

**Web furniture.** Share bars, “read more” teasers, subscription prompts,
author bylines and control rows are dropped by `isWebFurnitureLine`. On the URL
path, `<figure>`/`<figcaption>` and `<sup>` are dropped at extraction: a
caption describes a picture the listener cannot see and carries the photo
credit, and a `<sup>[1]</sup>` glues a bare digit onto the preceding word.
On every ingestion path, `toSpeakableText` also drops a footnote or endnote
block (“10. Luke Emerson and David Rudman, The Plunging Price of Thought,
Epic AI, September 22, 2026.”) and a `Source:` figure caption, including one
that trails a real sentence. A numbered step (“1. Fill the bath”) stays. A
chapter title glued to its first sentence (“Chapter VIII Closing Out from
the garden”) is split back into the title and the sentence. A contents list
whose entries ran together on one line is dropped; a sentence that only
mentions two chapters stays.

After the academic peel, `normalizeSpeakableText`
(`src/lib/tts/normalize-speakable.ts`) applies **general** PDF/OCR hygiene —
not essay- or voice-specific rewrites:

| Default | What happens |
|---------|----------------|
| Footnote glyphs `* ∗ † ‡ §` | Stripped when they would be spoken |
| Editorial `[like this]` | Unwrap; keep inner text; `[sic]`/`[emphasis]` deleted |
| Numeric citations `[1]`, `[12-14]` | Dropped (do not speak the numbers) |
| ALL-CAPS lines | Title Case only for a short title with no sentence punctuation. A shouted sentence or a run of initialisms is left alone, and `NOAA`/`FEMA`/`NHS`-style acronyms are preserved inside a title. |
| Lone Roman section lines (`I`–`XX`…) | Treated as a paragraph break; not spoken |
| Whitespace | Collapse runs; keep `\n\n` paragraph structure |
| Fish `[break]` / `[long-break]` | Preserved |

`normalizeNumbersAndAbbreviations` is the English rule-based backstop in
`prepareForListening`. With no cleanup key, or when both cleanup models fail
or return invalid replies, it expands numbers, context-sensitive years, ordinals,
currency, percentages, numeric ranges, contextual Roman numerals, titles, and
common abbreviations after the deterministic pre-pass. A clock with an
AM/PM marker is spoken as words with the colon removed (`5:56 AM` → “five
fifty-six AM”, `7:05 a.m.` → “seven oh five AM”, `12:00 PM` → “twelve
o'clock PM”). A colon that is not a clock (`John 3:16`) stays a colon. A scaled currency amount
speaks its magnitude after the value (`$4.2 million` → “four point two million
dollars”), never as cents. Decades are spoken as decades (`1990s` → “nineteen
nineties”). A digit stuck to a letter, sign or slash (`N+1`, `v2`, `H.264`) is
left alone, because mixing a letter with a spoken number mid-token is not
English. Successful primary or
fallback model output stays as returned. The LLM cleanup prompt describes the
same rules — link labels without URLs, prepositions dropped with their address,
scaled currency, emoji and `[sic]` deleted, one speakable line per list row —
so the model and the fallback agree. Failed chunks retain `ok: false` so
later cleanup attempts still retry them. Protected chapter lines stay verbatim
for outline alignment, and paragraph breaks remain intact.

No literary restyling. No Bloom / Caesar / title-specific word lists.

Wired from: `extractUploadedDocument`, `POST /api/text/upload`,
`loadBookText` (take-home), `createStreamAudioIterator` (Live Stream), and
optional Live Listen sample text on `/api/tts/live`.

### Narration script — `src/lib/tts/narration-script.ts`

Audiobook pacing is **pauses and phrasing**, not slower vowels. Fish S2
honors `[break]` (short) and `[long-break]` (extended) in the `text` field
([emotion / special-effect cues](https://docs.fish.audio/developer-guide/core-features/emotions)).
S1 `(break)`, blog `[pause]`, SSML `<break>`, and ffmpeg `atempo` are not used.

`toFishPlainNarration` is what Fish receives: headings on their own paragraph
with ending punctuation, scene-break lines dropped, no square-bracket cues.
A book's own `[brackets]` become parentheses. Allowlisted S2 tags are removed.

`toFishNarrationScript` is the Edge / Google pause IR. It:

- puts `[long-break]` after headings and between paragraphs
- drops a scene-break line (`***` / `---`) instead of speaking it
- puts `[break]` between long academic sentences (high chars/sentence)
- may put **one** `[break]` after a mid comma on sentences longer than
  `LONG_SENTENCE_COMMA_BREAK_CHARS` (220), via `decideLongSentenceCommaBreak`
- does not treat `Mr.` / `Mrs.` / `Dr.` / `St.` and the other listed
  abbreviations as sentence ends
- never inserts a break after every `and` / `that` / comma
- leaves short dialogue untagged so it does not chop every beat
- is idempotent

Narration does not prepend `[conversational seminar tone]`.

Whole-book knobs are **not invisible constants**. `resolveDeliverySettings`
(`src/lib/tts/delivery-settings.ts`) derives adaptive defaults from the book
(sentence length, punctuation density, ALL-CAPS / Roman headings, quote
ratio, length). There is no narrator-page control for pauses, joins, or titles.
`narration-delivery-controls.tsx` still loads a leftover `localStorage` value
and the voice page forwards a non-`auto` pause style on the live request.
Choices that are present persist on `jobs.tts_options`. The Seminar / Plain
control is gone. Live Stream (`createStreamAudioIterator`) and Live
Listen (`/api/tts/live`) resolve the same knobs from the book / sample plus
`jobs.tts_options` or request `ttsOptions`. Soft crossfade stays Whole-book
concat only.

`narrationScriptForSynthesis(text, providerId, { deliveryPrefix, pauseStyle })`
sends Fish the cleaned words with no square-bracket cues. Edge and Google
still get `[break]` / `[long-break]`. OpenRouter / Gemini / Grok stay
untagged — they would speak the words.
Google maps those pause tags to SSML `<break time="300ms" />` /
`<break time="700ms" />` in `ssml-pauses.ts`. Edge Read Aloud rejects
custom `<break>` markup (websocket 1007 "SSML is invalid"), so the same
IR becomes punctuation breaths inside the stock speak/voice/prosody
envelope. Rate / `speakingRate` stay unchanged.

Fish whole-book, Live Listen, and Live Stream send cleaned words with no square-bracket cues. Headings are their own paragraph with ending punctuation. A book's own square brackets become parentheses before Fish synthesis. The published S2 allowlist (`fish-s2-cues.ts`) is what we drop, so a leftover tag is not spoken as a word. Edge still inserts `[break]` / `[long-break]` and strips every other square cue. The Google SSML mapper in `ssml-pauses.ts` still exists for the retired packer and its tests; Google Cloud TTS is not called. Fish section MP3s use cache variant `fish-plain-v1`. A clone on the self-hosted pool uses `s2-pro-modal-${cloneNarrationRecipeId()}` from `src/lib/tts/clone-narration-recipe.ts`, which is `s2-pro-modal-u560-m260-p220-400-960-a1` at the current constants (unit ceiling 560, paragraph merge 260, pauses 0.22/0.40/0.96, history anchor first). The old literal `s2-pro-modal-v1` is not written anymore. There is no `drama-3` variant. Edge and Google-shaped pause scripts stay `fish-cues-oneshot-v1`. Paradee uses `paradee-paragraph-v1`. An older cued take is not replayed. Picker previews speak `PREVIEW_TEXT`.

The operator page at `/dashboard/player/[id]/markup` shows that Fish text for an allowlisted operator. It does not include the owner's email, name, or user id.

There is no book-level `[conversational seminar tone]` prefix. The job is marked **ready** only when every section index exists and the delivery encode produced a playable file. A book with holes is **failed**, with the audio that exists left in place and `progress` under 100 (`process-job.ts`). A second pass overwrites `full.*` only when DeepFilter is opted in, or when the join did not already run the chain (single section, WAV). Fish fan-out is 4, or 5 when no live Fish request is in flight (`TTS_TAKEHOME_FANOUT` can pin it). It is not a fixed 5. Clone ticks claim toward the batch size, not that Fish cap.

`deliveryPrefix` is still resolved and stored for older clients. Narration
ignores it: the retired seminar prefix is not prepended. The narrator page no
longer offers Seminar / Plain. Live Stream cursor still advances over the
untagged speakable window so offsets do not drift.

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

Player speed cycle (`src/lib/player/playback-speed.ts`) is listen-time
`playbackRate` (not Fish generation speed): **0.8–1.5** in fine steps
including **1.15** and **1.25**. A fresh player starts at **1.15×**
(`DEFAULT_PLAYBACK_SPEED`). One quiet tap control, not a pill row.

### Document upload — presign + R2 PUT + near-request extract

Vercel never buffers the document. Hobby `FUNCTION_PAYLOAD_TOO_LARGE` is ~4.5MB.

Extract is **not** Trigger.dev. Parsing (unpdf / mammoth / JSZip) runs on
the always-on VPS, in a warm child process so it does not take a Whole-book
slot and a tiny file does not pay Node startup on every upload. The
Cloudflare extract Worker (`workers/extract`) is on the Free plan (~10 ms
CPU). Host order is Node, then Cloudflare when that POST fails, then
Vercel (inline ≤ 8MB, otherwise `after()`), then fail. Node and Cloudflare
call `runUploadExtract`, so `content.txt` and `chapters.json` match.
Voice selection is unblocked while extract runs in the background.

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
   - `WORKER_URL` + secret → `POST /extract` on the VM (202). Any format, any size.
   - That POST fails (network, timeout, or 503 unhealthy) and
     `EXTRACT_WORKER_URL` is set → POST Cloudflare Worker (202 + `waitUntil`)
   - both of those fail, or neither is configured → Vercel: tests / local
     and files ≤ 8MB extract in-process; a larger production file uses
     `after(() => extractUploadedDocument)`
   Does **not** enqueue `upload.extract` on Trigger.
4. **Node child** `src/worker/extract-child.ts` is forked once per slot and
   reused. It loads the parsers before it reports ready. The parent
   heartbeats `extract_started_at` every 20s. On a successful read the child
   sends listen-prep over IPC and waits for the parent's ack (the parent
   runs `prepareUploadForListening`) before it reports done, so the child
   going idle cannot drop that request. A one-shot child with no IPC awaits
   the kick itself before exit. The child's `execArgv` keeps the parent's
   heap flags; `EXTRACT_CHILD_MEMORY_MB` adds an old-space cap. A child
   whose heap exceeds `EXTRACT_CHILD_RECYCLE_MB` (default 1024) is replaced.
   A child that has not finished one extract within `EXTRACT_CHILD_TIMEOUT_MS`
   (default 10 minutes) is killed and replaced. That upload is not put back
   on the child queue; its heartbeat stops, so the stall poll retries or
   fails it. When the child reports done or an error, the parent moves that
   upload's `waiting` take-homes to `queued` (or `failed` if the read failed)
   and wakes the drain, so a book created while its file was still being read
   does not sit until the 15s timer.
   The Cloudflare Worker calls the same `runUploadExtract`. A second
   finisher sees `ready` and does not clobber it. The child is outside
   `WORKER_CONCURRENCY` (`EXTRACT_NODE_CONCURRENCY`, default 1, max 4).
5. Voice step polls **`GET /api/pdf/upload/[id]`** in the background (landing
   does not wait). The player job poll calls the same `advanceStuckExtract`.
   One `extract_attempts` counter covers Node, Cloudflare, and Vercel.
   A Node row with no heartbeat for 180s is retried once, then Cloudflare,
   then Vercel. A Cloudflare fallback is re-sent once at 45s and handed
   back to Node only when Node has not already used two attempts; otherwise
   the next host is Vercel. After 4 attempts or 20 minutes from the first
   accept the row is `failed` with "This file took too long to read. Try again."
   Trigger `upload.extract` / `upload.drain` are no-ops (`src/trigger/extract-upload.ts`).
6. Take-home job create accepts an owned upload that is still `uploaded` or
   `extracting` and inserts `waiting`. `pending` and stream jobs stay
   `TEXT_NOT_READY`. `getUploadByStoragePath` is only used on a path that
   already passed `getOwnedUploadByPath` (or a job loaded with
   `requireOwnedJob`). The worker tick parks as `waiting` until the text is
   ready. That tick is `deferred` and `busy`, so the wave returns immediately,
   the TTS slot is released, and the drain cadence (or the extract-finished
   wake) runs the next attempt. When the upload becomes `ready` or `failed`,
   `releaseWaitingTakehomesForUpload` runs from that wake, from
   `extractUploadedDocument` (Vercel and the Node child), from the stall fail
   in `advanceStuckExtract`, and from the Cloudflare Worker. `ready` queues
   those `waiting` take-homes. `failed` fails them with the upload's message.
   A file still `uploaded` or `extracting` is left `waiting`. A failed read
   also fails the job with the upload's message when a tick claims it. The player shows "Reading your book" (`waiting_for_text`) for
   `queued`, `waiting`, and `processing` while that wait is open. Dedupe
   treats `waiting` as a live book.

Multipart `POST /api/pdf/upload` is rejected (`USE_PRESIGN`).

Missing session secret in production → **503** (deliberate).

#### Pick-time validation (phones, Google Drive)

Phones pick files from Drive / Files through lazy `content://` providers: the
`File` may report size 0 until read, an empty or octet-stream MIME, a stripped
extension — and a read after an `await` throws `NotReadableError` when the
grant expires. The old flow bailed silently on several of those (sync
name/MIME check, size-0 rejection, unreadable PUT body) so nothing happened
at all on Android Chrome. The new contract:

- **`src/lib/file-pick.ts`** (browser-safe, no Node imports):
  `validateBookFilePick` / `validateCloneSamplePick` run the moment a file is
  picked — Google-shortcut check → size ceiling → head read (catches
  `NotReadableError` into a "download it to your device" message) → magic-byte
  sniff (`sniffDocumentFormat` / `sniffCloneSampleFormat`). Never trusts
  `file.name` or `file.type` alone; validation is by extension AND bytes. A
  pick that lazily reports size 0 is read **directly** (`Blob.slice()` would
  clamp to the reported size and return nothing) — only a read that truly
  returns 0 bytes or throws fails as unreadable.
- **`src/lib/upload-client.ts`**: the full read happens **first**, before any
  other async work (presign, PUT), so an expiring content grant can't kill
  the upload mid-flight. The PUT body is those read bytes sent as an
  `ArrayBufferView` (XHR with `upload.onprogress` in browsers; `fetch`
  fallback where XHR is absent) — one in-memory copy, no second `Blob` of a
  large book. Presign receives the sniffed `contentType` and the real
  `byteLength`, not the lazy `file.size` / empty `file.type`.
- **`accept` lists** (`SUPPORTED_DOCUMENT_ACCEPT`,
  `SUPPORTED_CLONE_SAMPLE_ACCEPT`) carry extensions AND MIME types so Drive /
  iCloud items are selectable; video containers are allowed for clone samples
  (phones record voice memos as `video/mp4`). A video container the browser
  cannot decode (some `.mov`) is rejected at the pick with
  "Couldn't read audio from that video" (`looksLikeVideoCloneSample` +
  `prepareCloneSampleFile`'s `decoded` flag) — the raw MP4/MOV is never sent
  to Fish as audio. An audio file that fails decode still proceeds as the
  original.
- **Google Docs** (native Drive formats are links, not files): both pick
  validators and both presign routes reject with `GOOGLE_DOCS_UPLOAD_MESSAGE`
  ("download it as DOCX or PDF, then pick that"). `extractDocument` throws the
  same message for a Google shortcut entry, so a `.gdoc` JSON blob can't slip
  through as plain text.
- **Every failure is visible**: the book input shows a Reading state and
  progress; the clone line shows "Reading…" / "Uploading… N%". Both inputs
  reset `e.target.value` after the pick so re-picking the same file fires
  change again. Sample-prep failures are split: genuine read failures
  (`isFileReadError` — NotReadableError and the like) get the download-first
  message, other prep errors get their own short line. Failures go to the
  browser console and to **`POST /api/log`** (rate-limited 20/10min, fail-open,
  always 204, never mints a session; newlines and control characters are
  stripped from the logged strings) so the silent-failure class is
  diagnosable from the server log.

`src/lib/text-extraction.ts` and `src/lib/document-formats.ts` are bundled
into the Cloudflare extract worker — **redeploy it** (`npm run extract:deploy`)
to pick up the Google-shortcut rejection and the plain-text sniff fallback.


### `POST /api/text/upload` — paste intake

Same ownership/storage contract without file extraction:

1. JSON `{ text, title? }` (50–500_000 chars after trim) **or** `{ url, title? }`
2. A `url` is fetched server-side (`readPublicUrl`): http(s) only, ports 80
   and 443, no userinfo. Loopback, private, link-local, CGNAT, and metadata
   hosts are refused, including after DNS and on every redirect. The connection
   uses the resolved public address. HTML is reduced to the article (or
   `<main>`, else the body) with scripts and chrome dropped. Chrome means the
   usual class/id/role tokens, a container whose text is mostly its own links
   (a nav or “related” row), `<figure>`/`<figcaption>`, and `<sup>` footnote
   references. A page is followed to a same-site plain-text or read-online file
   only when it is chrome-like or explicitly a download/catalog page — being
   short is not enough, and a sitemap or robots link is refused, so a short
   article is not replaced by the site's URL list. Plain text is
   stored as-is, with the Project Gutenberg license wrapper removed. A URL
   whose body is a PDF, EPUB, DOCX, RTF, or MOBI is extracted with
   `extractDocument` — the same text and outline hint an upload gets. It is not
   run through HTML extraction. Cap 16 MB
   downloaded, then 8_000_000 characters (a pasted JSON body stays at 500_000).
   That stored `content.txt` is already `ready`, so the extract Worker is not
   in this path. Document uploads stay at the 512 MB ceiling, and R2 accepts
   the text object (single PUT under 8 MB, multipart above that). Listen-prep
   chunks the book, so a long novel is not one model call.
3. Every source runs **one** cleanup chain: `normalizeSourceText` (the shared
   paragraph pass described above), then `toSpeakableText`. There is no
   paste-only or URL-only unwrap; a document link keeps its extracted outline
   hint for chapter detection only, and its text still runs the same pass.
   The result is written to `pdfs/<uuid>/content.txt`
4. `recordUpload(format: "txt", fileName: title)` — page title, else the host
5. Return `{ storagePath, fileName, charCount, source: "paste" | "url", … }`

Landing page offers **Upload** | **Paste**. Paste is **Text** or **URL**.
Both continue to
`/dashboard/voice`. The Voice tab opens on the Standard pile with no book
required. An explicit tap is stored in `localStorage` (`ec_stock_voice_pick`)
and kept when a book is uploaded or pasted, ahead of the narrator suggestion.
Clone stays one tap away.

---

## 10. Storage abstraction (local + R2)

### `src/lib/storage/index.ts`

Single façade used by workers and upload:

| Export | Role |
|--------|------|
| `uploadFile(dir, name, data, contentType)` | R2 if configured, else FS |
| `downloadFile(path)` | Buffer |
| `deleteFile` / `listFiles` / `getFileMetadata` / `fileExists` | Same split |

Local root: `STORAGE_PATH` or `./data/storage` (dev) / `/tmp` on Vercel without R2.

### `src/lib/r2-storage.ts`

Configured when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
are set. S3-compatible client against Cloudflare R2. `getUploadUrl` mints a
short-lived **PUT** with **Content-Type signed only** (not Content-Length —
browser `fetch` cannot set that header, and a signed length 400s the PUT).
`getFile` still buffers a whole object for workers and the `.pcm` → WAV wrap.
Playback uses `openObject`, which forwards a single `Range` to `GetObject` and
returns the body unread — a seek no longer waits on a full `full.mp3` download.
Browser PUTs require a bucket CORS
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
5. Optional `?download=` filename for `Content-Disposition: attachment`.
   That response is `application/octet-stream` with `X-Content-Type-Options: nosniff`
   so iOS Safari saves the file instead of playing `audio/mpeg` inline.
   Playback requests omit `?download=` and keep the real audio type.
6. **R2 (production): 302 to a presigned R2 GET** (`directObjectUrl` →
   `getPlaybackUrl`). The browser fetches bytes and ranges from R2 directly, so
   audio never flows through a Vercel function (that was most of the Hobby
   Fast Origin Transfer and a large share of Active CPU). The URL is valid
   12–13h (signing time floored to the hour, so a whole hour shares one URL
   and the browser cache can reuse bytes). The `<audio>` element keeps ranging
   against that R2 URL, so a network error reloads `/api/storage` once and
   restores the playhead: the new request checks ownership and mints a fresh
   signature. The 302 itself is
   `Cache-Control: private, max-age=3600`, so repeated range requests reuse
   it without a new invocation. `?download=` becomes
   `response-content-disposition: attachment` + `response-content-type:
   application/octet-stream` on the signed URL. A presign error falls through
   to the proxy below.
7. Proxy fallback: `.pcm` (wrapped as WAV, full buffer, small sections), local
   disk (dev/tests), and `STORAGE_DIRECT_R2=0` (kill switch). MP3 / WAV / Ogg
   on R2 stream `openObject` — the `Range` is forwarded and the response is 206
   of that slice only. Local files stream with `createReadStream`.
8. Suffix ranges (`bytes=-N`) are the last N bytes.

Proxy headers: `Cache-Control: private, no-store` (so a shared browser cannot replay
another session's audio from the HTTP cache), `Accept-Ranges: bytes`,
`X-Accel-Buffering: no`. `maxDuration` 300 so a long progressive read is not
cut at the platform default. Seeks assign `currentTime` on the existing
`<audio>` (`preload="auto"`); they do not change `src` or call `load()`.

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
| `listCatalogVoices(filters)` | Slim catalog: Andrew (`standard`), Echomancer Andrew (`echomancer-andrew`), Ava, Libby, Ryan; clones merged in the voices API |
| `getCatalogVoice(id)` | Static / `clone:…` (user-scoped) / `research:` / live `or:…` / legacy `fish-narrator` |
| `getDefaultCatalogVoice()` | Standard (`standard`) |
| `isVoiceAvailable(voice, hdEnabled)` | Hide HD unless gate allows (fish clones always listed) |

### Fish voice cloning + live HTTP stream

| Piece | Role |
|-------|------|
| `FISH_API_KEY` | Native Fish API — create model + synthesize clones / Fish catalog |
| `CLONE_TTS_PROVIDER` | Unset or `modal` (default when `MODAL_S2_TTS_URL` is set): self-hosted S2-Pro, then direct Fish. `fish` is direct Fish only; a leftover `openrouter` value is read as `fish` because Drama 3 is gone. Both remaining engines speak the clone — Fish trained the reference — so the fallback is not a narrator change. Missing key/sample, HTTP errors, invalid audio, and failed streams fall back to Fish. Caller cancellation propagates. A take-home book pins its engine once (`jobs.provider_pin`) and a pinned book sets `allowFallback: false` per call, so a failure surfaces instead of changing engine; live listen is unpinned and still falls through. There is no substitute voice: with neither engine available the request fails visibly. |
| `POST /api/tts/clones/upload` | JSON presign `{ fileName, contentType, byteSize }` → PUT URL for `clones/<id>/sample.<ext>`. Ownership in `clone_uploads`. |
| `POST /api/tts/clones` | JSON `{ uploadId, title?, accent?, youtube?, acceptQualityRisk? }` → download stored sample → browser-metric gate (`analyzeCloneSampleBuffer` on 16-bit WAV; fail → 422 `SAMPLE_QUALITY`, no Fish) → worker reference gate (`POST $WORKER_URL/reference-quality`; fail → 409 `SAMPLE_RISKY`, upload stays pending) → `cleanupCloneSample` → Fish `POST /model` → `cloned_voices` (same id, `accent` default `american`). `acceptQualityRisk: true` continues a risky sample; echo clips then get one DeepFilterNet pass. Optional `youtube` `{ videoId, startSec, endSec, consent: true }` stores the source URL, range, and consent time. Multipart rejected (`USE_PRESIGN`). App max **32 MB**; Vercel body is JSON-only. `REFERENCE_QUALITY_GATE=0` skips the worker check. |
| Catalog id | `clone:<uuid>` · provider `fish` · `providerVoiceId` = Fish reference id |
| Synth path | Andrew / Ava / Libby / Ryan → `edgeTtsProvider`. A book already stored as Clara → `fishTtsProvider` with curated `reference_id`. A book already stored as Randolph is played from its saved file and is not synthesized. User clones → Modal S2-Pro when `MODAL_S2_TTS_URL` is set, then `fishTtsProvider` with the account `reference_id`. No URL skips Modal. Legacy `fish-narrator`: Fish endpoint **without** `reference_id`. Never send OpenRouter catalog UUIDs as `reference_id`. The GPU class defaults to `max_containers=1` (`S2C_MAX_CONTAINERS`). Production keeps the deploy-time env at 1 and raises the live cap after deploy with `Cls.from_name("echomancer-s2-clone", "S2CloneWorker")().update_autoscaler(max_containers=4, scaledown_window=180, min_containers=0)`; that override does not survive a redeploy, and `/ready`/`status()` keep reporting the deploy-time value. See step 8 of `docs/s2-gpu-staging-runbook.md`. |
| Clone engine pin | `jobs.provider_pin` (`modal` / `fish`) is written on the first tick that has a clone voice, and every later section uses that engine only. A legacy `drama3` row is re-pinned to `modal` or `fish` (`resolveLegacyDramaPin`) before any section renders, so Drama 3 is never called again and the rest of that book finishes in the real voice. A per-section failure never changes it: the book parks instead (`clone_wait_started_at`, `MODAL_S2_DEFER_MS`, default 25 min), and only when that budget is spent does it switch and write `warning`. A cold pool and a hard provider fault share that clock (`deferForColdClonePool` with `reason: "provider-fault"`), but a provider fault writes `CLONE_PROVIDER_FAULT_WARNING` instead of the cold-timeout warning, so the finished book says the service was broken rather than slow. `MODAL_S2_DEFER_MS=0` skips the park and continues the tick. That branch does not rewrite `provider_pin`. |
| Clone lanes | One lane = one HTTP batch call = one independent one-GPU container (`MODAL_S2_SECTION_CONCURRENCY`, default 4, max 8; `MODAL_S2_BATCH_SIZE`, default 24, max 32). **Rows per call is the throughput knob, not lanes**: a container decodes every row of a call in one batch (measured 2.9x realtime for a one-row call, 35–65x for a full one), so `planModalCloneLanes` fills a call toward `batch` before opening the next and the tick claims up to `batch` sections. The old round-robin split made 5 sections into four 1-row calls, which all landed on one container on `job db10a6d6` and ran at 2.93x (246s of audio in 84s of GPU wall) instead of ~24s. The per-call character cap is derived from the **wait a call can actually be granted**, not from the steady-state timeout: `modalLaneCharCap` = (`MODAL_S2_COLD_WAIT_MS` − a 70s restore/prep margin) × 100 chars/s, which is **8,000** at production defaults — the same value as the operator's stopgap. `modalLaneCharCeiling` bounds even `MODAL_S2_LANE_MAX_CHARS`, so an override can only lower a lane. The wait for a given call is sized from that call's own text (`modalLaneWorkMs`), so the packer and the timeout cannot disagree. **A row must fit too**, so clone sections are packed at `MODAL_S2_SECTION_CHARS` (default 2,000): a row renders its paragraph units in sequence at ~50 chars/s, so a 7.7k section needs ~154s of generation and cannot render inside any call budget. Packing at the Fish 8,000 ceiling is what froze the four 7.7k sections on `job 7e4a8b48` (2026-11-06) that stalled for 4m03s and never returned. A clone outline frozen wider than the cap is re-packed once, only while nothing has been published. A multi-section call that misses its budget is retried **one section per call** and never classified as a cold placement; only a single-section miss fires the off-path snapshot warm. Multi-GPU in one container is not used: Modal documents GPU snapshots as generally incompatible with it. **Section 0 is rendered alone first** (`MODAL_S2_FIRST_LIGHT`, default on) because a container answers a whole batch of rows together, so a section 0 batched beside a neighbour is exactly as late as that neighbour. That call also gets a shorter restore budget (`MODAL_S2_FIRST_LIGHT_WAIT_MS`, default 75s) — its wait is wall clock in front of the person and a compiling placement cannot be waited out anyway. If section 0 cannot be placed the fan-out is skipped. A clone book also pre-warms the pool at the top of its tick (`prewarmModalCloneSnapshot`), so the restore overlaps extract, packing and the reference download; one cheap RPC, never awaited, and `min_containers=0` still leaves no GPU running. The same RPC starts earlier for an account that already has a trained clone: when the worker accepts the extract (`prewarmClonePoolForUpload`) and when `GET /api/tts/voices` sees that clone (`after` → `POST /clone-prewarm` on the worker, because Vercel has no `MODAL_TOKEN_ID`). A container that finished restoring before section 0 is ~16–20s to first audio. One that is still booting does not take the HTTP call — Modal starts another container — so a fast click stays ~68s. Stock-only accounts never start a GPU. The 3-minute cooldown is shared, so the voice list does not stack a second container on the one extract just started. Section 0's publish skips transcript QA (a fresh Whisper process); later sections do not. `loadCloneReference` starts beside packing. |
| Clone batch contract | `POST /synthesize_batch` returns `items: [{ key, audio_b64, duration_s, units, truncated_units }]` or `{ key, error, error_code }`, plus `build`, `container_id`, `seed`, `reference`, `performance`. The client reads `audio_b64` and still accepts legacy `audio_base64`; a row with neither audio nor an error fails the call rather than staging silence. A `422` naming the reference is a non-retryable `ModalCloneReferenceError`; `502`/`503`/`504` and transport timeouts are `ModalCloneColdError`; any other `5xx` (or a body that is not MP3) is `ModalCloneProviderError` — a hard fault, retried once, then surfaced with the container's own message. It parks on the same defer clock and takes the same documented fallback, so a broken deploy never fails a book with `Section 0: Modal clone already retried` (`job 5f09ee0e`, 2026-11-06). |
| Reference decode | `validate_reference_audio` measures **every** container, not just WAV: `decoded_reference_stats` reports `format: "decoded"` and a real `seconds`/`rms`/`peak` for MP3/M4A/OGG/FLAC/WebM. Decoding is `s2_contract.decode_reference_samples` — standard library for WAV, ffmpeg otherwise — and `reference_float_samples` downmixes and resamples for the codec and for Whisper. `encode_reference` and `transcribe_reference` never touch `torchaudio.load` or `av.open`: on this image those are PyAV-backed, and the PyAV under fish-speech's lockfile predates the `metadata_errors` kwarg current `faster-whisper` passes, so every non-WAV reference raised `TypeError` and answered 500 on all four lanes while a WAV probe still returned 200. `modal/test_s2_reference_decode.py` decodes real fixtures for each container and fails if either library returns to that path. |
| Clone snapshot | `@modal.enter(snap=True)` starts a `GpuExecutor` thread, loads weights, compiles and runs a text-only **and** a referenced forward pass with a deterministic in-process WAV (`s2_contract.warm_reference_wav`), then `reset_state()` clears the KV cache and last audio so no customer speech and no dead pages enter the snapshot. All CUDA runs on that one thread; request handlers submit via `_run_on_gpu`. A restored snapshot is pinned to the thread that owned the context, and Modal serves a sync `@modal.fastapi_endpoint` on a fresh thread, where the first `cublasCreate` fails with `CUBLAS_STATUS_ALLOC_FAILED` while `.remote()` still works — that was the staging 500 on `/synthesize_batch`. `engine.selftest()` runs the same allocator paths at boot. `snap=False` publishes a heartbeat and starts a refresh timer; `@modal.exit()` removes it, so `S2C_HEARTBEAT_TTL` is 90 s (a call-triggered heartbeat alone would need hundreds of seconds and let a scaled-down container inflate `warm_containers`). `/ready` reads only live heartbeats of the current `S2C_BUILD`. `warm_containers` can still exceed `max_containers` for a moment during a replace, which is documented in the runbook. `boot` is `restored` only when the host monotonic clock went **backwards** (proof the image resumed on a different, younger worker); otherwise it is `unknown`. There is no `compiled` value: a container cannot prove it compiled, and pid equality is useless because Modal runs the app as pid 2 both before and after a restore. Modal's log line is the authoritative record, a restore duration is only measurable from outside, and `snapshot_age_s` is an age, not a duration, reported only for a proved restore. "~90 s" is a planning target in the runbook, not a duration this file has measured for every cold start. A measured restore cited for the books in this section is about 57 s. A book waits at most `MODAL_S2_COLD_WAIT_MS` (code default 150 s, hard ceiling 180 s — `modalCloneColdWaitMs` clamps anything longer, so a book cannot be configured to sit through an 8–16 min compile or the proxy's ~542 s kill). Past that budget the call is `ModalCloneColdError` with `scope: "placement"`: the HTTP wait is dropped, dispatch tries the unstaged sections once on another container, and `kickModalCloneSnapshotWarm` starts `modal run modal/s2_clone_warm.py::cover` (one RPC `status()`, detached, 20 min cooldown) when `MODAL_TOKEN_ID` or `MODAL_S2_WARM_CMD` is set. `MODAL_S2_WARM_HOOK=0` disables it. A probe miss is `scope: "pool"` and is not retried. `boot=` is not the hard rule (`placement_kind` in `s2_contract.py` classifies wall time: restore ≤ 150 s, compile ≥ 300 s). After a deploy, `::cover` scales to zero between rounds until consecutive wall-clock restores succeed. HTTP still cannot finish a snapshot. |
| Clone endpoints | Each `@modal.fastapi_endpoint` is served at the root of its own hostname, so there is one absolute URL per endpoint and nothing is appended. `MODAL_S2_TTS_URL` (batch, required), `MODAL_S2_SYNTHESIZE_URL` (single, optional, falls back to the batch host), `MODAL_S2_READY_URL` (probe, optional, never derived). `modal/s2_endpoints.py` and `modal-clone.ts` both reject a URL carrying a path, and reject a ready URL equal to the batch host. A 404 on an endpoint says the configured host is wrong, not that the pool is cold. A 429 is `ModalCloneLaneBusyError` (retryable, not cold). |
| Live preview | `GET/POST /api/tts/live` opens Fish HTTP first, then pipes **chunked** MP3 (`latency=balanced`). Fish 4xx before bytes → JSON, never HTML `/500`. A saved clone's preview is *not* rendered here. `GET /api/tts/clones/[id]/preview` never synthesizes. `clonePreviewLookupPaths` (`src/lib/tts/clone-preview-store.ts`) tries, in order: the current engine's take, the other real engine's take (`s2-pro` or `fish` — both speak the reference Fish trained), then the legacy engine-free key that holds pre-S2 Fish 2.1 Pro MP3s. Drama 3 has no key. A miss is `404 PREVIEW_NOT_STORED`. Only `POST` renders, once, with `allowFallback: false`, and it does not wait out a cold GPU (`PREVIEW_ENGINE_COLD`). Storage is written in exactly one place, so a take from an unintended engine cannot be served as this clone's preview. |
| Stream path | `synthesizeStream` yields Fish response body chunks (not a buffered unary clip) |
| Table | `cloned_voices` (session-scoped, soft-delete, `accent` catalog label, optional YouTube `source_url` / range / `source_consented_at`). YouTube rows stay private: Fish `visibility=private`, and there is no share path. `clone_uploads` holds the pending sample. |
| YouTube clip | Clone screen: paste a link or search. `GET /api/tts/youtube/search` requires a signed-in `user_*` (anonymous sessions are 401 `SIGN_IN_REQUIRED`) and keeps an 8-per-10-minute fail-closed limit. It calls YouTube Data API v3 with `YOUTUBE_API_KEY`: `search.list` (`part=snippet`, 100 quota units) for title, channel, and thumbnail, then `videos.list` (`part=contentDetails` only, 1 unit) for duration. Hits live in `youtube_search_cache` for 10 minutes, shared across isolates. A pasted link still opens the player when the person is signed out or the key is missing. The picker embeds the IFrame player (720p) and a 10–40s range (default 20s). The two handles sit on a scrolling timeline so they stay apart on a long video: a handle moves only its edge and stops at 10s or 40s, and the span between them moves the window without changing its length. The label and `POST /api/clips` use those whole seconds, so a nudge cannot send a window past the video. Fine tune uses the same 30-minute line as the segment actor (`CLIP_LONG_SOURCE_SEC`): at that length it stays under the timeline, and on a shorter source it appears at the first timeline gesture and then stays for the rest of that screen. It does not hide on blur, pointer-up, or a timer. Each step moves one edge by one second and stops at 10s, 40s, and the video, a held step stops when the edge cannot move, and that step is the same window the label and POST use. "Use this clip" is the server path on every layout: an allowlisted email (`YT_SERVER_CLIPS_EMAILS`) queues `POST /api/clips`. There is no tab capture, share-sheet, or microphone step. While the worker runs, the button reads "Fetching the clip" and then "Preparing the voice", with a thin bar that stays under full until the clone is ready. `completeStoredClone` high-passes at 80 Hz, always sets Fish `enhance_audio_quality`, and adds a nova-3 transcript for a YouTube clip when that call returns within 3 seconds. The worker picks the Apify actor from the source length stored at queue time (`youtube_clips.video_seconds`): sources of 30 minutes or more (`CLIP_SEGMENT_SOURCE_SEC`) run `entertained_rattlesnake/youtube-audio-segment-downloader` first with `{ videos: [url], format: "wav", startTime, endTime, transcribe: false }` and `maxTotalChargeUsd=0.15`; shorter ones run `utils/youtube-link` with `{ videos: [{ url, timeframe, audioQuality: "best" }] }`, the original container, and `maxTotalChargeUsd=0.05`. A classified failure (bot check, `sabr-gapped`, timeout, empty or invalid file, wrong duration, past the 16 MiB cap) falls back to the other actor once; a 402 budget stop does not. Each attempt has its own wall clock (90s, or 180s for the link actor on a long source), is long-polled with `waitForFinish` (max 60s), and aborts its run on timeout. The segment actor reports SUCCEEDED even when the video failed: the audio and the `FAILED_<videoId>.json` detail live in the run's key-value store, not the dataset. Clip length is ffprobe on the downloaded file, because the dataset `duration` is the full video. Once the run succeeds, the file download starts without waiting for the charge to settle. Spend is read in parallel (`usageTotalUsd`, otherwise the charge events: `AUDIO_DOWNLOADED` $0.015 plus `AUDIO_LONG_EXTRA` $0.004 per 10-minute block, or `video-started` $0.05 plus `audio-minute-processed` $0.04 per started minute), with a floor of $0.015 / $0.09 on a successful download. Memory stays at the actor default. An empty dataset with no status message is classified from the run log. Age, sign-in, bot-check, and "no usable connections" are `restricted` and are not retried. `audio-download-failed` and `sabr-gapped` are `transient` and retry once. |
| `PATCH /api/tts/clones/[id]` | Owner may set `accent` (`american` / `british` / `australian` / `irish`). The label is catalog-only (`Shauna · British` in the route test). It does not call Fish and it is not a training parameter. The Clone screen does not render a picker: new clones are stored as `american` (`DEFAULT_CLONE_ACCENT`). |

### Self-hosted clone: modules and the one engine decision

| Module | What it decides |
|--------|-----------------|
| `tts/providers/modal-clone-guard.ts` | Engine pin parsing, lane/batch/cold-wait/defer knobs, the 900 chars/min truncation rule, and non-blocking `usage_logs` writes (`recordModalCloneUsage`). There is no daily character cap. The old `ensureModalCloneJobAllowed` gate is gone. |
| `tts/providers/modal-clone-lanes.ts` | `planModalCloneLanes` fills a call toward `batch` before opening the next, because rows are decoded in one pass and a one-row call runs at about 2.9× realtime against 35–65× for a full one. Those multiples are audio-seconds per wall-second, measured, not a rate the next book is guaranteed to hit. `modalLaneCharCap` is the cold-wait generation budget (`modalCloneColdWaitMs` minus `MODAL_LANE_RESTORE_MARGIN_MS`, 70 s) times `MODAL_LANE_CHARS_PER_SECOND` (100). It is not the steady-state 60 s timeout. `modalLaneCharCeiling` bounds even `MODAL_S2_LANE_MAX_CHARS`, so an override can only lower a lane. `sectionSeedEpoch` turns a retry into a different take. |
| `tts/providers/modal-clone-dispatch.ts` | Runs the lanes and stages every rendered section. `firstLight` renders section 0 alone on one lane, publishes it through the real per-section path (`publishFirstLight`, started concurrently with the fan-out), and only then opens the remaining lanes — a container answers a whole batch together, so a section 0 batched beside a neighbour is exactly as late as that neighbour. If section 0 cannot be placed the fan-out is skipped, because a pool that just missed one restore will miss three more. A placement that misses the restore budget is retried once on another container; a pool that is already empty is not. `cold` is set when nothing was staged, so the tick can park instead of switching. A missed placement also kicks the off-path RPC warm. |
| `tts/providers/modal-clone-warm.ts` | Starts `modal run modal/s2_clone_warm.py::cover` detached. Two entries: `kickModalCloneSnapshotWarm` after a placement misses the restore budget (20 min cooldown, may sit through a compile), and `prewarmModalCloneSnapshot` (3 min cooldown, never waited on). `MODAL_S2_WARM_HOOK=0` disables both. The book does not wait on either process. |
| `tts/providers/modal-clone-pool-warm.ts` | Decides *when* a prewarm is worth a GPU. `prewarmClonePoolForUpload` runs when the worker accepts an extract; `prewarmClonePoolForUser` runs for `POST /clone-prewarm`, which `GET /api/tts/voices` fires (via `after`) when the account has a trained clone. Anonymous and stock-only accounts return false. The tick still calls `prewarmModalCloneSnapshot` directly so a miss overlaps packing. |
| `tts/process-job.ts` | `resolveCloneProviderPin` makes the one engine decision; `deferForColdClonePool` parks the book, arms `clone_wait_started_at`, and only after `MODAL_S2_DEFER_MS` pins it to `fish` (the same voice) with a warning — or, with no `FISH_API_KEY`, parks again rather than substituting anything. A cold section does not burn one of the section's attempts. `takehomeSectionCacheKey` is the single content-addressed key for a take — section-0 `balanced` latency plus the per-engine variant — shared by the lane prefetch and the per-section read, so a prefetched take is always found rather than paid for twice. |
| `modal/s2_contract.py` | Reference-clip and transcript validation, sampling parsing, lane planning, snapshot fingerprint, per-call seeding, container limits, the `GpuExecutor` that owns the CUDA context, boot provenance, the **clone conditioning recipe**: `history_anchor` (anchor each unit to the row's first take), `inserted_pause_s` (clause / sentence / paragraph ladder), the `UNIT_MAX_CHARS` / `MERGE_PARA_MAX_CHARS` / pause constants, `units_summary` (the unit shape a section went out as), and **`split_long_text`** — the total unit splitter (whole paragraph → balanced sentence takes → clause → word → raw slice), which can never emit an over-long unit and therefore can never make a section fail. Stdlib only, so the GPU image gains no dependency and every rule runs in tests. |
| Clone conditioning | `job 12534aaa` (2026-11-06) drifted inside every section — similarity to the reference 0.93 → 0.70, F0 −15–20 Hz, pitch range halved — and reset at each section boundary. That is per-row, so it is the per-row history chain: conditioning unit *n* on unit *n−1*'s generated audio walks the timbre away from the reference one step per unit. `history_anchor` now returns **only the row's first turn** (the take generated from the reference alone) for every later unit, so each one is a single hop from a clean sample. Prompt shape is unchanged; `HISTORY_ANCHOR_FIRST=False` restores upstream. Trimming takes to a short audio tail was rejected: a full paragraph of text beside 1.2 s of audio is a mismatched prompt. |
| Unit width and pauses | Two rounds of tuning blamed the wrong thing. `job 1f0137a1` (first post-#244 book) had 7–13 gaps ≥ 0.35 s per minute against ~6.5 before, so #244 set `UNIT_TARGET_CHARS=200` and #245 moved it to 300 with a 0.22/0.40/0.96 pause ladder. Joel still reported *"it stops and starts every time"*. The cause was never the gap **width**: a unit boundary is a hard splice (each take's own trailing silence is trimmed and a fixed pause inserted), and the **target** — not the ceiling — decided how many there were, so lowering one while the other still forced sentence-sized pieces changed almost nothing audible. There is now **one** width authority, `UNIT_MAX_CHARS = 560`, and no packing target. A paragraph under the ceiling is one generation, so the model places every breath inside it; a longer one is cut into the fewest, most even sentence-aligned takes (`_balanced_pack`: greedy count for the minimum, DP to minimise *and* even out the longest unit, so a paragraph never ends in a one-sentence stub). Measured on two ~17,100-char books: 78/74 units and 68/67 splices at #244, 57/55 and 47/48 at #245, **43/40 and 33/33** now; forced mid-sentence breaks 30/13 → 8/3. The pause ladder is unchanged. The ceiling itself is set by the model: `MAX_NEW_FRAMES` (1,024) at ~21.5 frames/s caps one take at ~47.6 s, and a take that hits it is `truncated` (section retried, then failed), so 560 chars is sized to fit 43.1 s at a pessimistic 13 chars/s and a test reads the constant out of source. A row's **last** take gets no inserted pause, because the app crossfades the join and a trailing paragraph-length block was up to 0.96 s of silence in front of it. **Missing section (still pinned):** the old `_CLAUSE_END` was `(?<=[,:—])\s+`, which requires whitespace after the dash, so `dynamic—something` never split; a 318-char unit made the container answer 422 and `_section_units`' `raise` dropped the whole 1,705-char section. The clause pattern is a zero-width lookbehind over `, : ;` plus the Unicode dash family, `split_long_text` always returns legal units, and the container's guard hard-slices rather than raising: a missing section is a hole a listener hears. |
| Clone book completeness and cache identity | `job 75944dc9` (2026-11-06, after #246) finished `ready` in 32 s with **5 of 11** sections, and Modal's own access log had **zero** requests for the failure window. Three defects hid each other. **(1) The generation allowance refused the book.** A per-account daily character cap (default 500,000) plus a global one (2,000,000) had been exceeded — 492,425 used, 17,022 requested — so an `ensureModalCloneJobAllowed` boolean refused the GPU pool, skipped the lane dispatch entirely, and every section then threw `Clone provider modal failed and this book may not switch engines`, a sentence about a call never made, three times each in about a second. The allowance has since been **removed entirely** (2026-11-07, product direction): no per-account cap and no global cap. `MODAL_S2_USER_DAILY_CHARS` and `MODAL_S2_GLOBAL_DAILY_CHARS` are not read by the running app. A stale worker `.env` does not refuse a book. Engine selection is configuration only (`resolveCloneProviderPin`), and no usage figure can pin a book to the backup engine. Only `usage_logs` accounting remains — written best-effort under action `modal_s2_clone`, never able to refuse or block — so cost stays observable. Real provider auth/quota/billing errors still surface as themselves. **(2) The cache key had no recipe in it.** `takehomeCacheVariant` returned the literal `s2-pro-modal-v1`, so #244's 300-char, #245's 400-char and #246's 560-char recipes all hashed identically; the five "ready" sections were byte-identical to S2C7/S2C8 takes, so the new runtime's narration never played. It is now `s2-pro-modal-${cloneNarrationRecipeId()}` — `u560-m260-p220-400-960-a1` — containing only inputs that change audio (unit ceiling, merge width, pause ladder, history anchor), never a deploy id or SHA. A test parses `modal/s2_contract.py` and fails on drift. **(3) "Ready" did not mean complete.** Assembly accepted `mostIndexesReady` (over half) or `doneCount > 0`, so that book was published as finished. Assembly now requires every index; a book with holes is published `failed` with `"N of M sections could not be narrated… not a complete audiobook"`, `progress < 100`, and the section files left in place. Auto-advance does not jump a hole on that `failed` row (`skipUnavailable` is only for `status === "ready"`). `job 75944dc9` itself was not regenerated. The harness disables the section cache unless `TTS_SECTION_CACHE=1`, which is why the clone **lane staging** path had no test; the completeness and acceptance suites set it to `1`. |
| Missing section in the player | `nextPlayableIndex(segments, from, { skipUnavailable })`. Advancing used to require every earlier index ready, so on a finished book with a hole the rest of the book was unreachable behind a section that would never render. The flag is true only when `job.status === "ready"`; while generating, order is preserved and nothing is skipped. |
| `modal/s2_endpoints.py` | One absolute URL per Modal endpoint. Rejects a URL that carries a path, and a ready URL that points at the batch host, because each `@modal.fastapi_endpoint` is its own hostname. |
| `modal/test_s2_contract.py` | Offline proof of those rules (`python3 -m pytest modal -q`). |
| `scripts/s2/staging-smoke.mjs` | HTTP acceptance against a deployed endpoint: ready, per-lane batch rows, distinct containers, one build, scale-to-zero. Synthetic text and a generated clip only. |
| `docs/s2-gpu-staging-runbook.md` | The GPU steps this repo cannot run: staging deploy, direct snapshot build, restore coverage, four-lane fanout, synthetic end-to-end, promotion and rollback. Step 8 is the production promote: deploy at one lane, warm the new snapshots, then raise the live cap with `update_autoscaler(max_containers=4)`. |

Fish also has a WebSocket `/v1/tts/live` for LLM token streaming; Echomancer does
**not** proxy it — previews and listen already have full text, so HTTP chunked
streaming is enough and fits serverless.

### `GET /api/tts/voices`

Returns `{ voices, listenVoices, source, openRouterConfigured, researchPreview, slimCatalog, … }`
with optional price/ETA when `charCount` is passed. App ships a slim catalog
(Andrew, Echomancer Andrew, Ava, Libby, Ryan + session clones). Clara, Randolph, and Michelle are not listed. The Andrew card keeps catalog id `standard`.

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
// Edge stock (standard / michelle) → edge adapter, unless provider is already fish
// Clara / curated Fish stock → fish adapter (with reference_id)
// provider google / Neural2 → refused. Stored audio is not spoken again.
// Fish clones + leftover Fish catalog models (when FISH_API_KEY) → fish
//   legacy fish-narrator omits native reference_id; clones send it
// if OPENROUTER_API_KEY → openrouter adapter
// else direct gemini / grok
```

### `src/lib/tts/providers/edge.ts` + `src/lib/tts/edge-tts.ts`

**Andrew / Ava** path. Talks to Microsoft Edge’s undocumented Read Aloud
websocket (`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`)
with a `Sec-MS-GEC` token — the same protocol as current Python `edge-tts`.
No Azure Speech subscription. Output is MP3. Voice id is `en-US-AndrewNeural`
(Andrew) or `en-US-AvaNeural` (Ava). Handshake must pin Chromium
full `143.0.3650.75` → `Sec-MS-GEC-Version=1-143.0.3650.75` (`.96` hangs with
no `turn.end`), query order `TrustedClientToken`, `ConnectionId` (lowercase
hex), `Sec-MS-GEC`, `Sec-MS-GEC-Version`, and Cookie `muid=<32 hex uppercase>;`.
Node `ws` delivers text frames as `Buffer` with `isBinary=false` — classify
those as text so `Path:turn.end` ends the turn. Treating them as audio drops
the terminator and hangs `/api/tts/preview` until the 30s isolate timeout.
After the handshake, 25s with no frame (`EDGE_INACTIVITY_MS`) closes the
socket and throws retryable `Edge TTS stalled`. A total cap
(`edgeStreamBudgetMs`, 45s–5min, about four times speech at 15 characters a
second; a 4,000-character section lands on the 5 minute ceiling) does the
same when frames keep arriving forever. The error is pushed before `close`,
so a synchronous `turn.end` from that close cannot accept a partial take.

**Section chunking (`synthesizeEdgeTts`):** whole-book sections are split
into ~1,000–1,500-character chunks at paragraph (then sentence, then
whitespace) boundaries before synthesis (`splitEdgeText`; `chunks.join("")`
reproduces the trimmed input). Up to `EDGE_CHUNK_CONCURRENCY` (4) chunk
sockets per section speak in parallel under a shared `edgeSocketSlot()` gate
(`TTS_EDGE_SOCKET_CONCURRENCY`, default 32 process-wide). Each chunk has its
own inactivity clock (22s) and total cap (`edgeChunkBudgetMs`, 45s–240s), and
up to 3 attempts with ≤2s backoff — a stalled or failed chunk re-speaks only
itself, not the section. Turn MP3s are concatenated in claim order; each
turn's leading ID3v2 tag (and any Xing header inside it) is stripped except
the first (`edgeId3TagLength`), so the joined file has one header and no
metadata frame mid-stream. The streaming path (`streamEdgeTts`) still
emits one provider stream and is unchanged.

**Reliability / ToS:** Microsoft can change headers, rate-limit, or shut the
consumer endpoint down. This is not a contractual API. If synthesis starts
failing with handshake 403s or a hang, update `Sec-MS-GEC` / Chromium full
version in `edge-tts.ts` to match current `edge-tts` (`constants.py`) or
replace the adapter with paid Azure Speech.

### `src/lib/tts/browser-speech.ts`

The picker plays a committed recording of `PREVIEW_TEXT` for Andrew, Echomancer
Andrew, Ava, Libby, and Ryan (`public/voice-previews/<id>.mp3`: `standard`,
`echomancer-andrew`, `ava`, `libby`, `ryan`). The page preloads those five
files. `POST /api/tts/preview` returns the same bytes and does not call
Edge. A missing file falls through to browser speech, then live synthesis.
Clara's old id plays Libby's file. Randolph's old id plays Andrew's. Fish clones
still use `GET /api/tts/live`.

### `src/lib/tts/providers/openrouter.ts`

| Function | Role |
|----------|------|
| `listOpenRouterSpeechModels()` | `GET /models?output_modalities=speech`, ~10 min cache |
| `synthesizeOpenRouter` | POST `/audio/speech`; Gemini → PCM; others → MP3; `instructions` **only** for `openai/` models |
| `streamOpenRouter` | Same endpoint, streamed body |

**Do not** send a separate OpenRouter `prompt` for Gemini — empty PCM incident.

### Direct fallbacks

- `gemini.ts` — Google `generateContent`, L16 PCM → WAV wrap
- Google Cloud TTS is removed. Stored Randolph audio stays on the job and is not rewritten.
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
| `highPassPcm` | 2nd-order high-pass (~80 Hz) rumble cut |
| `cleanupCloneSample` | WAV → mono PCM → 80 Hz high-pass → re-wrap WAV. No gate, no denoise. **mp3/m4a/ogg/webm passthrough** |

Fish `enhance_audio_quality` is always on. The browser trims silence and sets about −20 LUFS before upload. This pass is only the 80 Hz high-pass.
into the clone. Browser-side trim/transcode can come later.

### `src/lib/tts/clone-sample-quality.ts`

Hard bar on clone samples so phone-in-a-room refs are rejected **before**
Fish `POST /model`. Cleaning tools (Adobe / Resemble / DeepFilterNet) do not
rescue baked-in echo — the UI tells people to re-record.

| Export | Role |
|--------|------|
| `evaluateCloneSampleQuality(metrics)` | Pure decision. Inject precomputed metrics in tests (Sep 2026 calibration: phone 2.4s / cleaned 1.2s fail; Wolfe 0.62s / studio2 0.43s pass). **SNR is never a hard fail.** |
| `CLONE_SAMPLE_QUALITY_THRESHOLDS` | 10–180s; `clip_frac > 0.001`; `speech_frac < 0.25`; speech level outside −45…−8 dB; `rt60 > 0.95` fail / `> 0.75` warn; `reverb_proxy > 0.40` and RT60 unknown or `> 0.75` → `echo_in_speech` |
| `measureCloneSamplePcm` | Frame RMS, clip fraction, decay-fit RT60, late/early reverb proxy |
| `analyzeCloneSampleBuffer` | `clone-sample-quality-analyze.ts` — 16-bit WAV only (server). Compressed → `null` (browser Web Audio checks those) |
| `analyzeCloneSampleFile` | Client `AudioContext.decodeAudioData` → same decision module |

JSON: `{ ok, verdict: pass\|warn\|fail, headline, primary_message, user_action, fails[], warns[], metrics }`. Fail headline: “Too much echo to clone.” Primary action: record again; cleaning won’t help. Warn still creates the clone. The browser “Muffled or noisy” warning (`energy_hz_95` / speech-background gap) is gone: it fired on clean clips and did not predict a worse clone.

### `src/lib/tts/reference-quality/`

Worker-side gate on the uploaded sample, before Fish. Thresholds live in `config.ts` and are calibrated against real Fish S2 output (`docs/clone-quality-gate.md`). Do not retune them from reference metrics alone.

| Piece | Role |
|-------|------|
| `POST /reference-quality` | Worker route. Bearer `WORKER_SECRET`. Body `{ uploadId, samplePath, remasterFailing? }`. Scores the stored sample (~1.2 s). |
| `evaluateReferenceQuality` | DNSMOS SIG below 2.0 → echo. Speech energy 4–8 kHz vs 0.3–4 kHz below −45 dB (and at least 4 s of speech) → phone band. Min likeness between 4 s windows below 0.55 → two voices. Pitch spread under 2.0 semitones is a logged soft note only. |
| `requestReferenceCheck` | Vercel asks the worker. Returns null (clone proceeds) when `REFERENCE_QUALITY_GATE=0`, the worker or models are missing, or the call fails. |
| UI | 409 `SAMPLE_RISKY` keeps the upload pending. Amber notice: “This clip may not clone well.” / “Try a cleaner clip.” / one issue line. Actions: “Choose another clip” (copper underline) / “Continue anyway” (`acceptQualityRisk`). |
| Remaster | Only after Continue anyway, and only for echo. One DeepFilterNet pass (~8.5 s). Kept when remastered SIG ≥ 2.5 and higher than the original. |
| Runtime | `onnxruntime-node` is **not** a `package.json` dependency. `scripts/install-reference-quality.sh` (also called from `install-oracle.sh`) installs it into `.reference-quality-ort` and `deep-filter` at `/usr/local/bin`. Models: `models/reference-quality/`. Root runs the script without `sudo`. |

### `src/lib/tts/audio-guard.ts`

| Export | Role |
|--------|------|
| `isEmptyOrSilentAudio(buf)` | Too short, empty WAV data chunk, all-zero payload, tiny MP3 stub, or HTML/JSON error body |
| `isEmptyOrSilentStreamPayload(bytes, sawNonZero)` | Stream equivalent |
| `hasNonZeroByte` | Live stream early-exit from buffering |

Applied on **preview**, **take-home sections**, **stream windows**. Silence is
never stored as a successful segment and never advances the stream cursor.

### Clone squeak guard

Off unless `TTS_SQUEAK_CHECK=1`. Joel labelled 20 excerpts from real Fish
jobs: none had a squeak, including the 10 the spectral detector flagged
(0/10 true positives). The notch was cutting normal speech, so the worker
does not detect or repair. With the flag, `squeak-guard.ts` still finds a
short isolated tone and `section-squeak-guard.ts` notches those milliseconds.
`TTS_SQUEAK_REGENERATE=1` restores the old whole-section retake.

### Split / window size

| Module | Role |
|--------|------|
| `speakable-text.ts` → `toSpeakableText` | Strip unspeakable tokens + academic cover; restore headings / paragraph breaks |
| `normalize-speakable.ts` → `normalizeSpeakableText` | Footnotes, editorial brackets, ALL-CAPS titles; lone Roman lines become `Chapter II` headings; square brackets kept in the frozen speakable; Fish synthesis turns them into parentheses |
| `narration-script.ts` → `toFishNarrationScript` | Fish `[break]` / `[long-break]` IR at synth time (Fish / Edge / Google) |
| `narration-script.ts` | Light Fish-only emotions (Live); no book-level seminar prefix |
| `fish-s2-cues.ts` | Official S2 allowlist + sanitize / no-rewrite gate + length-scaled cap |
| `ssml-pauses.ts` → `fishPausesToSsmlBody` | Map Fish pause tags to Google SSML `<break time="…ms" />` |
| `ssml-pauses.ts` → `googleSynthesisSsmlUtf8Bytes` | UTF-8 byte length of the SSML Cloud TTS receives (pause IR + `<speak>` wrap) |
| `ssml-pauses.ts` → `fishPausesToEdgeProsodyText` | Map Fish pause tags to Edge-safe `…` / paragraph breaths (no `<break>`; Edge 1007) |
| `narration-script.ts` → `decideLongSentenceCommaBreak` | At most one mid-comma breath on sentences longer than 220 chars |
| `split-text.ts` → `packSpeakableSections` | Chapter-aware paragraph packer; optional `measure` (Google = SSML UTF-8 bytes); page-number lines are layout, not speech boundaries. When the upload's `chapters.json` matches at least half its entries against the paragraphs (searching ahead past missing ones), those paragraphs — and only those — are the chapter markers and the stored display title replaces the source line; below half, heading detection runs as before. A heading closes the open section only once it holds about 1,500 characters (`MIN_SECTION_CHARS`); a shorter chapter stays inside the section as `chapterMarks`, timed from its character offset and then from the measured section duration at finalize. The first section targets about 800 characters (`FIRST_SECTION_CHARS`) for every provider and stops at a sentence end; it does not cut a word. Live Stream packs with `skipFrontMatter: false` so `stream_cursor` stays an offset into the unstripped text. Title-page scraps, ISBN, edition, copyright, Library of Congress, and publisher lines, and one- or two-word or mid-phrase fragments, are dropped before that list. A leading copyright page is left out of the narration unless `TTS_SKIP_FRONT_MATTER=0`. Headings are main's outline. A line is removed only as a contents run (three or more short headings, reset at Book or Part, and only when a later same number has a real body), a dense Contents block (five or more bare labels with no text between entries, dropped whole with its book lines; the table's last row goes too when it continues the numbering into the first body paragraph), a short Notes copy of the same number and title, a numbered intro sentence that also has a later real chapter of that number, a short bare label inside an Index (the Index state ends at long prose or a real chapter), or a running head whose repeat is within about a page and has almost no body. A restart with a real body is kept. A same-line "Chapter 3 shows…" stays prose. A single index letter is not a roman chapter. |
| `listen-prep.ts` | Whole-book cleanup once per upload. The model returns per-paragraph edits (`drop` or `replace`); omitted paragraphs stay. A replacement that removes more than 10% of the paragraph's letters is refused and the original is kept, unless the paragraph is clutter. URLs and email addresses are not counted in that loss. Spaced-email stripping does not cross a newline. A deterministic pre-pass drops sequential page numbers, Gutenberg boilerplate, and an exact running header of at most 60 characters that sits directly above or below a page number on at least five pages. Digits are not stripped. PDF page numbers and running heads are also removed at extract time from pdf.js positions (`pdf-furniture.ts`). A repeated edge line is furniture when its y is outside the document-typical body block, measured from the modal line spacing rather than a median that includes stanza breaks. Blank pages do not set that edge, and tops that jitter by a few points still cluster. A line inside that block stays, including one extra line on a longer page. A page number that shares the page-index offset is dropped even when it sits on the last body line. An every-other-page head is not treated as a spaced chapter title. An OCR variant in a frequent head group is dropped with it. Font size keeps a line only when it is an outlier beside the other copies. Bare and numbered chapter, lecture, and letter headings stay unless that exact line repeats. A page number whose offset agrees across pages is dropped even when its box is taller than that page's body. The pass keeps only the top and bottom lines of each page. EPUB landmark hrefs resolve to a full path and match exactly; `#fragment` alone is ignored; cover and nav are never restored as a fallback. Nested typed sections, including `imprint`, are removed. A self-closing tag does not open a nest, and an unclosed drop keeps the rest of the file. A scanned PDF with no text layer is not parsed a second time. A model drop that is mostly contents rows is kept through the body-sentence cap. Chunks of about 8k tokens then go to `LISTEN_PREP_MODEL` (default `xiaomi/mimo-v2.6-flash`, reasoning off, strict JSON schema, DeepInfra then Xiaomi then GMICloud, 20s, one retry on 429/5xx). A bad JSON or schema reply uses `LISTEN_PREP_FALLBACK_MODEL` (DeepSeek via Together then DeepInfra). Long prose lines are removed from the drop before it is applied. A drop that takes most body sentences is cut back to the other lines, then shed until it is at most 40% of the chunk. A chunk is never emptied. A failed or fallback chunk is stored as partial and retried on a later pass, up to three attempts. Freeze uses a cleaned file for this source immediately. With no best-so-far it waits up to `LISTEN_PREP_PASS_WAIT_MS` (default 45s) for the other pass. If the tick cannot fit a full model pass it requeues instead of freezing a skipped or truncated clean, and it does not write a running record for that skip. It does not persist raw text. A running record does not reuse a cleaned file from an older source hash. Eight chunks per book, about 20 requests in flight on the worker. |
| `frozen-script.ts` | First take-home claim writes `speakable.txt`, `sections.json`, and a small `playback-chapters.json`. The upload's `chapters.json` is the chapter source of truth: its `match` lines are protected from the cleanup model (a protected heading is never dropped or replaced, and a cleaned file written without protection is re-run), and the outline supplies the chapter markers at pack time. A heading closes a section only after about 1,500 characters, and section 0 stays near 800 characters for every provider, including even-pack. It reuses `pdfs/<uploadId>/listen-cleaned.txt` when that record is settled. A partial clean for this source is used immediately and a retry is scheduled without blocking the freeze. With no cleaned file, freeze waits for the running pass, then cleans the book itself. If the tick cannot fit a full chunk timeout the job is requeued and nothing is frozen. Then pack for Fish / Edge / Google. Fish synthesis text has no square-bracket cues. Fish / clone even-packs to fan-out; Google packs against SSML bytes (`packProvider: "google"`); later ticks never re-split or re-clean |
| `section-size.ts` | Hosted Fish target **8000** / hard max **9200**; Google hard max **4900 UTF-8 bytes** of final SSML (Cloud TTS input ceiling is 5000 bytes — not 4500 speakable chars); Edge uses its catalog character ceiling (4,000 for Standard). Other engine defaults are OpenAI 4,000, Gemini 2,800 (3,000 for a matching model slug), MiniMax / ElevenLabs / Edge fallback / unknown 2,000, Zonos 350, Kokoro 800, and Grok 8,000; a catalog limit takes precedence. Non-Fish / non-Google engines no longer receive overflow slack past their resolved limit. Take-home passes that hard ceiling into frozen packing; Live Listen also passes the engine ceiling and Google SSML byte measure into its actual window pack calls. Oversized prose splits at hard punctuation first, then soft punctuation, then a space, then a Unicode-safe hard cut. Abbreviations and numeric punctuation are protected; tiny pieces merge with a neighbor only when the result fits the hard ceiling. `STREAM_WINDOW_CHARS = 480` for Live Listen; Whole-book Fish even-packs later sections to fan-out (`evenTakehomeTargetChars`). Section 0 is capped near 800 characters for every provider. A heading does not close a section before about 1,500 characters |

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
4. `getOwnedUploadByPath` — wrong path → 404
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

### `PATCH /api/jobs/[id]` `{ action: "rename", bookTitle }`

Owned (404 otherwise). Collapses whitespace, trims, requires 1–200 chars,
and writes `jobs.book_title`. Library cards and the player edit it inline
with a pencil; the download filename follows the new title.

### `DELETE /api/jobs/[id]`

Owned; collect audio + segment paths; delete `audiobooks/<jobId>/…`; delete
`pdfs/<uploadId>/…` **only if no sibling job** shares `pdf_storage_path`; soft
delete job; best-effort file deletes.

### `GET /api/jobs/[id]/markup`

Allowlisted operator only. Production stays off until `ECHO_OPERATOR_TOOLS=1`
(on automatically outside production). Prefer `ECHO_OPERATOR_USER_IDS`
(comma-separated `user_*` ids, never the Google subject).
`ECHO_OPERATOR_EMAILS` matches `users.email` only when `email_verified` is 1
(Google `email_verified` at sign-in). An empty allowlist qualifies nobody.
Lookup errors deny. Owning the job does not qualify. An allowlisted operator
can read **any** non-deleted job. The JSON is `toPublicFishMarkup`: job id,
title, voice, dates, and the frozen text. It does not include the owner's
email, name, or user id. Everyone else, and the flag-off case, get **404**
`Job not found`. Loads `audiobooks/<jobId>/speakable.txt` and `sections.json`
via `loadFrozenScript`. Does **not** re-tag or rebuild. JSON: frozen
`speakable`, per-section `storedText`, and for `tts_provider = fish` the exact
Fish `text` field (`fishText`, same `narrationScriptForSynthesis` call as
take-home synthesis). `?section=N` selects one window. `?format=text` on a
single section is that string alone. `MARKUP_NOT_FROZEN` when the first claim
has not written the freeze yet (operator only). Page:
`/dashboard/player/[id]/markup`. A quiet “Markup” link is rendered under the
player only for the allowlisted operator.

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

**Production Whole-book host:** an always-on Ubuntu VPS running pm2,
**not Trigger.dev**.

| | |
|--|--|
| Process | Node + pm2 `echomancer-takehome` (`src/worker/takehome-server.ts`) |
| Bind | **`127.0.0.1:8788` only** (pm2 sets `WORKER_HOST`). Never publish 8788. |
| TLS | **Caddy on the VM** terminates HTTPS for `worker.echomancer.xyz` → loopback 8788 |
| DNS | A record on **Vercel** (apex `echomancer.xyz` uses Vercel nameservers). Not a Cloudflare zone. |
| Vercel | `WORKER_URL=https://worker.echomancer.xyz` + `WORKER_SECRET` (HTTPS only) |
| Concurrency | `WORKER_CONCURRENCY=1` |
| TTS | Orchestrates Edge, Paradee, Fish, and (when pinned) Modal. Does **not** run a GPU and does **not** call Google Cloud TTS. |

The Next.js app on Vercel only enqueues. Live Listen / Live Stream stay on
Vercel. Document extract runs here in a child process (`POST /extract`);
Cloudflare is the fallback when this process is unreachable or unhealthy.
Runbook: `WORKER.md`. Docker Compose is an optional appendix.

`trycloudflare.com` quick tunnels are **not** production `WORKER_URL`.

Trigger.dev (`src/trigger/takehome.ts`) is **legacy fallback** when
`WORKER_URL` is unset or `TAKEHOME_TRIGGER_FALLBACK=1`. It is not the live
Whole-book runner.

### VM worker — `src/worker/`

| Piece | Role |
|-------|------|
| `takehome-server.ts` | Node HTTP on `WORKER_PORT` (default 8788). Production bind `WORKER_HOST=127.0.0.1`. `GET /health`, `GET /ready`, `POST /jobs`, `POST /extract`. Drain interval. |
| `takehome-loop.ts` | Per-`jobId` inflight set + `WORKER_CONCURRENCY` (default **1**). Calls `runTakehomeUntilSettled`. |
| `takehome-http.ts` / `auth.ts` | Bearer `WORKER_SECRET` (or `INTERNAL_JOB_SECRET`). |

Turso is the queue. No Redis / BullMQ. Cancel and leases are the existing
`jobs` row fields. Runbook: `WORKER.md` (VPS + pm2 + Caddy).

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

**Deprecated for production.** `takehome.advance` still imports
`runTakehomeUntilSettled` in-process and is only a fallback when
`WORKER_URL` is unset or `TAKEHOME_TRIGGER_FALLBACK=1`. `takehome.drain` in
this repo has **no cron** and its run does not claim jobs. The task still
deployed on Trigger.dev is older: it runs every minute, lists `queued` rows,
and claims `queued` / `processing`. Turn that schedule off in the Trigger
dashboard — editing this file does not stop the live task. Jobs parked
`waiting` do not match that claim. A `queued` take-home whose text is
already ready can still be claimed until the dashboard schedule is off.
Extract tasks in `src/trigger/extract-upload.ts` are no-ops.

`TTS_POLL_NUDGE_BUDGET_MS` code default is **0**, and production is reported
at 0. At 0, neither poll synthesizes. They are not the same write:

- `GET /api/jobs` (library) calls `nudgeStaleTakehomeJobs`, which always runs
  `releaseExpiredTakehomeLeases` when the page contains a take-home that is
  not `ready`, then returns without a wave.
- `GET /api/jobs/[id]` (player) calls `nudgeStaleTakehomeJobIfNeeded`, which
  returns immediately at budget 0 and does not sweep.

Lease reclaim for a live book belongs to the VM drain. A non-zero budget is
the old Hobby path that also synthesizes; do not turn it on in production.

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
Edge, Fish, Paradee, and clone jobs freeze the cleaned speakable, then
`packSpeakableSections` (chapter heading > paragraph > sentence; page-number
lines are layout, not speech boundaries). Later ticks load that pack and
never re-split, except one clone case: an outline whose longest section is
wider than one GPU call, and which has no ready section yet, is re-packed
once (`frozenTooWide` in `process-job.ts`). A stored Google / Randolph job
never reaches the packer. `parkStoredGoogleJob` marks a finished file
`ready` and stops an unfinished one. The SSML byte packer
(`googleSynthesisSsmlUtf8Bytes`, hard max 4900 bytes under Cloud TTS's
5000-byte ceiling) remains in `frozen-script.ts` and is covered by
`google-ssml-budget.test.ts`. No production caller passes
`packProvider: "google"`.

Hosted Fish windows target **~8000** characters (hard max **9200**). Fish
**even-packs** so parallel workers get similar slices: fewest waves that fit
under the hard max, then `ceil(chars / (waves × fanout))`, floored at
`FISH_EVEN_PACK_MIN_CHARS` (1500) and capped at `FISH_TARGET_CHARS` (8000).
A short tail after a full wave of 5 is folded into the previous section when
it is the same chapter and still under the hard max. Clone books do **not**
even-pack. `evenFanout` is set only for `providerId === "fish"` when the
voice is not a Modal clone. Clone section width is
`min(model max, modalCloneSectionChars())`, code default **2,000**
(`MODAL_S2_SECTION_CHARS`). A row renders its units in sequence, so a ~7,700
character section does not fit the placement budget. That is what froze
`job 7e4a8b48`. Edge stays on catalog character limits and
`edgeGoogleTakehomeTargetChars` (`ceil(chars / 8)`, floor 1,500, cap the
catalog max). Section 0 is capped near 800 characters for every provider,
including even packing, so the first audio is about a minute (Live Listen
still uses ~480-character windows). Later sections stay near the even target
on the Fish path, and near the 2,000-character cap on the clone path.
A chapter heading does not close a section until the open one holds about
1,500 characters; a shorter heading is a `chapterMarks` offset inside the
section, and finalize times it from that offset. A leading copyright,
ISBN, or Library of Congress page is left out of Whole-book narration unless
`TTS_SKIP_FRONT_MATTER=0`. A rights-and-imprint paragraph ("All rights reserved.
Printed in…") is still a notice when it is long enough to look like prose.
Live Stream does not strip that page. Existing `sections.json` keeps its layout until
a new Make (or freeze deleted). Freeze logs
`evenFanout`, section count, target, `first`, and `max`. A mid-size book
shows a short `first` and a `max` near the target.

Work is claimed as a **set of indexes**. Each synthesis call is bound to one
index before the request and writes only `sections/NNNN.mp3` for that index.
`segments_json` is a map `{ index, path, status }` upserted by index — never
appended in completion order. `next_section_index` = lowest index not yet
claimed. Ready-count (progress / `current_section`) is a different number.
Concat walks `0..N-1`. A bad section is `retry`/`failed` for that index — it
does not `failJob` the whole book on the first miss. After the last index,
hole-retry runs once. Assembly then requires **every** index
(`allIndexesReady`). A book with holes is published `failed`, not `ready`.
`error_message` is
`"${missing} of ${total} sections could not be narrated. Only ${done} … so it is not a complete audiobook. Retry to generate the rest."`
`progress` stays under 100. `warning` is also set to
`"${holes} section(s) could not be narrated; the rest of the book is ready."`
That warning string is historical wording. The status is `failed`, so
library and download treat the book as unfinished. `download_url` is minted
only when `status === "ready"` (`src/lib/jobs/direct-download.ts`). Section
objects are not deleted.

The old rule accepted `mostIndexesReady` (more than half) or `doneCount > 0`.
That is how `job 75944dc9` shipped `ready` with 5 of 11 sections. Measured on
that job: wall clock about 32 s, because the allowance refused the pool
before any Modal request; the file that existed was about 510 s of audio
(about 8:30) against a source of about 1,069 s; the five successful sections
were byte-identical to older cached takes; the source text was about 17,021
characters and the refusal counted 17,022 requested against 492,425 already
used that day. The row was not rewritten by #247 or #248.

Auto-advance skips a missing section only when `job.status === "ready"`
(`nextIndexAfter` → `nextPlayableIndex` with `skipUnavailable`). A book this
code publishes as `failed` does not skip, so playback stops at the hole.
An older row that is already `ready` with a hole still skips, because its
status was not changed. While a book is `queued` or `processing`, order is
preserved and a section that is merely still rendering is not skipped.

The first take-home claim takes up to `min(fanout, TTS_SECTIONS_PER_TICK,
ceiling, remaining)` indexes starting at 0. Direct Fish uses the account
fan-out (4, or 5 when idle) and ceiling 5, so `TTS_SECTIONS_PER_TICK=8` does
not raise Fish past 5. A Modal clone's fan-out is `modalCloneLanes()` (code
default 4, `MODAL_S2_SECTION_CONCURRENCY`, max 8). The tick claims toward
`modalCloneBatchSize()` (code default 24), because one GPU call decodes every
row together. Paradee uses `paradeeFanout()` (code default 3). Edge runs a
**rolling pool** instead of one batch per claim:
the tick's lanes claim the next claimable index (`nextClaimableIndex`, with
skips for in-memory claims) the moment a slot frees, so one stalled section
no longer parks the lanes behind it. Concurrency is
`TTS_EDGE_GOOGLE_SECTION_CONCURRENCY` (default 8, max 16). With a tick
deadline the pool keeps claiming until the deadline (`shouldStop`); with no
deadline the per-tick claim budget stays at the provider fan-out so a
deadline-less worker cannot run away. Claims are in-memory; each finished
section writes `segments_json`, so a restarted worker re-claims only the
unfinished ones. Direct Fish keeps the batch barrier and uses `withFishSlot`.
Clone calls use `withCloneBatchSlot`, not the Fish account slot. An Edge 429
or 503 halves that in-flight cap for the rest of the process and the section
still uses the existing retry backoff. Each finished section is checked while
the rest of the wave continues. Transcription defaults to self-hosted Whisper
(`TTS_QA_PROVIDER` unset or `local`, `scripts/whisper-qa.py`, `faster-whisper`
`base` int8 on CPU). `resolveSttProvider` maps an unrecognised value to
`local`, never to the paid endpoint. `TTS_QA_PROVIDER=deepgram` selects hosted
`deepgram/nova-3` through `OPENROUTER_API_KEY` (the old 5 s wall cap and the
DeepInfra price-route of `openai/whisper-large-v3-turbo` belong to that opt-in,
not to the default). `TTS_QA_PROVIDER=off` or `TTS_SECTION_QA_ENABLED=0` skips
the check. Local transcription is capped at `audioSeconds × 0.4` wall (10 s
floor, 180 s ceiling) via `TTS_QA_WHISPER_BUDGET_MS`. Duration is read from
the MP3 or WAV bytes in process. A repeated or missing run of 6+ words, word
error over 15%, or duration more than 25% off the calibrated rate regenerates
that section once, then splits at the nearest sentence and keeps the
lower-error take. A transcript error, or a wait past the cap, keeps the audio
and does not stop the book. When no transcriber can run, the worker logs the
reason once (`qa skipped: whisper sidecar missing` or
`qa skipped: deepgram needs OPENROUTER_API_KEY`) and finishes the book. The
old line `qa skipped: no provider` is not what the current selector logs.
Section 0 of a Modal clone is published before this check; later sections are
checked. The section 0 take is not replaced afterwards. An earlier
`prioritizeZero` path claimed only `[0,1]` so the player could start after
one Fish round-trip; that starved parallel workers and is no longer the
default. `/health` `concurrency` is `WORKER_CONCURRENCY` (books in flight),
not this section fan-out.

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
model + latency + speed + chunk length + variant. The variant is
`takehomeCacheVariant` (`process-job.ts`). For a Modal clone that is
`s2-pro-modal-` plus `cloneNarrationRecipeId()` — currently
`u560-m260-p220-400-960-a1`. A deploy id or git SHA is deliberately not in
the key. The harness leaves the cache off unless `TTS_SECTION_CACHE=1`.
Production leaves it on. A retry of the same text, voice, latency, and recipe
hits. `normal` vs `balanced`, and two narration recipes, do not collide.
Existing cache objects were not deleted when the recipe id changed, so an
old key is simply a miss.

### `src/lib/tts/process-job.ts` — the heart

Env knobs (defaults):

| Env | Default | Meaning |
|-----|---------|---------|
| `TTS_LEASE_TTL_SECONDS` | 90 | Lease lifetime |
| `TTS_SECTIONS_PER_TICK` | fan-out | Max claim set per tick; with a tick deadline, the Edge/Google rolling pool keeps claiming until the deadline instead (no deadline keeps this budget) |
| `TTS_EDGE_GOOGLE_SECTION_CONCURRENCY` | 8 | Edge/Google sections in flight (1–16). Fish ignores it. Halves on 429/503. |
| `TTS_WORKER_WAVE_BUDGET_MS` | 240000 | Vercel fallback wave clock |
| `TTS_TRIGGER_WAVE_BUDGET_MS` | 900000 | Trigger Cloud wave clock |
| `TTS_VM_WAVE_BUDGET_MS` | 900000 | Always-on VM wave clock (falls back to Trigger knob) |
| `TTS_TAKEHOME_FANOUT` | 4 or 5 | Fish/clone pin; else 4 if live in flight. Does not raise Edge/Google. |
| `TTS_MAX_TICKS_PER_WAVE` | 40 | Safety cap |
| `TTS_CRON_JOBS_PER_RUN` | 3 | Fallback cron batch |
| `TTS_POLL_NUDGE_BUDGET_MS` | 0 | UI poll synth budget; `0` = read-only |
| `TTS_RETRY_BACKOFF_MS` | 1000 | Between section attempts |

| Function | Role |
|----------|------|
| `claimTakehomeLease(jobId)` | Atomic UPDATE to `processing` + new token **only if** no active lease |
| `heartbeatLease` | Extend expiry while holding token. After the wave deadline, renews while a section is inside its lifecycle cap (`shouldRenewTakehomeLease`): synth, retries, master, upload, segments write. Cap is every attempt budget plus `SECTION_MASTER_LEASE_MS` (3 min). Mastering narrows the window to that 3 min |
| `writeWithLease` | Progress UPDATE … AND token = ?; 0 rows → `LeaseLostError` |
| `releaseLease` | Clear token; set queued/failed |
| `releaseInFlightTakehomeLeases` | Shutdown: same UPDATE as `releaseLease` for tokens this process still holds, status `queued` |
| `processTakehomeTick` | Claim → heartbeat → `runClaimedTick` → cleanup |
| `runClaimedTick` | Load frozen `sections.json` (rebuild once if missing, or once when a clone outline is wider than a call and nothing is published) → claim index set → synth bound per index → one bad section is `retry`/`failed`, not an immediate `failJob` → hole-retry → assemble only when nothing is still claimable. Every index ready → `ready` at progress 100. Any hole → `failed`, progress under 100, audio kept |
| `synthesizeSection` | Fish script tags; cache lookup; section 0 `balanced`, later `normal` + `chunk_length` 300; 429 waits; reject silence. Each attempt passes `AbortSignal.timeout(sectionAttemptBudgetMs)`. Fish is ~10 chars/s plus 60s, and the signal is created after `withFishSlot` acquires the slot. Edge is `edgeSectionBudgetMs` (chunk waves plus `EDGE_SECTION_SLACK_MS`, no extra multiplier; inactivity 22s, per-chunk cap 45s–240s). Google Cloud TTS is not synthesized |
| `runTakehomeWave` | Loop ticks until done/busy/error/budget/max ticks |
| `runTakehomeUntilSettled` | VM host (legacy Trigger host too): waves until terminal. After a wave, if another take-home is `queued`, lease-expired `processing`, or `waiting` with an upload already `ready` or `failed`, returns `yielded` so the drain can run the oldest runnable job. A `waiting` job whose file is still being read does not take the turn. Does not open a second job lane (ffmpeg mastering is CPU-bound on the one VM) |
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
| `concatReadySegments` | In-memory fallback (tests, Vercel without ffmpeg, custom remux). WAV → PCM crossfade; MP3/Ogg → ffmpeg remux. **Never** `Buffer.concat` compressed frames. Missing ffmpeg fails assemble or ships `sections.zip` |
| `materializeFullAudiobook` | When ffmpeg is available and there is no custom remux/enhance, `stream-finalize.ts` builds `full.mp3` on disk and uploads it as a stream. The in-memory path remains for hosts without ffmpeg |
| `isSectionStoragePath` | Detect `/sections/` vs full artifact |
| `crossfade-audio.ts` | `CROSSFADE_MS_DEFAULT` **120** (clamp 80–150). `TTS_CONCAT_CROSSFADE_MS=0` disables. Live Listen never joins. |

Production finalize (`src/lib/tts/stream-finalize.ts`) never holds the
book. Each section is downloaded into `ECHOMANCER_SCRATCH_DIR/<jobId>`
(default `os.tmpdir()/echomancer/<jobId>`), decoded to 44.1 kHz mono
s16 WAV, then deleted. Edge silence (320 ms cap, 40 ms kept) and the
equal-power crossfade (120 ms paragraph, 12 ms mid-paragraph) run on
those edge windows only. ffmpeg's concat demuxer streams the bodies
plus the tiny mix WAVs through the same podcast chain. `full.mp3` is
uploaded with `uploadFileFromPath` (PutObject stream under 8 MB,
multipart 8 MB parts above that). The scratch dir is removed in
`finally`. A failed stream returns null and does not fall back into a
whole-book PCM buffer. Startup and a periodic sweep delete scratch
dirs older than `ECHOMANCER_SCRATCH_MAX_AGE_HOURS` (default 24).

Disk during finalize is about **320 MB per hour** of 44.1 kHz mono s16
(the section WAVs) plus the output MP3. Peak RSS stays in the low
hundreds of MB. DeepFilter opt-in writes `joined.wav` first (another
~320 MB/hour) and then the chunked DFN pass. ffmpeg 4.4+ is required
(`deesser`, `loudnorm`, concat demuxer); Ubuntu 24.04 apt is 6.1.

The in-memory path remains for tests and for Vercel (no ffmpeg). It
uses the same trim and equal-power crossfade on a PCM buffer. Byte-glue
is disabled. Live Listen / Live Stream never concatenate stored sections.

### Whole-book mastering (VM worker)

After concat, `full.*` is uploaded. The job is marked **ready** only when
every section index is ready. A partial assembly is marked **failed** and
does not receive `download_url`. Multi-section MP3/Ogg already carries the
delivery chain, so
`applyFullBookMastering` (`src/lib/tts/mastering.ts`) skips a second
encode. It still runs for a raw single section, a WAV join, or DeepFilter
opt-in, and may overwrite the same object — never per section, never on
Live Listen / preview / clone POST. Make→ready does not wait on that
second pass. Cue tags are already applied at speakable freeze; this pass
does not retag.

| | |
|--|--|
| Recipe | Two chains, chosen in `prepareSectionForStorage` (`src/lib/tts/section-master.ts`). **Stock** (Edge, Fish, Paradee): `masterPodcastFiltersAf` — highpass 80 Hz (2 poles), wide −1.8 dB at 280 Hz, +1.6 dB at 3.4 kHz, light `deesser` (i=0.4), then `loudnorm` `I=-16` `TP=-1.5` `LRA=11` (`MASTER_LOUDNORM_*`). **Modal clone** passes `"s2"`: the container already applied `S2_SPECTRAL_CHAIN` (highpass 70 Hz, cuts at 190/430/3400/6800 Hz, +5 dB at 8 kHz, lowpass 15.5 kHz). The app then loudnorms to `I=-19` `TP=-3` `LRA=11` (`MODAL_S2_MASTERING`). That is not the −16 podcast pass. The loudnorm pass is measured and applied linearly. ffmpeg and ffprobe are asynchronous, and ffmpeg in flight is capped at the CPU count, so one section does not freeze the other sections' QA. Encode **44.1 kHz mono 128 kbps** MP3 (`-reservoir 0` so a later cut can land on a frame). Finish downloads the mastered sections together and packet-copies those files. The splice search stops once a frame is comfortably quiet, and those short ffmpeg calls are not held behind the section-master CPU cap. Each join re-encodes only the crossfade window (the fade plus a short lead-in, under about two seconds) and byte-appends it; the section bodies are `-c copy`. A splice is kept when its sample step stays under seven times the p99 beside it. 128 kbps mono is the clean spoken-word rate; 64 kbps smears the presence lift. A section without `mastered`, or any mix with an older section, still takes the full-book encode. If the sections were already mastered and the join fails, finish encodes the crossfade with no second loudnorm. Frame positions are read from the MP3 headers (a per-section ffprobe crowd timed out a 1,297-section book at 60s). A section under four seconds is re-encoded with the same crossfade into the next section, or into the previous section at the end of the book, and the rest of that neighbor is still packet-copied, so one heading does not send the book through the full encode. The fallback encode is capped to the decoded sample count, and a full file that already uploaded is not marked failed when the lease is gone. `TTS_SECTION_MASTER=0` forces the full encode. DeepFilter opt-in does too. |
| DeepFilter | **Off by default.** Opt in with `TTS_MASTER_DFN=1` (wet `MASTER_BLEND_ENHANCED` 0.4) and/or `TTS_MASTER_DFN_WET>0`. Explicit `TTS_MASTER_DFN_WET=0` skips DFN even if `TTS_MASTER_DFN=1`. Missing `deep-filter` still runs the ffmpeg chain. Long books are DFN-chunked (`MASTER_DFN_CHUNK_SECONDS`) only when DFN runs. |
| Host | Always-on VM (`WORKER=1`). Legacy Trigger.dev if that path is still enabled. `VERCEL=1` always skips. Enabled when `WORKER=1`, `TRIGGER=1`, `TTS_MASTER_FULL_BOOK=1`, or `DEEP_FILTER_BIN` is set. |
| Binaries | Ubuntu `ffmpeg` (required). Rust `deep-filter` 0.5.6 stays installed on Ampere (`aarch64-unknown-linux-gnu`, SHA-256 pinned in `install-oracle.sh`) for the opt-in path. Dockerfile musl pin is the Docker/Trigger appendix. |
| Worker | `src/lib/tts/mastering-worker.ts` — `child_process` spawn only; dynamic `webpackIgnore` import |
| Fail-open | DFN/ffmpeg errors log and ship the dry concat. A finished book never fails because enhance crashed. |
| Skip | Tiny duration (`MASTER_MIN_DURATION_SECONDS`), `alreadyMastered`, `TTS_MASTER_SKIP=1` |

Vercel `GET /api/jobs/[id]/download` backfill calls `materializeFullAudiobook`
without the VM host flag, so it uploads dry concat if it has to.

### Direct download link — `src/lib/jobs/direct-download.ts`

`GET /api/jobs` and `GET /api/jobs/[id]` add `download_url` to a **ready** job
whose `audio_storage_path` is a full file (not a section): a presigned R2 URL
that answers `Content-Disposition: attachment; filename="<title>.mp3"` and
`application/octet-stream` itself. Library and player pass it to
`startAudiobookDownload`, so a 50 MB–3 GB book saves straight from R2 without
a Vercel function. It is a direct cross-origin link, not a redirect (the
redirect is what browsers dropped in PR #92); browsers ignore the `download`
attribute cross-origin but honour the attachment header. No `download_url`
(still generating, local dev, kill switch, presign error) keeps the route
below.

### `GET /api/jobs/[id]/download`

Fallback when a job has no `download_url`. Owned. When `full.*` (or another non-section artifact) exists, the handler
**streams that object as 200** with `Content-Disposition: attachment` and
`Content-Type: application/octet-stream`. It does not 307 and it does not
buffer the file (`openDownloadBody`). Desktop Chrome, Edge, and Firefox
ignore `<a download>` when the response is a redirect, so a redirect never
starts a Save As. Else concat on the fly with `Content-Length` and the same
attachment headers; optional async backfill if a ready job still points at
a section path.

### `src/lib/download-client.ts`

`startAudiobookDownload` clicks an `<a download>` inside the tap (the R2
`download_url` when it still has more than a minute left, else the same-origin
download route). An expired signature is not sent through that route: the
function time limit would cut a multi-GB file. The library and the player
refresh `download_url` when the tab returns and every 30 minutes, and a
refused click asks for another tap after that refresh.
It does not `fetch` the book into a blob. Desktop leaves `target` empty so
the browser saves the attachment in this window. iOS sets `target="_blank"`
so Safari can open the attachment and offer Share → Save to Files. Library
and player show no toast for it; on iOS a quiet line under the title says to
save from the share menu. Job status and action errors (start, retry, cancel,
delete, playback) are likewise shown inline on the book, never as toasts.

---

## 21. Pricing & ETA

### `src/lib/tts/pricing.ts`

- COGS: `usdPerAudioHour` **or** `usdPerMillionChars` **or** fallback $15/M
- Retail: `cogsUsd * FX * markup + fixedEur`, floor `TTS_MIN_PRICE_EUR`, round to .49/.99
- `streamMaxChars()` from `STREAM_MAX_AUDIO_SECONDS` × chars/min (~54k default)

### `src/lib/tts/eta.ts`

`computeJobEta(input, prev?)` → `{ seconds, label, state }`. The live rate is
**this job's** sections finished since `first_section_at` (written on the first
ready segment; `last_section_at` on every one), so queue and warm-up are not
mistaken for throughput. Parallelism is implicit in that rate; the heuristic
fallback divides by an explicit `fanout` (default 1) — never an assumed 4.
Remaining work is section count, or character-weighted when per-section sizes
are known. Every ETA adds a finalize estimate (15s + 2s per 10 finished
sections, capped 10 min), so a fully narrated job shows `finalizing` with a
non-zero value while concat/mastering runs. Silence past 2× the mean section
interval adds the excess (capped 30 min) so stalls grow the estimate instead of
freezing it. `Estimating…` until 3 sections and 30s of measured throughput.
`prev` counts the previous value down by elapsed time, blends at α 0.3, then
clamps the change to ±25%. `serializeJob` exposes `eta_seconds`, `eta_label` and
`eta_state`; the library card and the player both render that server label
(`etaLabelSuffix`) and compute no ETA of their own. Stream jobs carry no section
ETA.

### `src/lib/tts/premium.ts`

`PREMIUM_HD_ENABLED` or allowlist IP/userId. `isHdVoice` via minimax / speech-02 /
`hd` tag.

---

## 22. Frontend surfaces

### Landing — `src/app/page.tsx`

Client format/size check → `uploadBookFile` (`src/lib/upload-client.ts`:
presign JSON → PUT to R2 → complete) **or** paste →
`POST /api/text/upload` → redirect. Document extract keeps running on
the Node worker, with Cloudflare then Vercel as fallbacks; landing does **not**
wait for `ready`. Voice pick and sample play are available as soon as the
upload id exists. One `waitForUploadExtract` poller runs on the voice step
(`UX.preparingText`) and retries a dead poll with backoff. **Make audiobook**
`POST /api/jobs` queues a take-home while extract is still running and opens
the player. A stream still requires `uploads.status = ready`
(`TEXT_NOT_READY` 409 while extracting).

Landing chrome is quiet: native buttons, inputs, and a thin underline tab.
Copy lives in `LANDING` (`src/lib/ux-copy.ts`): title, Upload / Paste,
Text / URL, primary CTA. No hero essay, format tip, or feature grid.

```
/dashboard/voice?pdfPath=…&pdfName=…&uploadId=…&charCount=…
/dashboard/voice?…&path=standard|clone
```

`/privacy` (`src/app/privacy/page.tsx`) is the consumer privacy statement
(uploads, clones, anonymous cookie, Google profile, R2 / Turso, deletion,
no sale, and that book text is sent to third-party AI for cleanup, tagging,
and narrator suggestions). Copy is `PRIVACY` in `ux-copy.ts`. The link sits in the right
corner of the landing and dashboard footers, at low opacity.

### Voice — `src/app/dashboard/voice/page.tsx`

- The Voices tab opens on Andrew, Echomancer Andrew, Ava, Libby, and Ryan. The heading is
  **Voice**. Each row’s preview plays with one tap, with or without an upload.
  A tap, or **Make audiobook** with no book, writes `ec_stock_voice_pick`. After
  upload or paste that id stays selected; the narrator suggestion does not
  replace it. **Clone a voice** is a row under the stock list
  (`?path=clone`, `src/lib/voice-path.ts`). It opens the clone form on the
  same screen. The stock names stay.
- When extract finishes, listen prep starts in the background (the take-home worker when `WORKER_URL` is set). `GET /api/pdf/upload/[id]/narrator` reads the cached chunk notes and returns their aggregate. It does not send the book. The Standard list shows immediately. A waiting line stays up until the suggestion arrives. It is not the Whole-book cue pass, which still runs later on the full cleaned speakable after a voice is chosen. The reply is short JSON. The matching line is marked in brackets (`Andrew (recommended)`). Articles, biography, and general nonfiction are Andrew. History is Ryan. A novel names its kind and may be Andrew, Ava, Libby, or Ryan. Clones are never suggested. The Standard list is already on screen. The suggestion fills in when the reply arrives. The suggestion pre-selects until the person taps a line. A missing key or a bad reply leaves the picker as it was. A successful reply is stored as `pdfs/<uploadId>/narrator.json`. Changed text is also stored as `pdfs/<uploadId>/listen-cleaned.txt`.
- Standard: slim stock only (Andrew, Echomancer Andrew, Ava, Libby, Ryan). Andrew is catalog id `standard`. Echomancer Andrew is `echomancer-andrew` (Paradee). Ava is Edge `en-US-AvaNeural`. Libby is Edge `en-GB-LibbyNeural`. Ryan is Edge `en-GB-RyanNeural`. Clara, Randolph, and Michelle are not listed. Each name is one tappable preview. Narration delivery prefs are not shown here.
- Clone: name, accent (American / British / Australian / Irish; default
  American), and sample. Quality-gate *errors* stay (fail blocks
  **Make audiobook**; warn does not).
  A chosen file is pending until that control clones it. That press does not
  start take-home with whichever saved clone was auto-selected. It uploads
  the sample, pins the new `catalogVoiceId`, then starts the book when
  `pdfPath` is present. With no book, the label is **Clone voice** and it
  clones and selects only. Remove clears the pending file so an existing
  clone can be used again.
- Each narrator line is the preview control (short stock
  demo — not the uploaded book). Hairline rows (not boxed cards). The
  check marks the delivery that line just previewed. Clone delete stays
  a separate control. Tapping a line dismisses a pending sample.
  After a narrator is selected, **Make audiobook**
  (or **Clone voice** while a sample is pending and no book is loaded)
  is the only continue.
  Extra bottom padding keeps it above the mobile Voices/Library tabs.
  No per-voice copper CTAs, no € / ETA chips on this step. No Live
  Stream / Live Listen labels, no listen-vs-full tabs, no page-level
  Preview that streams the document.
- `GET /api/tts/voices?charCount=`
- Play control: short sample. The five slim voices play `public/voice-previews/<id>.mp3` (preloaded). Fish / clones use `GET /api/tts/live`. A saved clone asks `GET /api/tts/clones/[id]/preview` first, which only reads storage: the current engine's take, then the other legitimate engine's take (both speak the reference Fish trained), then the legacy engine-free key that holds the pre-S2 Fish 2.1 Pro MP3s. Drama 3 has no key, so its takes can never be found. A miss is `404 PREVIEW_NOT_STORED`, and only then does the picker `POST`, which renders once on the clone's own engine with `allowFallback: false` and stores under an engine-named key. Re-playing a saved voice therefore never synthesizes, and a failed render is an error rather than a substitute voice. **The render never waits on a cold GPU.** A preview is somebody waiting on a tap inside a function Vercel kills at 60 s, whereas a book is asynchronous and may park for a snapshot restore: so `synthesizeModalClonePreview` requires `probeModalCloneWarm` to report a live container, and otherwise answers `503 PREVIEW_ENGINE_COLD` at once, spends no GPU time, and kicks a restore. The picker then re-reads storage over ~54 s of backoff instead of retrying synthesis, so once the restore lands the next request is a plain `GET`. That is the 2026-11-06 "still doesn't load for like 2 mins" fix: the old path called `provider.synthesize`, whose cold branch waits up to `MODAL_S2_COLD_WAIT_MS` (150 s) — the request died at 60 s, the GPU rendered a take nobody stored, and the next tap repeated it. `src/lib/preview-audio.ts` owns the audio element: one element for every row, and a `play()` rejected by our own `pause()` resolves as `"interrupted"` rather than a toast, which is what produced the `AbortError` message "The play() request was interrupted by a call to pause()".
- Clone sample: `uploadCloneVoice` (presign JSON → PUT R2 → `POST /api/tts/clones`)
- Next (**Make audiobook**): pending clone sample → `uploadCloneVoice`, then
  `startStockBook` (`src/lib/stock-job-create.ts`) — one `POST /api/jobs`
  bounded by 20s. The button does not wait for extract. It replaces the
  voice page with the player. A double tap returns the same queued,
  processing, or ready take-home.

### Library — `src/app/dashboard/queue/page.tsx`

- `GET /api/jobs` while any job is queued/processing **and** the tab is visible:
  5s, ×1.5 per poll where no book's status/progress/sections moved, capped at
  30s, back to 5s on a change or when the tab returns (each poll is a Vercel
  invocation)
- Cards are real links/buttons; progressbars + live regions
- Actions: cancel / retry / delete / download / listen URL selection by kind

### Player — `src/app/dashboard/player/[id]/page.tsx`

| Mode | Audio `src` |
|------|-------------|
| Stream | `/api/jobs/<id>/stream` (no seek; reconnect with `?t=` if budget remains) |
| Segments | `/api/storage/…/sections/NNNN…` (auto-advance) |
| Ready | `job.audio_url` |

Whole-book audio is `job.audio_url` → `/api/storage/audiobooks/<jobId>/full.mp3`,
which 302s to a presigned R2 URL (§11), so playback bytes come from R2. The
`<audio>` element sets no `crossOrigin` and is not routed through Web Audio
(a cross-origin source would make Web Audio output silence; R2 CORS is not
required for element playback). The job poll is
a `setTimeout` loop: streams every 10s; a generating book at 2s, ×1.5 while
nothing changes up to 20s, back to 2s on a change. A hidden tab does not poll
unless audio is playing or the player is waiting on the next section, and it
polls immediately on return. A media error on a storage URL calls `load()`
once so the same-origin path can mint a new signature, then seeks back. The element
stays mounted for the life of that URL; ±10s and the scrubber set
`currentTime` on it. `preload="auto"` lets the browser keep a forward buffer
so a short skip often does not wait on the network. A multi-minute jump is one
byte-range fetch.

**Play never trusts `audio.play()` alone.** `play()` is silent in the two
element states that actually broke the transport in production: source
selection failed (`error` set, `networkState` `NO_SOURCE`) rejects forever, and
a stalled load leaves the promise pending with no `play`/`canplay`/`error`
event. Either way the icon stayed on Play over a 0:00 clock with no notice
until a Parts row was tapped, because a row replaces `src` (or resets the
playhead) and that is what makes the browser select the resource again.
`src/lib/player/audio-start.ts` owns the decision and
`src/hooks/use-audio-start.ts` applies it: a failed element is reloaded once
and then played, a start that produces nothing audible within
`START_WATCHDOG_MS` (6 s) is reloaded once the same way, and a start that still
cannot run shows `Couldn't start this part. Try again.` instead of leaving the
button dead. `playing` — not `play` — settles the request, since `play` fires
when `paused` flips, before a byte is decoded. Our own pause or a newer load
still resolves as an interruption and shows nothing.

A queued take-home whose upload is not ready yet shows **Reading your book**
(`waiting_for_text` from `GET /api/jobs/[id]`, which also calls
`advanceStuckExtract`). Sparse chrome: Cormorant title, muted one-line status
(`Preparing audio…` / `Generating`), play with thin pause bars, ±10s skip
icons, a thin-line seek
scrubber with a ~20px thumb, a quiet **Transcript** toggle, and a speed control that starts at
**1.15×**: tap the compact label to cycle, or a small chevron to pick any
rate (`0.8` … `1.15` / `1.25` … `1.5`). One `max-w-2xl` column: transport spacing and play size
step up at `md`, and the cluster is vertically centered on desktop so it
does not read as a stretched phone. The speed list opens up on mobile
(above the tab bar) and down on desktop. Mobile uses a solid overlay so
the title does not bleed through the compact menu; desktop keeps the
player visible because the list sits below the control. No elapsed/ETA card,
volume row, or sleep timer. Extra controls stay hidden until audio
exists. Stream skip/seek is disabled. Every book also has a **Precise seek**
disclosure — a quiet `Precise seek ⌄` chevron under the clocks, closed by
default in both the inline player and focus mode. Opening it shows the
two-minute window around the playhead (`fineSeekBounds`). It never opens
itself: not on load, not for a long book, not on a scrub or a keyboard step,
which is what the old thirty-minute always-on rule did. The choice is
remembered (`ec-player-precise-seek` in `localStorage`, through
`player-prefs.ts`) and shared by both modes, so it follows the listener from
the inline bar into focus mode and back.
The window follows the playhead on a half-minute grid (`fineSeekAnchor`),
so a seek always lands inside it and playback slides it at most once a
minute; a held precise drag pins the window so the thumb cannot slip away
under the finger. The pin (and the page's drag-freeze flag) lifts on any
drag end — pointer-up, lost capture, pointercancel, or commit — because
Radix only fires `onValueCommit` when the value actually changed,
so a stationary tap or a drag that lands exactly where it started never
commits and must not leave the window or playhead frozen. There is no
blur release: Radix focuses the pressed thumb, so the other slider blurs
mid-gesture and a blur handler would wipe the state the drag just set.
The main bar is unchanged whether the disclosure is open or shut.
Polls detail every 3s while active. While a whole book is
generating, the list under the transport is numbered synthesis sections
(`Section ready`). When the job is `ready` and the frozen pack has chapter
titles, `GET /api/jobs/[id]` adds `chapters`. Finalize measures each
section's real audio length while assembling `full.mp3` (frame-indexed for
the packet-copy join, planned from the mix pieces for a full encode) and
writes `playback-chapters.json` with `startSeconds` / `endSeconds`; the
route prefers that file, and the player seeks those seconds directly.
A heading absorbed into a longer section is placed at that section's start
plus the speakable fraction of the section up to the heading.
Cue tags and stripped markup are not counted as speech. A `[long-break]`
(or a paragraph break the synth turns into one) is 700 ms, a `[break]` is
300 ms, and a tone cue such as `[soft tone]` is 400 ms. A heading within
40 characters of its paragraph start (`HEADING_SNAP_CHARS`) snaps to that
start; a topic phrase deeper in a paragraph keeps its own offset. Packed
section `charStart`/`charEnd` omit the paragraph breaks between sections,
while chapter trees are anchored in `speakable.txt`, so finalize loads
`speakable.txt` and relocates the sections into it (`relocateSections`)
before timing. If that fails it keeps the outline offsets. The same file also stores
`section-starts.json` (`sectionStarts`, `totalSeconds`) from that measured
join. The route prefers `playback-chapters.json`. When that file is missing
and `section-starts.json` is present, it times the outline from those
starts. Without either, the route falls back to `playbackChaptersFromSections`
(one row per titled chapter, as a fraction of the file: cumulative section
duration when every window has one, otherwise the heading's character offset,
which the player multiplies by the audio element's duration). That list
replaces the section list and seeks the finished file. A book with no
chapter titles keeps the section list. Stored rows may also carry an
optional `subtitle`, a `level` (`2` and deeper follow the previous
shallower row), or a `children` array of the same shape. The route passes
those fields through; a flat list is unchanged.

When a ready book has two or more places to skip, the player shows a quiet
line under the title (`Part Four · 4 of 9 · 1 h 12 m left in chapter`, or
`Part Two · The Revolution · 22 m left` inside a sub-chapter). Before the
first chapter has started the line is `Chapters · 9` (the part count), so
the list can still be opened. The line carries a small chevron and a
hairline underline. The chevron turns down while the list is open.
`aria-controls` is set only while the list is mounted, and closing the
list returns focus to that line. Tapping it opens the chapter list and
the choice is remembered on this browser. The list is a full-height sheet
on a phone, stopping at the tab bar, and a dialog there (`role="dialog"`,
`aria-modal`, labelled Chapters). Tab stays inside that dialog. From `md` up it is a
side panel, and while that panel is open the player column sits in the
space beside it. It is one scroll, not a nested box. It opens on
the current row, focuses that row, and expands only the part that holds
the playhead; other parts stay collapsed behind a 48px control. Rows are
at least 48px, titles wrap to two lines, a subtitle sits under the title
when one was stored, and the start and length sit on the right. The
current row is a heavier weight and a hairline. Previous and next sit
beside the ten-second skips. Previous returns to the current chapter when
the playhead is more than three seconds in, otherwise to the previous
chapter — a sub-chapter when the part has them. `[` and `]` do the same on
a wide screen. The scrubber draws a hairline at each top-level start and
shows the chapter name while it is dragged. A book with fewer than two
skip points shows none of this. Media Session carries the book title, the
chapter as artist, the voice as album, the playhead, and play, pause,
seek, and chapter skip. There is no cover artwork to attach. The downloaded MP3 carries the same
chapters as ID3v2.3 CHAP frames: finalize muxes an ffmetadata1 chapter file
in with `-c copy` (one fast pass, no extra encode); a mux failure ships the
plain file.
An optional **Transcript** control opens a book-styled read-along
(`ReadAlongTranscript`). It fetches `GET /api/jobs/[id]/transcript` once.
That route only reads `content.txt` or the already frozen `sections.json`
and strips cue tags for display. It does not pack, tag, or synthesize.
Highlight follows the measured section clock (`section-starts.json`, the
same MP3-frame clock chapters use) with sentence-weighted timing inside
each section — speakable characters plus paragraph-break pauses, snapped to
sentence starts — falling back to scaled hint durations, the stream cursor
on a listening job, or time through the readable text. Tapping a passage
seeks through the same clock (per-section files are scaled onto their own
file clock).

**Follow** (`src/lib/player/read-along-follow.ts`) is on by default: the
active passage is centred whenever it leaves the middle band
(`followScrollDelta`, 25–75% of the viewer). A manual wheel, touch drag, or
keyboard scroll pauses following and shows a **Back to now** pill; the pill
and 8 s of quiet (`FOLLOW_IDLE_RESUME_MS`) both resume it. A pause the
reader sets with the header toggle has no idle timer, so it stays paused
until they resume it. The header toggle writes `ec-read-along-follow` and
the focus overlay writes `ec-read-along-fullscreen`; both go through
`player-prefs.ts`, mirrored in memory so a refused `localStorage` write
still holds for the visit, and read with `useSyncExternalStore` so the
server render never disagrees with storage. The precise-seek disclosure
(`ec-player-precise-seek`) uses the same store, which is why its position
carries from the inline player bar into focus mode.

Only a slice of a long book is mounted (`initialWindow` / `windowCovering`:
40 passages behind, 160 ahead). Following appends as the playhead nears the
end so the rows above it never move; a playhead outside the slice gets a
fresh window. A paused reader extends the slice 60 rows at a time near
either edge, and prepending restores the scroll offset. Rows are memoized on
primitives, so the 4 Hz timeupdate re-renders only the passage that changed,
and only the active paragraph splits into a highlighted sentence span.

A tap seeks to the **word under the finger** (`tapCharIndex` → the existing
char → time clock), not the paragraph start, which keeps it within about a
second on a long paragraph. A drag-selection is not a seek. Text is set on a
`65ch` measure in Cormorant with past passages dimmed, the active one on a
soft tint, upcoming ones at normal weight.

**Focus mode** (`read-along-focus.tsx`, `useReadAlongFocus`) expands the
read-along to the viewport with a slim bar at the bottom: play/pause, ±15 s,
scrubber, speed, and the chapter title. It asks the Fullscreen API, but the
overlay is always `fixed inset-0` with `100dvh`, because iOS has no element
fullscreen and a request can be refused — so the CSS path alone is
complete. Esc, the Exit control, and leaving browser fullscreen all close
it; a saved preference reopens it on the next visit. Scrolling is
`behavior: smooth` unless `prefers-reduced-motion` is set, in which case
placement is immediate.

Stream jobs can `POST …/takehome`. Operator Fish markup is a separate
page (`/dashboard/player/[id]/markup`). The link is rendered only for a
session on `ECHO_OPERATOR_EMAILS` / `ECHO_OPERATOR_USER_IDS` while
`ECHO_OPERATOR_TOOLS=1` (or outside production). Other signed-in owners
do not see it. The operator can open markup for any job id.

### `src/hooks/useAudioProcessor.ts`

No Web Audio. Audio plays from a cross-origin R2 URL, and
`createMediaElementSource` on a cross-origin element outputs silence. The old
graph only applied a fixed 0.75 gain, now `audio.volume = 0.75`. Speed via
`playbackRate`. Same hook API as before.

### Shell

`dashboard/layout.tsx`: Voice / Library in the header (and mobile tab bar).
**Privacy** is a quiet right-corner footer link on the dashboard and the
landing page. Signed-out chrome shows **Sign in**
(provider-agnostic), which opens a small menu: Sign in, Voices
(`/dashboard/voice`, browsable without a book), and Library. The account
settings page keeps a plain Sign in link. Signed-in chrome shows the
visitor’s name; **Sign out is not a top-right control** — it lives inside
that name menu with Settings (`/dashboard/account`), Voices, Library, and
Dark mode (`src/components/auth-controls.tsx`). Landing has no top-left
wordmark and no standalone Library / Sign out links — only the centered
formal serif logo and the account control. Other pages use that same
Cormorant wordmark in the top left. Player / Voice primary controls are
ghost text, not filled discs. There is no How it works page. No broken
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
(Standard vs Clone). Action screens stay free of explanatory essays.

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
| `process-job.test.ts` | Lease races, heartbeat, reclaim, skip ready sections, index-stable fan-out; normalized fallback text and engine ceiling in actual synthesis calls; Edge rolling pool claims over a stalled section and the no-deadline claim budget |
| `section-index.test.ts` | Five dummy synths; concat transcript always 0,1,2,3,4; `nextClaimableIndex` skips in-flight claims; rolling pool claims over a hung slot and honors `shouldStop` |
| `trigger-takehome.test.ts` | create / retry / takehome wake Trigger when `WORKER_URL` is unset; VM worker when it is set; extract stays off Trigger |
| `takehome-dispatch.test.ts` / `takehome-worker-client.test.ts` | Worker preferred; Trigger fallback flag; production 503; HTTP retries |
| `worker/takehome-loop.test.ts` / `takehome-http.test.ts` | Per-job inflight + concurrency; health / auth / enqueue |
| `dispatch-extract.test.ts` | Extract Worker URL POSTs Cloudflare and never Trigger; local/tests extract inline |
| `trigger-api.test.ts` | REST fallback when SDK returns no run id; retries then throws |
| `mastering.test.ts` | default DFN wet 0 / podcast chain + 44.1 kHz 96 kbps loudnorm; fail-open; skip tiny / already-mastered |
| `mastering-loudness.test.ts` | ffmpeg smoke: delivery chain near −16 LUFS, true peak ≤ −1 dBTP |
| `fish-s2-cues.test.ts` | Official S2 allowlist strips unknown tags; length-scaled cap; reject prose rewrite |
| `concat-audio.test.ts` | `full.mp3` still uploads when enhance is skipped or throws; WAV sections crossfade |
| `crossfade-audio.test.ts` | 120ms equal-power overlap; 12ms mid-paragraph fade; edge-silence trim; clamp 80–150 |
| `normalize-speakable.test.ts` | Asterisks, editorial brackets, ALL-CAPS title, Roman section line; number / abbreviation backstop and idempotence |
| `mastering-isolation.test.ts` | No ffmpeg/torch/`mastering-worker` import from `src/app/api/**` |
| `stream-session.test.ts` | Cursor only after audible; concurrent reader; budget; small-engine ceiling in provider calls |
| `speakable-text.test.ts` | Attention page-1 + glued 4-page extract: emails/URLs/grants gone, Abstract+Introduction kept as their own paragraphs, no conference-to-EOF wipe |
| `narration-script.test.ts` | Fish `[long-break]` / `[break]` on headings and dense prose; tags for Fish / Edge / Google; mid-comma decision; seminar prefix retired |
| `ssml-pauses.test.ts` | Fish pause tags → Google timed SSML breaks; Edge-safe breaths (no `<break>`); XML escape; sparse/normal placement |
| `google-ssml-budget.test.ts` | Packed Google Whole-book sections: final SSML UTF-8 bytes always ≤ 5000 (4900 hard max); Edge/Fish char targets unchanged |
| `edge-tts.test.ts` | Edge SSML envelope has no custom `<break>` for Fish pause IR; silent socket after audio throws `Edge TTS stalled`; section chunk split presses sentence/paragraph boundaries, concatenates parallel chunk turns and strips inner ID3 tags, and re-speaks only the failed chunk |
| `schema-migrate.test.ts` | Second `ensureTtsJobColumns` on a current schema is `"hot"` |
| `document-formats.test.ts` | Charset/alias PDF MIME; magic-byte sniff; octet-stream presign allowed |
| `providers/index.test.ts` | A stored Google voice is refused and is not sent to OpenRouter |
| `stream-session.test.ts` | Cursor only after audible; concurrent reader; budget; Live resolves delivery pauses / titles / prefix |
| `narration-pace.test.ts` | 194 speech WPM → ~0.78; pause_ratio 0.13 does not force 1.0; clone/academic first section < 1 |
| `clone-sample-audio.test.ts` | Tiny WAV: high-pass / gate / normalize; mp3 passthrough |
| `clone-sample-quality.test.ts` | Injected metrics: phone fail, Wolfe/studio2 pass; threshold edges |
| `clone-sample-quality-metrics.test.ts` | Synthetic dry/wet PCM: RT60 + reverb proxy; WAV analyze vs mp3 null |
| Unit suites | pricing, audio-guard, catalog, session, rate-limit, … |

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
WORKER_URL / WORKER_SECRET  # Production: https://worker.echomancer.xyz (take-home and extract)
EXTRACT_WORKER_URL / EXTRACT_WORKER_SECRET  # Cloudflare extract fallback when the VM POST fails
```

### Important optionals

```
FISH_API_KEY               # Clara, clones, leftover fish-narrator
EXTRACT_NODE_CONCURRENCY=1 # Warm VM extract children. Not a TTS slot. Default 1, max 4.
# EXTRACT_NODE_HANDOFF_SECONDS=75
# EXTRACT_CF_RESEND_SECONDS=45
# EXTRACT_NODE_HEARTBEAT_STALE_SECONDS=180
# EXTRACT_NODE_HARD_CAP_SECONDS=1200
# EXTRACT_MAX_ATTEMPTS=4 # Node, Cloudflare, and Vercel share this counter
# EXTRACT_CHILD_MEMORY_MB= # Optional old-space cap. Parent execArgv heap flags are kept.
# EXTRACT_CHILD_RECYCLE_MB=1024
# EXTRACT_CHILD_TIMEOUT_MS=600000 # Kill one hung extract and recycle the child. Stall poll owns the retry.
# Google Cloud TTS keys are unused. Stored Randolph books play saved audio.
# Clone generation has no character allowance. MODAL_S2_USER_DAILY_CHARS and
# MODAL_S2_GLOBAL_DAILY_CHARS are inert if an old env file still sets them.
# MODAL_S2_TTS_URL          # batch endpoint, required for the S2 pool. No path.
# MODAL_S2_SYNTHESIZE_URL   # optional single-section host. Not derived.
# MODAL_S2_READY_URL        # optional probe. Never derived from the batch URL.
# Reported set on Vercel as of 2026-11-07. Hostnames are not in this repo.
# S2C_MAX_CONTAINERS=1      # code default. Production cap of 4 is update_autoscaler, not this env.
# S2C_SCALEDOWN=300         # code default. Reported runtime scaledown_window is 180.
# TTS_QA_PROVIDER=local     # default. deepgram is opt-in. off skips QA.
OPENROUTER_API_KEY         # leftover catalog, listen-prep fallback, and section transcript QA (same key on the VM)
ECHO_OPERATOR_TOOLS=1      # production master switch for Fish markup
ECHO_OPERATOR_USER_IDS=    # preferred. user_* ids. Operator can read any job's markup.
ECHO_OPERATOR_EMAILS=      # only if users.email_verified = 1. Empty allowlist denies.
TTS_MASTER_SKIP=1            # disable full-book remaster
TTS_SECTION_MASTER=0         # packet-copy finish off; full loudnorm encode instead
TTS_MASTER_FULL_BOOK=1       # local opt-in when not on Vercel; pm2 sets this
TTS_MASTER_DFN=1             # opt-in DeepFilterNet3 (wet 0.4 unless TTS_MASTER_DFN_WET is set)
TTS_MASTER_DFN_WET           # default 0 = ffmpeg-only remaster; >0 enables DFN mix (0–1)
DEEP_FILTER_BIN              # set on the VM (`/usr/local/bin/deep-filter`); unused unless DFN is opted in
FFMPEG_PATH                  # Ubuntu apt on the VM; Trigger `ffmpeg()` is legacy
TTS_CONCAT_CROSSFADE_MS      # default 120; clamp 80–150; 0 = hard concat
TTS_MASTER_TIMEOUT_MS        # default 50 minutes
ECHOMANCER_SCRATCH_DIR       # default os.tmpdir()/echomancer; per-job finalize scratch
ECHOMANCER_SCRATCH_MAX_AGE_HOURS  # default 24; sweep deletes older job dirs
ECHOMANCER_SCRATCH_SWEEP_MS  # default 15 min (minimum 60s)
TTS_FINALIZE_TIMEOUT_MS      # default 6 hours; kills a stuck ffmpeg
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
- Hobby: no `crons` in `vercel.json`. Whole book is the VPS worker
  behind Caddy (`WORKER_URL=https://worker.echomancer.xyz` →
  `src/worker/takehome-server.ts` on `127.0.0.1:8788`). Polls are read-only.
- Generate secrets with any CSPRNG (`openssl rand -hex 32` or PowerShell
  equivalent); they are not vendor API keys.

---

## 26. Invariants checklist

1. **Identity is server-minted.** Cookie/header always re-verified with HMAC.
2. **Wrong owner → 404** on jobs/storage (not 403).
3. **Job create never synthesizes.** The VPS worker does. Trigger.dev is a legacy fallback only. Polls do not synthesize.
4. **Lease token gates all take-home progress writes.**
5. **Silence is failure.** Preview / sections / stream windows all guard.
6. **Stream cursor advances only after audible bytes.**
7. **Shared PDF folders survive** until the last sibling job is deleted.
8. **Accent variants are Gemini-only;** style prompts only for vendors that honor them.
9. **OpenRouter `pricing.prompt` is untrusted** without override / plausibility window.
10. **`/api/storage` is the only browser file path** — ownership checked every time, then a 302 to a presigned R2 URL (bytes skip Vercel). Finished-book downloads use a presigned `download_url` minted on the owned job routes.
11. **Document bytes never enter a Vercel function body.** Browser PUTs to R2. Extract runs on the VM child first, then Cloudflare, then Vercel.
12. **ffmpeg / torch / deep-filter stay off the Vercel hot path.** Whole-book remux / crossfade / podcast or S2 delivery chain run on the VPS worker (fail-open). DeepFilter is env opt-in. The clone GPU is Modal, not the VM and not Vercel.
13. **`WORKER_CONCURRENCY=1`** until a full book masters without the OOM killer.
14. **`ready` means every section index.** A hole is `failed`, progress under 100, audio kept. `download_url` is ready-only.
15. **No app character allowance on clones.** Usage accounting cannot refuse a book. Provider auth, quota, and billing errors still can.
16. **Clone cache identity includes the narration recipe**, not a hand-bumped `s2-pro-modal-v1`.
17. **A clone book does not change narrator.** Drama 3 is not called. The other engine is direct Fish, the same reference. A cold pool parks, then may switch after `MODAL_S2_DEFER_MS` (code default 25 min) with a warning, and only when `FISH_API_KEY` is set. `MODAL_S2_DEFER_MS=0` skips the park without rewriting `provider_pin`.

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
| Nudge | At budget 0: library list may release expired leases; the player poll does not. Neither synthesizes. A non-zero budget is the old path that also runs a short wave. |
| Segment | One stored take-home section in `segments_json` (map by index) |
| Frozen script | `audiobooks/<jobId>/speakable.txt` + `sections.json` written once per take-home job |
| Fan-out | Parallel section calls. Direct Fish is capped at 4 or 5. A Modal clone's lanes default to 4; one call still carries a batch of rows. |
| Stream budget | Char/time cap for live listen |
| HD gate | Soft block for MiniMax-class voices |

---

## Related reading order (first week in the codebase)

1. `src/proxy.ts` → `lib/auth/session.ts` → `lib/auth/guard.ts`
2. `app/api/pdf/upload/route.ts` → `lib/jobs/dispatch-extract.ts` → `workers/extract`
3. `app/api/jobs/route.ts` → `lib/jobs/takehome-dispatch.ts` → `lib/jobs/serialize.ts`
4. `lib/tts/catalog/*` → `lib/tts/providers/{edge,fish,paradee,modal-clone}.ts` (`google.ts` is gone)
5. `lib/tts/stream-session.ts` + `app/api/jobs/[id]/stream/route.ts`
6. `src/worker/takehome-server.ts` + `WORKER.md` + `lib/tts/process-job.ts` (claim → frozen-script → synthesizeSection → remux)
7. `modal/s2_contract.py` + `docs/s2-gpu-staging-runbook.md` for the clone pool. The runbook is the procedure. A blank checklist is not evidence the step was done.
8. `app/dashboard/{voice,queue,player}` with `lib/ux-copy.ts` open beside them
9. `src/test/harness.ts` + `src/test/acceptance/book-path.acceptance.test.ts`

*Document tracks Echomancer v2 source as of 2026-11-07 (`a975b42`, #248):
Next.js on Vercel (`echomancer.xyz`), Turso + R2, VM extract with a Cloudflare
fallback, VPS + pm2 Whole-book worker behind Caddy at `worker.echomancer.xyz`,
Modal S2-Pro for clones when `MODAL_S2_TTS_URL` is set. Trigger.dev is legacy
fallback only. Live deploy overrides and unverified gaps are in "How to read
claims" at the top. Job `75944dc9` was not repaired.*
