# Echomancer v2 — Technical Design (Code Walkthrough)

**Audience:** someone who will open the repo and follow along. This document is
organized as a **map of the code**. Every important module is named, major
exports are explained, and end-to-end flows are traced through concrete files
and functions.

**Live app:** [echomancer.xyz](https://echomancer.xyz) (operator-reported;
the package name and the README host are `echomancer-v2`). **Audited against `main` at
`e4b6ef2684ce6892395f0d34bef5027131a8cda4` (#316) on 2026-11-21.** The
previous audit was `a975b42` (#248) on 2026-11-07. Between the two, the repo
gained the Kokoro CPU voices (Drew, Walter, George, Esther), the Modal CPU
task queue, the remote-call layer with budgets and Stop, resume and
bookmarks, Fish-baked clone previews, the root playback shell with a mini
player, speed persistence, the Echomancer Andrew retirement (#314), and the
Ava/Libby retirement once Esther is configured (#315).

**Companion docs:** `AGENTS.md` (agent/ops cheat sheet), `WORKER.md`
(VM + pm2 + Caddy), `DEPLOYMENT.md`, `TURSO_R2_SETUP.md`, `README.md`.
Procedures live in the runbooks, which this file does not duplicate:
[`docs/s2-gpu-staging-runbook.md`](docs/s2-gpu-staging-runbook.md) (clone GPU),
[`docs/cpu-modal-runbook.md`](docs/cpu-modal-runbook.md) (Modal CPU tasks),
[`docs/sowell-voice-runbook.md`](docs/sowell-voice-runbook.md),
[`docs/drew-walter-voice-runbook.md`](docs/drew-walter-voice-runbook.md),
[`docs/george-voice-runbook.md`](docs/george-voice-runbook.md),
[`docs/heart-voice-runbook.md`](docs/heart-voice-runbook.md) (Kokoro voices).
Playback/clip recovery is in
[`docs/playback-clipping-reliability.md`](docs/playback-clipping-reliability.md),
background playback in
[`docs/mobile-background-playback.md`](docs/mobile-background-playback.md), and
lane arithmetic in [`docs/s2-lane-budget.md`](docs/s2-lane-budget.md).

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
| **Operator-reported** | Stated by the operator or written only in an env example or runbook. This checkout cannot confirm it. |
| **Not verified** | This repository does not prove it. Do not treat a blank runbook checklist as a completed proof. |

**Not verified by this audit:**

- No book was rendered, no test suite or lint was run, and no Modal, Vercel,
  Turso, R2, or VM endpoint was called for this documentation change. Claims
  come from reading source at the SHA above.
- Which Modal image versions are deployed, whether the live S2 image already
  carries `@modal.concurrent(max_inputs=2)`, and which `*_ENABLED` voice
  flags are set on Vercel and the VM. Source defaults are stated; live
  values are not.
- Snapshot coverage per GPU type. The runbook's rule is 2–3 snapshots per GPU
  type, judged by wall-clock restore (`placement_kind`), not by
  `boot=restored`.
- Job `75944dc9` (2026-11-06) was not regenerated. The code stops a *new*
  book from being assembled that way; it does not repair that file.

**Operator-reported state (carried from the 2026-11-07 audit; not re-checked):**

- The take-home worker runs on an always-on VM reported as Contabo. The
  worker code does not name a cloud vendor (`src/worker/takehome-server.ts`);
  "Contabo" is that report, not a string the process checks.
- `MODAL_S2_TTS_URL`, `MODAL_S2_READY_URL`, and `MODAL_S2_SYNTHESIZE_URL` were
  reported set on Vercel. The repo does not store those hostnames. A ready
  URL is never derived from the batch URL.
- Live autoscaler for production `echomancer-s2-clone`: `min_containers=0`,
  `max_containers=1`. Any change needs explicit owner approval. Do not run
  `scripts/s2/set-live-autoscaler.py` or runbook step 8c to raise it.

**GPU guard rails that are Implemented in source:**

- Modal app name in source is `echomancer-s2-clone`
  (`modal/s2_clone_service.py`, resolved by `s2_contract.resolve_app_name`;
  a bare deploy targets staging unless `S2C_ALLOW_PRODUCTION=1`, see §14).
  Code default `S2C_VERSION` is `"10"` (the snapshot/object-shape version).
  Code default `S2C_ENGINE` is `v9` (`modal/s2_batch.py`), so a plain deploy
  keeps the v9 decode loop. GPU defaults to `H100!` and batch width to 32
  (`S2B_GPU`, `S2B_BATCH` in `modal/s2_batch.py`). This audit did not compute
  a `snapshot_fingerprint`; the id quoted in the previous audit was for
  version 9 and is stale.
- `container_limits` in `modal/s2_contract.py`: `min_containers` is always 0,
  `S2C_MAX_CONTAINERS` defaults to 1 (clamp 1–64), `S2C_SCALEDOWN` 300 s,
  `S2C_BUFFER_CONTAINERS` 0. `/ready` keeps reporting the deploy-time env,
  and a plain `modal deploy` resets an autoscaler override back to the baked
  cap.
- The apply path refuses `max_containers` above 1 on the production app
  unless `S2_ALLOW_PROD_CAP_ABOVE_1=1`, and it exits before importing Modal.
  `scripts/s2/drain-stuck-calls.py` refuses `--restore-max` above that clamp
  before it brakes. Parsers in `scripts/s2` set `allow_abbrev=False`.
- Pytest under `modal/` strips `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and
  `MODAL_PROFILE`, points `MODAL_CONFIG_PATH` at an empty file, refuses DNS
  and connections to `*.modal.com` / `*.modal.run`, and makes
  `Client.from_env` raise (`modal/no_live_modal.py`, `modal/conftest.py`).
- `@modal.concurrent(max_inputs=2)` on `S2CloneWorker` lets one
  `render_batch` and one light input share the GPU, so a status probe cannot
  push `render_batch` onto a second H100 (book `db7d3d90`, 2026-11-19, is the
  incident the source comment names). With `MODAL_S2_CONTROL_URL` set the
  worker submits through the CPU-only `s2_control` function and does not
  POST the GPU web endpoints. A 429 is the busy-not-cold backstop.
- `MODAL_S2_MAX_GPUS` (default 20) is the worker lease count
  (`modal_gpu_leases`), not the container cap.

There is no per-account or global character allowance on clone generation.
`MODAL_S2_USER_DAILY_CHARS` and `MODAL_S2_GLOBAL_DAILY_CHARS` are inert.
Usage is still written to `usage_logs` (`action: "modal_s2_clone"`), and a
failed insert does not stop the book (`recordModalCloneUsage` in
`src/lib/tts/providers/modal-clone-guard.ts`). Spend is bounded by the
remote-call budgets instead (§28). A real provider auth, quota, or billing
error is still an error and keeps the provider's message.

---

## Table of Contents

1. [What the product is, and the architecture](#1-what-the-product-is-and-the-architecture)
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
28. [Cost, budgets, scaling & prewarm](#28-cost-budgets-scaling--prewarm)
29. [Known limitations](#29-known-limitations)
- [Remote calls](#remote-calls)

---

## 1. What the product is, and the architecture

Echomancer turns an uploaded document (or pasted text, or a public URL) into
listen-able audio. Two customer paths share one upload:

| Customer language | `job_kind` | What the code does | Host |
|-------------------|------------|--------------------|------|
| Live Stream | `stream` | Pipe provider audio live; cap chars/time; store **no** audio | Vercel |
| Get the whole book | `takehome` | Freeze speakable sections → synthesize → master → R2 → join | Always-on VM worker, with Modal for GPU/CPU work |

`generation_mode` is always `"stock"` in v2. The Voice tab opens on the slim
stock list (§1.3); cloning is the other path.

Rough money: take-home price is dynamic from character count × voice rate
(`src/lib/tts/pricing.ts`). About **€4.50** for a typical novel is a **Goal**,
not a ceiling the code enforces.

### 1.1 Production topology

| Piece | Where it runs (Implemented unless marked) |
|-------|----------------|
| App + API | Next.js App Router on Vercel (`echomancer.xyz`; package name and README host `echomancer-v2`). Upload presign, job create/list, storage proxy, Live Listen, Live Stream, auth. `vercel.json` is the empty schema: no Vercel cron. |
| Database | Turso (libSQL). It is also the queue: jobs, leases, CPU tasks, provider slots, remote-call ledger (§7, §19, §28). |
| Objects | Cloudflare R2 (`src/lib/r2-storage.ts`), local disk when R2 is unset. |
| Whole-book orchestration | Always-on VM. Node + pm2 process `echomancer-takehome` (`src/worker/takehome-server.ts`), bound to **`127.0.0.1:8788`**. Caddy on the VM terminates HTTPS for `WORKER_URL`. Host vendor is **Operator-reported** (Contabo); the code does not check it. Runbook: `WORKER.md`. |
| Document extract | Warm child process of the worker (`POST /extract`, `src/worker/extract-child.ts`); Cloudflare `workers/extract` when that POST fails; Vercel as the last resort (§9). |
| Clone GPU | Modal app `echomancer-s2-clone` (`modal/s2_clone_service.py`): Fish S2-Pro on an H100, GPU memory snapshots, `min_containers=0`, code-default `max_containers=1`. Used only when `MODAL_S2_TTS_URL` is set. Submit/poll/cancel goes through the CPU-only `s2_control` function at `MODAL_S2_CONTROL_URL`. |
| Kokoro voices | Modal app `echomancer-sowell` (`modal/sowell_worker.py`, image `workers/sowell/Dockerfile`): CPU Kokoro-82M serving Drew (fine-tuned weights on the `andrew-distill` volume), Esther (`af_heart`), George (`bm_george`), and Walter (`sowell`). `cpu=2`, `memory=6144`, `min_containers=0`, `max_containers` from `SOWELL_MAX_CONTAINERS` (default 16, clamp 1–16), `scaledown_window` default 5 s. |
| CPU tasks | Modal app `echomancer-cpu` (`modal/cpu_worker.py`, image `workers/cpu/Dockerfile`): `master`, `whisper`, `concat`, and `extract` tasks when `CPU_RUNNER=modal`. `min_containers=0`, `CPU_MAX_CONTAINERS` default 4, `CPU_FUNCTION_CPU` 2, `CPU_FUNCTION_MEMORY_MB` 4096, `CPU_SCALEDOWN_SECONDS` 10. The five-minute New Book warm is a worker keepalive when that variable is set on the worker below 300s; it is not a 300s idle window on every task. With `CPU_RUNNER` unset (the code default) the same tasks run on the VM (§19). Whether production has `CPU_RUNNER=modal` is not verified here; `env.worker.example` shows it commented out. |
| Fish API | Direct Fish (`FISH_API_KEY`, `src/lib/tts/providers/fish.ts`): clone training (`POST /model`), clone synthesis when the book is pinned to `fish`, clone preview bakes, stored Clara books, Live Listen for clones. Native model id `s2.1-pro-free` (`FISH_NATIVE_FREE_MODEL`). |
| Edge TTS (legacy) | Microsoft Edge Read Aloud websocket (`src/lib/tts/edge-tts.ts`): stored Andrew/Ava/Libby/Ryan/Michelle books, and new Ava/Libby/Michelle requests until Esther is configured. |
| Paradee (legacy) | `src/lib/tts/providers/paradee.ts`: only a book already stored as Echomancer Andrew (`echomancer-andrew`). A new request that names that id is coerced to Drew. |
| Not called | Google Cloud TTS (stored Randolph audio still plays). Drama 3 / OpenRouter for clones. |

### 1.2 Book lifecycle (one paragraph per step, details in the linked sections)

1. **Upload or paste.** `POST /api/pdf/upload` presigns; the browser PUTs to
   R2; `POST /api/pdf/upload/[id]` dispatches extract. Paste and URLs go
   through `POST /api/text/upload` and are `ready` at once (§9).
2. **Extract and clean.** `runUploadExtract` writes `pdfs/<uploadId>/content.txt`
   and `chapters.json`; listen-prep writes `listen-cleaned.txt` and
   `narrator.json` in the background (§9, §15 `listen-prep.ts`).
3. **Create.** `POST /api/jobs` only inserts (`queued`, or `waiting` while the
   file is still being read), reserves `takehome_create_keys`, and wakes the
   VM with `POST $WORKER_URL/jobs` (§16, §19).
4. **Queue, leases, admission.** The VM drain claims a lease
   (`claimTakehomeLease`), respecting per-user and global caps,
   `takehome_fairness`, provider slots, and for clones one `modal_gpu_leases`
   row per book. Every remote call is admitted by the remote-call layer,
   which can refuse on budget (§19, §28, "Remote calls").
5. **Freeze and section.** The first claim writes `speakable.txt`,
   `sections.json`, and `playback-chapters.json` once; later ticks never
   re-split (§19 "Index invariant").
6. **Render.** Each section index is bound to one synthesis call: Kokoro CPU,
   Edge, Paradee, Fish, or the S2 GPU batch (§12, §14).
7. **Master.** Each take is stored raw, then mastered to
   `sections/NNNN.mp3` with the voice EQ stage (`voiceEqStageAf`, the shared
   warm curve) and loudnorm (−16 LUFS stock/Fish, −19 LUFS for the S2 chain).
   A section is `ready` only once mastered (§19 "Queue hardening", §20).
8. **Join and ready.** When every index is ready the job is `ready`; the join
   packet-copies mastered sections into `full.mp3` with crossfades and ID3
   chapters. A book with holes is `failed` with its audio kept (§19, §20).
9. **Listen.** The root playback shell plays sections while the join runs,
   then `full.mp3`; resume and bookmarks are per listener (§22).

### 1.3 Voices (current `main`)

Catalog ids and the code that decides them: `src/lib/tts/standard-voice.ts`,
`src/lib/tts/kokoro-voice-ids.ts`, `src/lib/tts/catalog/index.ts`
(`listedStockIds`, `listSlimDefaultCatalogVoices`).

| Name | Catalog id | Engine | Listed when |
|------|-----------|--------|-------------|
| **Drew** (default) | `drew` | Fine-tuned Kokoro-82M on `echomancer-sowell` | `drewReady()` (`DREW_ENABLED=1`, `DREW_URL`, `DREW_TOKEN`) |
| **Esther** | `heart` | Stock Kokoro `af_heart` (`HEART_DISPLAY_NAME = "Esther"`, `src/lib/tts/heart-voice.ts`) | `heartReady()`: `HEART_ENABLED=1`, `HEART_URL` (host, no path), `HEART_TOKEN` |
| **Ava** | `ava` | Edge `en-US-AvaNeural` | Only while Esther is **not** ready |
| **Libby** | `libby` | Edge `en-GB-LibbyNeural` | Only while Esther is **not** ready |
| **George** | `george` | Stock Kokoro `bm_george` | `georgeReady()` |
| **Walter** | `sowell` | Kokoro (Walter pack) | `sowellReady()`; appended last |
| Your clones | `clone:<uuid>` | S2 GPU or direct Fish | Owner's session |

List order: Esther not ready → Drew, Ava, Libby, George (+ Walter). Esther
ready → Drew, Esther, George (+ Walter). A voice whose endpoint is not ready
is dropped from the list. A request with no voice uses Drew and is 503
`DREW_NOT_CONFIGURED` when Drew is not ready.

**Coercions** (`coercePlainCatalogVoiceId`, run on a new request in
`POST /api/jobs` and on a saved pick, never on a stored row; `{ heart }` is
`heartReady()`):

| Requested | Esther not ready | Esther ready |
|-----------|------------------|--------------|
| `andrew`, `standard`, `echomancer-andrew`, `randolph`, bare `expressive` | Drew | Drew |
| `ryan` | George | George |
| `ava` / `libby` | stays Ava / Libby (Edge) | Esther |
| `clara` | Libby | Esther |
| `michelle` | stays Michelle (Edge) | Esther |
| `heart`, `af_heart` | Esther (`heart`) | Esther (`heart`) |
| `walter` | `sowell` | `sowell` |
| `… (expressive)` suffix | stripped, then the rules above | same |

A **stored** book keeps its row: Andrew, Ava, Libby, Ryan, and Michelle books
still synthesize on Edge, Echomancer Andrew on Paradee, Clara on Fish with its
curated `reference_id`, and Randolph is played from its saved file and is
never synthesized (`isRetiredGoogleSynthesis`).

**Stock previews** are committed files (`public/voice-previews/<id>.mp3`:
`drew`, `heart`, `ava`, `libby`, `george`, `sowell`, plus unlisted
`standard`, `ryan`, `echomancer-andrew`). `POST /api/tts/preview` returns
those bytes; nothing is synthesized for a listed stock preview (§14
`browser-speech.ts`).

**Clone previews** are stored MP3s. `GET /api/tts/clones/[id]/preview` only
reads storage (fish v2 key, then the legacy engine-free key, then an older
s2-pro key); a miss enqueues one **Fish** bake on the worker
(`POST /clone-preview`) and answers `202 PREVIEW_PREPARING`. A failed bake
answers `409 PREVIEW_BAKE_FAILED` until the Retry button, which is
`POST … { retry: true }` and still replays a stored take if one exists. Both
methods need Fish configured. A stored preview
is served `private, max-age=31536000, immutable`. The preview path does not
call the S2 pool, so it never starts a GPU. Selecting a clone row on the
Voices page is separate: it posts `/api/capacity/warm` with `reason: "voice"`,
which can start one S2 restore-only prewarm (§28).

There is no customer control for clone emotion, Fish generation speed
(`prosody.speed` is chosen in `src/lib/tts/narration-pace.ts`), or narration
pauses, joins, and titles. The player's listen-time `playbackRate`
(0.8–1.5×) does not re-synthesize.

A take-home clone book pins its engine once (`jobs.provider_pin`, `modal` or
`fish`) and keeps it; a cold GPU pool parks the book (`MODAL_S2_DEFER_MS`,
default 25 min) instead of switching narrator, and only a spent park budget
switches it to direct Fish (the same trained reference), with a warning. A
legacy `drama3` pin is re-pinned on its next tick.

---

## 2. Repository map

```
src/
  proxy.ts                     # Next.js middleware (anonymous session mint, ec_signed_in hint)
  app/
    page.tsx                   # Landing upload / paste
    layout.tsx                 # Fonts, theme, PlaybackProvider (root <audio>)
    privacy/page.tsx           # Privacy statement
    sign-in/                   # Google + email sign-in, /sign-in/confirm
    dashboard/
      layout.tsx               # Nav shell
      voice/page.tsx           # Narrator picker + clone + job create
      queue/page.tsx           # Library + polling
      player/[id]/page.tsx     # Player, chapters, transcript, bookmarks
      player/[id]/markup/      # Operator-only Fish markup
      account/                 # Settings
    api/
      pdf/upload/              # JSON presign. Browser PUTs to R2.
      pdf/upload/[id]/         # complete + poll extraction
      pdf/upload/[id]/object/  # local PUT when R2 is unset
      pdf/upload/[id]/narrator/# cached narrator suggestion
      text/upload/             # Paste or public URL
      jobs/                    # Create / list
      jobs/[id]/               # Detail / rename / retry / delete
      jobs/[id]/{cancel,download,stream,takehome,process,transcript,markup}/  # cancel is the Stop button
      jobs/[id]/position/      # Resume position (GET/PUT)
      jobs/[id]/bookmarks/[bookmarkId]/
      cron/process-jobs/       # Operator fallback drain (no Vercel cron configured)
      storage/[[...path]]/     # Ownership-gated file proxy
      capacity/warm/           # Shared CPU / Kokoro / S2 warm (cookie required)
      tts/voices/              # Slim catalog + session clones
      tts/preview/             # Committed stock preview bytes
      tts/live/                # Fish chunked live listen
      tts/clones/, tts/clones/upload/, tts/clones/[id]/, tts/clones/[id]/preview/
      tts/youtube/search/      # Signed-in YouTube search for clone clips
      clips/, clips/[id]/      # Server YouTube clip queue (allowlisted email)
      auth/[...nextauth]/, auth/email/, auth/email/verify/, auth/logout/
      viewer/                  # Header identity payload
      log/                     # Client failure reports
      health/
  lib/
    auth/                      # session, guard, google, authjs, email-login, …
    rate-limit.ts
    jobs/                      # serialize, worker-auth, takehome-dispatch, takehome-identity, direct-download, …
    turso.ts + turso/          # jobs, uploads, cloned-voices, clone-uploads
    storage/ + r2-storage.ts
    uploads/, text-extraction.ts, document-formats.ts, source-text.ts, blocks.ts, …
    remote/                    # layer (flights, budgets), store, reconcile, drain-book, stop, prewarm
    cpu/                       # cpu_tasks queue, runner (local | modal), task-slot
    capacity/                  # shared warm holds (warm.ts, client.ts)
    player/                    # playback-speed, player-prefs, media-session, shell-resume, audio-start, …
    nav/, library/, operator/, youtube/, modal/
    tts/                       # whole synthesis stack (catalog, providers, process-job, mastering, …)
  components/                  # playback-provider (shell + MiniPlayer), player-*, auth-controls, …
  hooks/                       # use-audio-start, use-playback-speed, use-playback-resume, useAudioProcessor
  worker/                      # takehome-server, takehome-loop, takehome-http, extract-child, auth
  test/                        # harness, setup-env, acceptance/
modal/
  s2_clone_service.py          # echomancer-s2-clone (H100, snapshots, s2_control, ready)
  s2_contract.py, s2_batch.py, s2_endpoints.py, s2_clone_warm.py, s2_compile_cache.py, …
  sowell_worker.py             # echomancer-sowell (Kokoro CPU voices)
  cpu_worker.py                # echomancer-cpu (master / whisper / concat / extract)
  test_*.py, conftest.py, no_live_modal.py
workers/
  extract/                     # Cloudflare Worker: document parse fallback
  cpu/Dockerfile               # Modal CPU image (pinned static ffmpeg)
  sowell/Dockerfile            # Kokoro image
  takehome/Dockerfile          # Optional Whole-book image
scripts/
  oracle/                      # VM bootstrap (pm2 / Caddy / smoke)
  s2/                          # Staging smoke, A/B bench, autoscaler, drain, cover
  cpu/                         # Modal CPU smoke
  sowell/, previews/, paradee/ # Kokoro style tools, preview recording, legacy Paradee
  rechapter-takehome.ts, refinalize-takehome.ts, repair-raw-masters.ts, whisper-qa.py
docker-compose.yml             # Optional Docker path (pm2 is primary)
migrate-turso.sql              # Additive SQL mirror of runtime migrator
vercel.json                    # Empty schema (no crons)
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
| `mergeAnonymousOwnership()` | Only for an `anon_*` → `user_*` pair: `UPDATE` jobs, uploads, cloned_voices, clone_uploads, bookmarks; copy `playback_positions` keeping the later `updated_at` per book, then delete the anon rows |
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

Limiters in source (Implemented; name, cap, window, fail mode):

| Name | Cap | Fail | Name | Cap | Fail |
|------|-----|------|------|-----|------|
| `uploads` | 10/1m | closed | `text-upload` | 15/1m | closed |
| `jobs-create` | 5/1m | closed | `jobs-takehome` | 5/1m | closed |
| `jobs-stream` | 20/1m | closed | `tts-live` | 20/1m | closed |
| `tts-preview` | 15/1m | closed | `tts-voices` | 60/1m | closed |
| `tts-clones` | 5/1h | closed | `clone-preview-cache` | 120/1m | **open** |
| `clone-preview-render` | 6/1m | closed | `youtube-search` | 8/10m | closed |
| `auth-email-address` | 3/10m | closed | `auth-email-ip` | 20/1h | closed |
| `storage-read` | 600/1m | **open** | `client-log` (`/api/log`) | 20/10m | **open** |

`clone-preview-cache` guards reads of an already-baked preview; `clone-preview-render`
guards a new Fish bake (`src/app/api/tts/clones/[id]/preview/route.ts`).

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
| `ensureTtsJobColumns()` | Idempotent, once per process. The first call checks whether the live schema is already current (one round-trip, including `cloned_voices.accent`, `bookmarks`, and `playback_positions`) and creates any missing index. Later calls in that process do not repeat `CREATE TABLE IF NOT EXISTS`. A Turso `BLOCKED` error waits 5 minutes before another attempt. Otherwise `CREATE TABLE IF NOT EXISTS` for `jobs`, `uploads`, `usage_logs`, `cloned_voices`, `clone_uploads`, `fish_inflight`, `users`, `email_login_tokens`, `youtube_search_cache`, `bookmarks`, `playback_positions` (batched); `ALTER TABLE … ADD COLUMN` for `JOB_COLUMNS`, `UPLOAD_COLUMNS`, `USER_COLUMNS` (`google_sub`, `email`, `name`, `image`, `created_at`), and `CLONED_VOICE_COLUMNS` (`accent`, plus nullable `source_kind`, `source_url`, `source_start_sec`, `source_end_sec`, `source_consented_at`, `preview_storage_path`, `preview_probed_at`); then indexes (`idx_users_google_sub` unique, `idx_bookmarks_user_job`) |
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

Statuses used in practice: `queued`, `waiting`, `processing`, `ready`, `failed`, `cancelled`. `waiting` is a take-home whose file is still being read. A claim that only matches `queued` and `processing` does not pick up a parked book. SQLite cannot alter a CHECK: when a live `jobs` table rejects `waiting` or `cancelled`, `ensureTtsJobColumns` copies the rows into a new table and renames it.

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
`src/lib/uploads/run-extract.ts` and `src/lib/tts/frozen-script.ts` (take-home), `src/lib/tts/stream-timeline.ts` (Live Stream), and
optional Live Listen sample text on `/api/tts/live`.

### Narration script — `src/lib/tts/narration-script.ts`

Audiobook pacing is **pauses and phrasing**, not slower vowels. Fish S2
honors `[break]` (short) and `[long-break]` (extended) in the `text` field
([emotion / special-effect cues](https://docs.fish.audio/developer-guide/core-features/emotions)).
S1 `(break)`, blog `[pause]`, SSML `<break>`, and ffmpeg `atempo` are not used.

`toFishPlainNarration` is what Fish receives: headings on their own paragraph
with ending punctuation, scene-break lines dropped, no square-bracket cues.
A book's own `[brackets]` become parentheses. Allowlisted S2 tags are removed.

`FISH_S2_PERFORMANCE` (default off) is the exception. While it is on, the
same listen-prep request also returns a sparse `marks` list, and Fish
synthesis — the hosted API and the self-hosted lane — speaks
`fishPerformanceScript`: plain words, then a validated S2 tag
(`[whispering]`, `[sighing]`, and the rest of the published cue list).
Unknown tags, crowd effects, and a bracket that is cut or never closed
are deleted, including a tag split across a chunk or a section, so they
are not spoken. A `[break]` is not placed inside quotes, next to a digit,
or after an abbreviation. Lexical cues (whispered, sighed, shouted,
breathless) do not need a mark. A delivery tag continues into a following
quoted sentence, including the first sentence of the next section when
the previous section ended on that delivery. Generated audio codes are
not carried across sections. The marks file is read beside packing and
is not awaited, so a miss or a slow object does not hold first audio.
Hosted temperature stays at the API default (0.7, 0.7).
`FISH_S2_HOSTED_SAMPLING` is a separate switch that sends
`MODAL_S2_SAMPLING` (default 0.9, 0.9) and
`condition_on_previous_chunks`. 0.9 is not bundled with the tags: it
changes variance on untagged sentences too, and fish-speech #1280 found
higher temperatures add variability rather than making a tag stronger.
The self-hosted container already samples at 0.9 and does not read this
flag. While the performance flag is on, the section cache hashes the
spoken script and the variant gains `-perf` / `fish-performance-v1`, so
a plain take and a tagged take do not collide. With the flag off the
key stays the frozen section text and `fish-plain-v1`. Edge, Google,
Kokoro, and Paradee stay on their own scripts.

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

There is no book-level `[conversational seminar tone]` prefix. The job is marked **ready** when every section index is mastered and staged, before `full.mp3` exists. The lease stays for the join in that same tick. The player plays the section files while `audio_storage_path` is still null, and the download route concatenates if the full file is missing. A thrown join leaves the book ready with the warning "The full download is still being prepared." A book with holes is still not marked ready. A book with holes is **failed**, with the audio that exists left in place and `progress` under 100 (`process-job.ts`). A second pass overwrites `full.*` only when DeepFilter is opted in, or when the join did not already run the chain (single section, WAV). Fish fan-out is 4, or 5 when no live Fish request is in flight (`TTS_TAKEHOME_FANOUT` can pin it). It is not a fixed 5. Clone ticks claim toward the batch size, not that Fish cap.

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
`playbackRate` (not Fish generation speed): **0.8–1.5** in **0.05** steps,
including **0.95×** and **1.35×**. A fresh player starts at **1×**
(`DEFAULT_PLAYBACK_SPEED`). The listener's choice is stored in
`localStorage` under `ec-player-speed` (`SPEED_PREF_KEY`,
`src/hooks/use-playback-speed.ts`), so it survives a reload and carries to
the next book. One quiet tap control (`src/components/player/speed-control.tsx`).

### Document upload — presign + R2 PUT + near-request extract

Vercel never buffers the document; a Vercel function body above ~4.5MB fails with `FUNCTION_PAYLOAD_TOO_LARGE`.

Extract runs on the always-on VPS. Parsing (unpdf / mammoth / JSZip) runs on
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
6. **R2 (production): a playback `Range` is a same-origin 206.**
   Chrome's first request for a book is `bytes=0-`. Answering that with a
   206 through to the last byte keeps one response open for the whole file.
   `cappedPlaybackRange` reads 256 KiB (`PLAYBACK_OPEN_RANGE_BYTES`) via
   `openObject`, with the real total in `Content-Range`. Chrome's next read
   is another `Range` on this same URL (`bytes=262144-` after the first
   window, a closed slice, or `bytes=-N`). That read is served here too.
   A 302 of it would send the element to R2, a different origin. Chrome
   then raises `MEDIA_ERR_NETWORK` (code 2). The player reloads, the clock
   returns to 0:00, and the notice is "Couldn't play this part." A missing
   Xing/Info/VBRI header does not stop the start: the duration comes from
   the first frames plus the `Content-Range` total. A finished book's
   `full.mp3` playback range is shifted past a leading ID3 tag. The stored
   object is not rewritten, and a named download still 302s to that object.
   Chapter titles are UTF-16, so the tag contains `FF FE` pairs that parse
   as MPEG-1 Layer I frames. The demuxer skips the tag on the first open,
   then a seek back to zero scans those bytes and Symphonia stops with
   "unexpected end of bitstream" (media error 3). Hiding the tag makes byte
   0 the first audio frame. The `Content-Range` total is the audio length.
   A request with no
   `Range`, and a named `?download=`, still 302 to a presigned GET
   (`directObjectUrl` → `getPlaybackUrl`, 12–13h, signing time floored to
   the hour). A playback 302 (no `download` name) is
   `Cache-Control: private, no-store` and `Vary: Range`, so a cached
   redirect cannot satisfy a later Range and send Chrome to the tagged
   object on R2. A named download stays `private, max-age=3600` on its
   own URL. The
   download signs `response-content-disposition: attachment` and
   `response-content-type: application/octet-stream`. A presign error falls
   through to the proxy below.
7. Proxy fallback: `.pcm` (wrapped as WAV, full buffer, small sections), local
   disk (dev/tests), and `STORAGE_DIRECT_R2=0` (kill switch). MP3 / WAV / Ogg
   on R2 stream `openObject` — the `Range` is forwarded and the response is 206
   of that slice only. Local files stream with `createReadStream`.
8. Suffix ranges (`bytes=-N`) are the last N bytes.

Proxy headers: `Cache-Control: private, max-age=3600` and
`Vary: Range, Cookie`. `no-store` makes Chrome's media element fail on a
normal cached load (the same bytes play with DevTools "Disable cache").
The private max-age lets each Range window be reused. Vary on Range keeps
one window from answering a later slice. Vary on Cookie keeps a different
session on this browser from replaying the bytes. `Accept-Ranges: bytes`,
`X-Accel-Buffering: no`. `maxDuration` 300 so a long progressive read is not
cut at the platform default. The player src carries `pb=2` (see
`src/lib/player/playback-url.ts`) so a browser that already cached
`?v=<updated_at>` misses. A media error (network, decode, or unsupported
src) reloads that URL once with `r=1` before the notice. A successful
seek or `canplay` clears a leftover notice. Seeks assign `currentTime` on
the existing `<audio>` (`preload="auto"`); they do not change `src` except
for that one recovery.

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
| `listCatalogVoices(filters)` | Slim catalog. Until Esther's endpoint is set: Drew (`drew`), Ava, Libby, George, then Walter (`sowell`) when its endpoint is set. After that: Drew, Esther (`heart`), George, then Walter. Clones are merged in the voices API. Echomancer Andrew (`echomancer-andrew`), Andrew (`standard`), and Ryan stay unlisted and still resolve for stored books. A new request that names Ava or Libby uses Esther only once that endpoint is set, and stays on Edge until then. A new request that names Echomancer Andrew uses Drew |
| `getCatalogVoice(id)` | Static / `clone:…` (user-scoped) / `research:` / live `or:…` / legacy `fish-narrator` |
| `getDefaultCatalogVoice()` | Drew (`drew`). A no-voice request is 503 `DREW_NOT_CONFIGURED` when that endpoint is unset |
| `isVoiceAvailable(voice, hdEnabled)` | Hide HD unless gate allows (fish clones always listed) |

Drew's Kokoro pack is pinned to tensor index 300 when the voice loads
(`pin_style` in `scripts/sowell/style.py`). Infer still reads
`pack[phoneme_count - 1]` and still receives Drew's 1.0 speed, applied
once. The take-home cache variant is
`drew-kokoro82m-ft-stageA-step00900-style300-v3` (`v2` was Kokoro speed
0.88; the key stores the app speed, which stayed 1.0). Deploy steps are
in `docs/kokoro-onnx-runbook.md`. Walter and George stay
on the length index: George's rows are flat across 100–510, and Walter's
pack was not in the repo or on a volume, so `SOWELL_FIXED_STYLE_INDEX`
stays unset and those cache keys do not move. `DREW_PROSODY_RULES` (default
off, take-home worker only) appends `-prosodyG` via `drewCacheVariant` and
sends `prosody: "G"` on the Drew POST. The container edits F0 inside that
same forward (`prosody_rules.py`, recipe G: accent 0.7, 3 st declination,
exclamation register, yes/no final rise). Mr., Mrs., Ms., Dr., and etc.
are not sentence breaks, because those phonemes have no period. A missing field is the stock
forward and does not consult the container env, so an unruled cache key
cannot store a ruled take. Walter and George never take the recipe. Unset
the flag to roll back; the base key still finds the takes recorded before
it. Deploy the app that returns `x-kokoro-prosody: G` before turning the
flag on, or the worker rejects the audio instead of caching the stock take
under the new key.

### Fish voice cloning + live HTTP stream

| Piece | Role |
|-------|------|
| `FISH_API_KEY` | Native Fish API — create model + synthesize clones / Fish catalog |
| `CLONE_TTS_PROVIDER` | Unset or `modal` (default when `MODAL_S2_TTS_URL` is set): self-hosted S2-Pro, then direct Fish. `fish` is direct Fish only; a leftover `openrouter` value is read as `fish` because Drama 3 is gone. Both remaining engines speak the clone — Fish trained the reference — so the fallback is not a narrator change. Missing key/sample, HTTP errors, invalid audio, and failed streams fall back to Fish. Caller cancellation propagates. A take-home book pins its engine once (`jobs.provider_pin`) and a pinned book sets `allowFallback: false` per call, so a failure surfaces instead of changing engine; live listen is unpinned and still falls through. There is no substitute voice: with neither engine available the request fails visibly. |
| `POST /api/tts/clones/upload` | JSON presign `{ fileName, contentType, byteSize }` → PUT URL for `clones/<id>/sample.<ext>`. Ownership in `clone_uploads`. |
| `POST /api/tts/clones` | JSON `{ uploadId, title?, accent?, youtube?, acceptQualityRisk? }` → download stored sample → browser-metric gate (`analyzeCloneSampleBuffer` on 16-bit WAV; fail → 422 `SAMPLE_QUALITY`, no Fish) → worker reference gate (`POST $WORKER_URL/reference-quality`; fail → 409 `SAMPLE_RISKY`, upload stays pending) → `cleanupCloneSample` → Fish `POST /model` → `cloned_voices` (same id, `accent` default `american`). `acceptQualityRisk: true` continues a risky sample; echo clips then get one DeepFilterNet pass. Optional `youtube` `{ videoId, startSec, endSec, consent: true }` stores the source URL, range, and consent time. Multipart rejected (`USE_PRESIGN`). App max **32 MB**; Vercel body is JSON-only. `REFERENCE_QUALITY_GATE=0` skips the worker check. |
| Catalog id | `clone:<uuid>` · provider `fish` · `providerVoiceId` = Fish reference id |
| Synth path | A book already stored as Andrew, Ava, Libby, Ryan, or Michelle → `edgeTtsProvider`. Heart → the Kokoro CPU app (`af_heart`). A book already stored as Clara → `fishTtsProvider` with curated `reference_id`. A book already stored as Randolph is played from its saved file and is not synthesized. User clones → Modal S2-Pro when `MODAL_S2_TTS_URL` is set, then `fishTtsProvider` with the account `reference_id`. No URL skips Modal. Legacy `fish-narrator`: Fish endpoint **without** `reference_id`. Never send OpenRouter catalog UUIDs as `reference_id`. The GPU class defaults to `max_containers=1` (`S2C_MAX_CONTAINERS`). Production `echomancer-s2-clone` stays `min_containers` 0 and `max_containers` 1. Raising it needs explicit owner approval. Step 8c of `docs/s2-gpu-staging-runbook.md` keeps `max_containers` at 1 after a deploy. Do not set it from `MODAL_S2_MAX_GPUS` (default 20); that value is the worker lease count, not the container cap. A plain `modal deploy` resets an override back to the baked cap, and `/ready`/`status()` keep reporting the deploy-time value. `min_containers` stays 0. The deployed class already has `@modal.concurrent(max_inputs=1)`, so a second POST is placed on another container (its own restore) rather than answered 429. A 429 `lane_busy` body stays `ModalCloneLaneBusyError` (busy, not cold). |
| Clone engine pin | `jobs.provider_pin` (`modal` / `fish`) is written on the first tick that has a clone voice, and every later section uses that engine only. A legacy `drama3` row is re-pinned to `modal` or `fish` (`resolveLegacyDramaPin`) before any section renders, so Drama 3 is never called again and the rest of that book finishes in the real voice. A per-section failure never changes it: the book parks instead (`clone_wait_started_at`, `MODAL_S2_DEFER_MS`, default 25 min), and only when that budget is spent does it switch and write `warning`. A cold pool and a hard provider fault share that clock (`deferForColdClonePool` with `reason: "provider-fault"`), but a provider fault writes `CLONE_PROVIDER_FAULT_WARNING` instead of the cold-timeout warning, so the finished book says the service was broken rather than slow. `MODAL_S2_DEFER_MS=0` skips the park and continues the tick. That branch does not rewrite `provider_pin`. |
| Clone lanes | One book sends one HTTP batch call at a time on its own H100 (`MODAL_S2_BATCH_SIZE`, default 24, max 32). A second book queues on that same GPU. Production `max_containers` stays 1, so it never opens a second H100. `modal_gpu_leases` still counts toward `MODAL_S2_MAX_GPUS` (default 20) and `MODAL_S2_MAX_GPUS_PER_USER` (default 5); those counters do not raise the container cap. `MODAL_S2_SECTION_CONCURRENCY` (default 4, max 8) is only the legacy fan-out claim size (`cloneTakehomeFanoutCap`); a book wave does not take that slot and does not open a second lane. The deploy-time and production live cap stay `max_containers` 1 until the owner approves a change. **Rows per call is the throughput knob, not lanes**: a container decodes every row of a call in one batch (measured 2.9x realtime for a one-row call, 35–65x for a full one), so `planModalCloneLanes` fills a call toward `batch` before opening the next and the tick claims up to `batch` sections. The old round-robin split made 5 sections into four 1-row calls, which all landed on one container on `job db10a6d6` and ran at 2.93x (246s of audio in 84s of GPU wall) instead of ~24s. A cold call's character cap is derived from the **wait a call can actually be granted**, not from the steady-state timeout: `modalLaneCharCap` = (`MODAL_S2_COLD_WAIT_MS` − a 70s restore/prep margin) × 100 chars/s, which is **8,000** at production defaults — the same value as the operator's stopgap. That cap is the first call of a book and any call after the container has scaled away. Once the container has answered, `planModalCloneBookWave` does not pace the remainder to the listen buffer. `cloneGenerationMs` uses `MODAL_S2_NARROW_FPS` (default 60, about 2.8× / ~44 chars/s) for one row, `MODAL_S2_WIDE_FPS` (default 190, about 8.8×) at four rows, and the 24-row smoke (528 chars/s, about 33×) at 24 rows, interpolating between four and 24. Book `e745d067` measured one row at 2.7–2.9× and a 4-row call at 9.2×. The old curve that slowed every added row down toward 33 chars/s is not the planner. A remainder that fits in two proxy-safe batches (that 9-section, ~11.8k-character book) is one wide batch after section 0. A longer book sends 24 rows of 4,000 characters once `/ready` reports `audio_transport: r2` (the MP3s are objects; the JSON is keys; about 211s at the 24-row smoke rate). Until that Modal deploy the page is the inline body ceiling: the widest page that fits the body's estimated MP3 bytes. 24 × 4,000 is about 130 MiB of base64 and is not sent to a container that still returns `audio_b64`. Cold first light stays one small section. The warm HTTP wait is 400s, under the proxy's ~542s kill. `MODAL_S2_WARM_LANE_MAX_CHARS` can only lower that warm cap. The book uses one GPU; `min_containers` stays 0. `modalLaneCharCeiling` bounds even `MODAL_S2_LANE_MAX_CHARS`, so an override can only lower a lane. The wait for a given call is sized from that call's own text (`modalLaneWorkMs`), so the packer and the timeout cannot disagree. **A row must fit too**, so clone sections are packed from the book's length inside 2,500–6,000 characters after the 1,000-character opening (`MODAL_S2_SECTION_CHARS` remains the 4,000 default when there is no total): a row renders its paragraph units in sequence at ~50 chars/s, so a 7.7k section needs ~154s of generation and cannot render inside any call budget. Packing at the Fish 8,000 ceiling is what froze the four 7.7k sections on `job 7e4a8b48` (2026-11-06) that stalled for 4m03s and never returned. A clone outline frozen wider than the cap is re-packed once, only while nothing has been published. A multi-section call that misses its budget is retried **one section per call** and never classified as a cold placement; only a single-section miss fires the off-path snapshot warm. Multi-GPU in one container is not used: Modal documents GPU snapshots as generally incompatible with it. **Section 0 is rendered alone first** (`MODAL_S2_FIRST_LIGHT`, default on) because a container answers a whole batch of rows together, so a section 0 batched beside a neighbour is exactly as late as that neighbour. That call's pack abort stays `MODAL_S2_FIRST_LIGHT_WAIT_MS` (default 75s). The HTTP wait is `MODAL_S2_PLACEMENT_BUDGET_MS` (default 360s, ceiling 482s) on the same in-flight request. A container that has started is not cancelled. If section 0 cannot be placed the fan-out is skipped. A clone book also pre-warms the pool at the top of its tick (`prewarmModalCloneSnapshot`), so the restore overlaps extract, packing and the reference download; one cheap RPC, never awaited, and `min_containers=0` still leaves no GPU running. The voice list and preview Play do not start that RPC, and they do not POST `/clone-prewarm`. A clone book restores on its own tick. The worker may still call `prewarmClonePoolForUpload` when it accepts an extract; that function returns false and does not start a GPU. A container that finished restoring before section 0 is ~16–20s to first audio. One that is still booting does not take the HTTP call — Modal starts another container — so a fast click stays ~68s. Stock-only accounts never start a GPU. A book-start prewarm is keyed by job id, so a second book is not swallowed by the first book's 3-minute cooldown, and it still refuses when `modal_gpu_leases` is at `MODAL_S2_MAX_GPUS` or that user's cap. Voice-list and extract prewarms stay on the shared 3-minute cooldown and do not stack a second container on one that just started. A client timeout does not re-POST those sections in the same dispatch: the sync handler keeps rendering, and there is no Modal cancel. Warmth for a book is its own container, not `warm_containers > 0` while another book's lease is live. Section 0's publish skips transcript QA (a fresh Whisper process); later sections do not. `loadCloneReference` starts beside packing. |
| Clone batch contract | `POST /synthesize_batch` returns `items: [{ key, audio_b64, duration_s, units, truncated_units }]`, `{ key, storage_key, audio_bytes, duration_s, units, truncated_units }` when the container uploaded the MP3, or `{ key, error, error_code }`, plus `build`, `container_id`, `seed`, `reference`, `performance`. The client reads `audio_b64` and still accepts legacy `audio_base64`. A `storage_key` is fetched only when it matches `s2-takes/<job>/<call>/<item>.mp3`. A row with neither audio nor an error fails the call rather than staging silence. `/ready` reports `audio_transport`. A missing field is the inline build. A `422` naming the reference is a non-retryable `ModalCloneReferenceError`; `502`/`503`/`504` and transport timeouts are `ModalCloneColdError`; any other `5xx` (or a body that is not MP3) is `ModalCloneProviderError` — a hard fault, retried once, then surfaced with the container's own message. It parks on the same defer clock and takes the same documented fallback, so a broken deploy never fails a book with `Section 0: Modal clone already retried` (`job 5f09ee0e`, 2026-11-06). |
| Reference decode | `validate_reference_audio` measures **every** container, not just WAV: `decoded_reference_stats` reports `format: "decoded"` and a real `seconds`/`rms`/`peak` for MP3/M4A/OGG/FLAC/WebM. Decoding is `s2_contract.decode_reference_samples` — standard library for WAV, ffmpeg otherwise — and `reference_float_samples` downmixes and resamples for the codec and for Whisper. `encode_reference` and `transcribe_reference` never touch `torchaudio.load` or `av.open`: on this image those are PyAV-backed, and the PyAV under fish-speech's lockfile predates the `metadata_errors` kwarg current `faster-whisper` passes, so every non-WAV reference raised `TypeError` and answered 500 on all four lanes while a WAV probe still returned 200. `modal/test_s2_reference_decode.py` decodes real fixtures for each container and fails if either library returns to that path. |
| Clone snapshot | `@modal.enter(snap=True)` starts a `GpuExecutor` thread, loads weights, compiles and runs a text-only **and** a referenced forward pass with a deterministic in-process WAV (`s2_contract.warm_reference_wav`), then `reset_state()` clears the KV cache and last audio so no customer speech and no dead pages enter the snapshot. All CUDA runs on that one thread; request handlers submit via `_run_on_gpu`. A restored snapshot is pinned to the thread that owned the context, and Modal serves a sync `@modal.fastapi_endpoint` on a fresh thread, where the first `cublasCreate` fails with `CUBLAS_STATUS_ALLOC_FAILED` while `.remote()` still works — that was the staging 500 on `/synthesize_batch`. `engine.selftest()` runs the same allocator paths at boot. `snap=False` publishes a heartbeat and starts a refresh timer; `@modal.exit()` removes it, so `S2C_HEARTBEAT_TTL` is 90 s (a call-triggered heartbeat alone would need hundreds of seconds and let a scaled-down container inflate `warm_containers`). `/ready` reads only live heartbeats of the current `S2C_BUILD`. `warm_containers` can still exceed `max_containers` for a moment during a replace, which is documented in the runbook. `boot` is `restored` only when the host monotonic clock went **backwards** (proof the image resumed on a different, younger worker); otherwise it is `unknown`. There is no `compiled` value: a container cannot prove it compiled, and pid equality is useless because Modal runs the app as pid 2 both before and after a restore. Modal's log line is the authoritative record, a restore duration is only measurable from outside, and `snapshot_age_s` is an age, not a duration, reported only for a proved restore. "~90 s" is a planning target in the runbook, not a duration this file has measured for every cold start. A measured restore cited for the books in this section is about 57 s. A book waits at most `MODAL_S2_COLD_WAIT_MS` (code default 150 s, hard ceiling 180 s — `modalCloneColdWaitMs` clamps anything longer, so a book cannot be configured to sit through an 8–16 min compile or the proxy's ~542 s kill). Past that budget the call is `ModalCloneColdError` with `scope: "placement"`: the HTTP wait is dropped, dispatch tries the unstaged sections once on another container, and `kickModalCloneSnapshotWarm` starts `modal run modal/s2_clone_warm.py::cover` (one RPC `status()`, detached, 20 min cooldown) when `MODAL_TOKEN_ID` or `MODAL_S2_WARM_CMD` is set. `MODAL_S2_WARM_HOOK=0` disables it. A probe miss is `scope: "pool"` and is not retried. `boot=` is not the hard rule (`placement_kind` in `s2_contract.py` classifies wall time: restore ≤ 150 s, compile ≥ 300 s). After a deploy, `scripts/s2/post-deploy-cover.sh` runs `::restore_check`: one container at a time (`max_containers` stays 1), and a compile is followed by exactly one cold restore. Startup logs `[S2C] compile_cache hit=… compile_s=…`. The artifacts live on the `echomancer-compile-cache` volume (`TORCHINDUCTOR_CACHE_DIR`, `TRITON_CACHE_DIR`, and `torch.compiler` mega-cache when that torch build has it), keyed by torch version, GPU name, compute capability, `S2C_ENGINE`, and the compiled source. A run is published (`current.json`) only after self-test. An empty, partial, or corrupt cache compiles fresh into a new run and does not delete the old one. `Volume.commit()` runs inside `@modal.enter(snap=True)` before the snapshot; `reload()` is not called. `S2C_COMPILE_CACHE=0` is the kill switch. `finish()` logs `compile_cache hit=… compile_s=…` for the build. The publish hook on a restore logs `compiled=no compile_s=na` and labels the frozen number `snapshot_compile_s`, so a restored container is not reported as a fresh compile. HTTP still cannot finish a snapshot. |
| Clone endpoints | Each `@modal.fastapi_endpoint` is served at the root of its own hostname, so there is one absolute URL per endpoint and nothing is appended. `MODAL_S2_TTS_URL` (batch, required), `MODAL_S2_SYNTHESIZE_URL` (single, optional, falls back to the batch host), `MODAL_S2_READY_URL` (probe, optional, never derived). `modal/s2_endpoints.py` and `modal-clone.ts` both reject a URL carrying a path, and reject a ready URL equal to the batch host. A 404 on an endpoint says the configured host is wrong, not that the pool is cold. A 429 is `ModalCloneLaneBusyError` (busy, not cold). With `max_containers` 1, a second book's POST queues for that same GPU and does not open a second container. The 429 path stays as the busy backstop. |
| Live preview | `GET/POST /api/tts/live` opens Fish HTTP first, then pipes **chunked** MP3 (`latency=balanced`). Fish 4xx before bytes → JSON, never HTML `/500`. A saved clone's preview is *not* rendered here. `GET /api/tts/clones/[id]/preview` never synthesizes. `clonePreviewLookupPaths` (`src/lib/tts/clone-preview-store.ts`) tries, in order: the fish v2 key (where a new bake is stored), then the legacy engine-free key that holds pre-S2 Fish 2.1 Pro MP3s, then an older s2-pro v2 key. Both real engines speak the reference Fish trained. A remembered `preview_storage_path` is streamed only when it is one of this clone's fish, legacy, or s2-pro keys. A 16-hex `v` token names one of those keys. The stream peeks the opening bytes and refuses a zero-filled or non-audio object; the three-key walk still refuses a silent file, and a token miss still tries the remembered key first. The picker URL is `clonePreviewMediaUrl`: HMAC-SHA256 of the object key under `echomancer-clone-preview-v1`, keyed by `getSessionSecret()` (`SESSION_SECRET`, else `INTERNAL_JOB_SECRET`; no new env var), compared with `timingSafeEqual`, path confined to `previews/clones/<id>/<hash>.mp3`. The signature has no expiry. A full read is `public, max-age=31536000, immutable` with `Vary: Range`. Any other range is `206` with `Cache-Control: private, max-age=3600`, CDN `no-store`, and `Vary: Range` (`bytes=0-` stays a 200). A 304 is CDN `no-store` and is not returned for `*` or for a partial range. Rotating the secret fails a new fetch; a cached full 200 can remain for the year. The proxy skips `Set-Cookie` on that prefix. The authenticated route stays `private` with `Vary: Range, Cookie` and CDN `no-store`. `Server-Timing` reports `open` and `total`, and `X-Echomancer-Preview-Resolve` is `stored`, `token`, or `walk`. `202` and `409` are `private, no-store`. `GET /api/tts/voices` returns that signed `previewUrl` from a remembered key and does not prewarm S2. An unknown clone is stated (at most three keys, four at a time); a miss is remembered for ten minutes. The list does not bake. Drama 3 has no key. A miss enqueues one Fish bake of `PREVIEW_TEXT` (`cloneProviderPin: "fish"`, stored only under the fish v2 key) and answers `202 PREVIEW_PREPARING`. A failed bake is `409 PREVIEW_BAKE_FAILED` until Retry. The request path does not call the S2 pool. Storage for a new bake is written only under the fish key, so a take from an unintended engine cannot be stored as this clone's preview. |
| Stream path | `synthesizeStream` yields Fish response body chunks (not a buffered unary clip) |
| Table | `cloned_voices` (session-scoped, soft-delete, `accent` catalog label, optional YouTube `source_url` / range / `source_consented_at`). YouTube rows stay private: Fish `visibility=private`, and there is no share path. `clone_uploads` holds the pending sample. |
| YouTube clip | Clone screen: paste a link or search. `GET /api/tts/youtube/search` requires a signed-in `user_*` (anonymous sessions are 401 `SIGN_IN_REQUIRED`) and keeps an 8-per-10-minute fail-closed limit. It calls YouTube Data API v3 with `YOUTUBE_API_KEY`: `search.list` (`part=snippet`, 100 quota units) for title, channel, and thumbnail, then `videos.list` (`part=contentDetails` only, 1 unit) for duration. Hits live in `youtube_search_cache` for 10 minutes, shared across isolates. A pasted link still opens the player when the person is signed out or the key is missing. The picker embeds the IFrame player (720p) and a 10–40s range (default 20s). The two handles sit on a scrolling timeline so they stay apart on a long video: a handle moves only its edge and stops at 10s or 40s, and the span between them moves the window without changing its length. The label and `POST /api/clips` use those whole seconds, so a nudge cannot send a window past the video. Fine tune uses the same 30-minute line as the segment actor (`CLIP_LONG_SOURCE_SEC`): at that length it stays under the timeline, and on a shorter source it appears at the first timeline gesture and then stays for the rest of that screen. It does not hide on blur, pointer-up, or a timer. Each step moves one edge by one second and stops at 10s, 40s, and the video, a held step stops when the edge cannot move, and that step is the same window the label and POST use. "Use this clip" is the server path on every layout: an allowlisted email (`YT_SERVER_CLIPS_EMAILS`) queues `POST /api/clips`. There is no tab capture, share-sheet, or microphone step. While the worker runs, the button reads "Fetching the clip" and then "Preparing the voice", with a thin bar that stays under full until the clone is ready. `completeStoredClone` high-passes at 80 Hz, always sets Fish `enhance_audio_quality`, and adds a nova-3 transcript for a YouTube clip when that call returns within 3 seconds. The worker picks the Apify actor from the source length stored at queue time (`youtube_clips.video_seconds`): sources of 30 minutes or more (`CLIP_SEGMENT_SOURCE_SEC`) run `entertained_rattlesnake/youtube-audio-segment-downloader` first with `{ videos: [url], format: "wav", startTime, endTime, transcribe: false }` and `maxTotalChargeUsd=0.15`; shorter ones run `utils/youtube-link` with `{ videos: [{ url, timeframe, audioQuality: "best" }] }`, the original container, and `maxTotalChargeUsd=0.05`. A classified failure (bot check, `sabr-gapped`, timeout, empty or invalid file, wrong duration, past the 16 MiB cap) falls back to the other actor once; a 402 budget stop does not. Each attempt has its own wall clock (90s, or 180s for the link actor on a long source), is long-polled with `waitForFinish` (max 60s), and aborts its run on timeout. The segment actor reports SUCCEEDED even when the video failed: the audio and the `FAILED_<videoId>.json` detail live in the run's key-value store, not the dataset. Clip length is ffprobe on the downloaded file, because the dataset `duration` is the full video. Once the run succeeds, the file download starts without waiting for the charge to settle. Spend is read in parallel (`usageTotalUsd`, otherwise the charge events: `AUDIO_DOWNLOADED` $0.015 plus `AUDIO_LONG_EXTRA` $0.004 per 10-minute block, or `video-started` $0.05 plus `audio-minute-processed` $0.04 per started minute), with a floor of $0.015 / $0.09 on a successful download. Memory stays at the actor default. An empty dataset with no status message is classified from the run log. Age, sign-in, bot-check, and "no usable connections" are `restricted` and are not retried. `audio-download-failed` and `sabr-gapped` are `transient` and retry once. |
| `PATCH /api/tts/clones/[id]` | Owner may set `accent` (`american` / `british` / `australian` / `irish`). The label is catalog-only (`Shauna · British` in the route test). It does not call Fish and it is not a training parameter. The Clone screen does not render a picker: new clones are stored as `american` (`DEFAULT_CLONE_ACCENT`). |

### Self-hosted clone: modules and the one engine decision

| Module | What it decides |
|--------|-----------------|
| `tts/providers/modal-clone-guard.ts` | Engine pin parsing, lane/batch/cold-wait/defer knobs, the 900 chars/min truncation rule, and non-blocking `usage_logs` writes (`recordModalCloneUsage`). There is no daily character cap. The old `ensureModalCloneJobAllowed` gate is gone. |
| `tts/providers/modal-clone-lanes.ts` | `planModalCloneLanes` fills a call toward `batch` before opening the next, because rows are decoded in one pass and a one-row call runs at about 2.9× realtime against 35–65× for a full one. Those multiples are audio-seconds per wall-second, measured, not a rate the next book is guaranteed to hit. `modalLaneCharCap` is the cold-wait generation budget (`modalCloneColdWaitMs` minus `MODAL_LANE_RESTORE_MARGIN_MS`, 70 s) times `MODAL_LANE_CHARS_PER_SECOND` (100). It is not the steady-state 60 s timeout. `modalLaneCharCeiling` bounds even `MODAL_S2_LANE_MAX_CHARS`, so an override can only lower a cold lane. `planModalCloneBookWave` is the book schedule: section 0 alone and cold-sized, except a short piece (about 1,959 characters / ~2.1 minutes) whose whole remaining book adds no generation beyond that section and so goes out as one call, then the largest proxy-safe batch while `clonePoolStillWarm` (default hold 10s) — each call after section 0 is the largest prefix that fits the warm character cap, the response body, and the 400s wait, and one cold-sized call again after that hold. It is not sized so playback at 1.5× stays ahead. Warm calls plan one row at `MODAL_S2_NARROW_FPS` (default 60), four rows at `MODAL_S2_WIDE_FPS` (default 190), and a 24-row call at the measured 528 chars/s (~33×), with the widths between four and 24 interpolated. Transfer is 12s per 43,907 characters. The wait is `modalCloneWarmWaitMs` (400s, under the 542s proxy kill). The 1.5× buffer is reported and does not choose the page. A book of 20,000 characters or less shares an already-running GPU even when the ceiling has room. The warm character cap is one batch of the widest section (24 × 6,000), then the warm wait and, while audio is inline, the 80 MiB body. Section width comes from `planCloneSectionChars`: 1,000 for section 0, one call for a book of 20,000 characters or less, then a 1–2 minute page, a 5–6 minute page, and even pages inside 2,500–6,000 characters. While the container returns `audio_b64` the 80 MiB body keeps a 10-hour book at 22-row pages. An `audio_transport: r2` container uploads the MP3s, so that book is 24-row pages. `simulateClonePlayback` plays a 10-hour book at 1× and is what fails if that ramp stalls. `simulateCloneFleet` gives each book that ramp until the GPU ceilings, then one overflow pair. `chooseCloneGpuTurn` is that overflow schedule: the next unstarted book gets one section once every playing listener keeps slack, then each turn is the feeding call with the least silence and the highest characters per wall second. A one-row call does not feed two 1.5× listeners. `simulateCloneListeners` replays that loop for two and three books. `planMixedCloneBatch` packs rows from several books into one call, each with its own reference; the deployed container takes one reference for the call, so `MODAL_S2_MIXED_BOOK_BATCH` stays off and the tick does not send that payload. `modalWarmLaneCharLimit` is the minimum of that batch page, the warm-wait budget at the width's realtime factor, and an 80 MiB base64 body estimate; `MODAL_S2_WARM_LANE_MAX_CHARS` can only lower it. `sectionSeedEpoch` turns a retry into a different take. |
| `tts/providers/modal-clone-prefetch.ts` | `selectCloneRenderIndexes` fills the batch with cache misses and steps over takes already stored. `selectClonePublishBatch` walks claimable indexes in order and stops at the publish window (8), at an index still on the GPU, and at the first uncached index. |
 | `tts/providers/modal-clone-dispatch.ts` | Runs the lanes and stages every rendered section. `bookWave` forces one lane even when the caller passed a fan-out, does not take the old cap-1 `modal-clone` slot (the durable cap is `modal_gpu_leases`), and pipelines the ramp: the next call starts when the previous returns, and `publishStaged` masters that call's audio without holding the GPU. `firstLight` renders section 0 alone (or the whole short piece, when that one call is no slower), publishes it through the real per-section path, and only then starts the ramp on that same GPU. A container answers a whole batch together, so a section 0 batched beside a neighbour is exactly as late as that neighbour, and a 24-row call behind one minute of audio stalls the listener. If section 0 cannot be placed the ramp is skipped. A gateway miss on a warm call is retried as one cold section and does not kick `::cover`. A gateway miss (502/503/504) that misses the restore budget is retried once on the same GPU. Production `max_containers` stays 1, so the retry does not open a second container; a pool that is already empty is not. A client timeout (`clientAborted`) is not retried in the same dispatch: the sync handler keeps rendering those sections, and the book parks. A warm-budget call parks for the warm HTTP wait (400s). A first-light HTTP wait is `MODAL_S2_PLACEMENT_BUDGET_MS` (default 360s, capped at 482s). The 75s figure stays the pack abort only. A timeout after that budget parks for the rest of the restore plus opening generation at the narrow rate (~98s), inside the 180s scaledown. A started container is not aborted and is not cancelled. An unstarted pending call is cancelled and the job is sealed so the retry does not open a second GPU. A backoff that posted nothing parks only for the remaining 30s. A positive hold leaves the row `processing` with a lease token this process does not hold, expiring with that hold, because a claim that lists `queued` rows and does not read `sched_not_before` would take a queued park early; the VM claim waits for the same lease. That park starts `clone_wait_started_at` when unset and switches to Fish once `MODAL_S2_DEFER_MS` is spent. A published section clears the stored clock and the in-memory copy, so a later timeout in the same tick does not switch a book that already published. `cold` is set when nothing was staged, so the tick can park instead of switching. A missed placement kicks the off-path RPC warm only when no S2 flight is `running` or `still_live`. `committedCall` posts the indexes `chooseCloneGpuTurn` already sized, so a growth call wider than the buffer is not re-planned down to one row. |
 | `tts/providers/modal-clone-warm.ts` | `kickModalCloneSnapshotWarm` starts `modal run modal/s2_clone_warm.py::cover` after a placement misses the restore budget (20 min cooldown, off the book path, may sit through a compile). It returns false while an S2 flight that already has a function-call id is `running` or `still_live`, and while this book's own flight is in those states before an id is stored. A flight with no id does not block another book. `prewarmModalCloneSnapshot` does not spawn. Cover's `status()` is a light input; `max_inputs=2` lets it share the container with `render_batch`. The worker does not POST the GPU web endpoints while `MODAL_S2_CONTROL_URL` is set. `MODAL_S2_WARM_HOOK=0` disables the kick. |
 | `tts/providers/modal-clone-pool-warm.ts` | `prewarmClonePoolForUpload` and `prewarmClonePoolForUser` return false and do not start a GPU. The voice list does not call them. A cover started before the book posts `/synthesize_batch` is a spare container. The synthesize call is the one the book uses. |
| `tts/process-job.ts` | `admitModalCloneGpu` leases one GPU per book (`modal_gpu_leases`) and only then calls `chooseCloneGpuTurn`, when a ceiling is already full. `resolveCloneProviderPin` makes the one engine decision; `deferForColdClonePool` parks the book, arms `clone_wait_started_at`, and only after `MODAL_S2_DEFER_MS` pins it to `fish` (the same voice) with a warning — or, with no `FISH_API_KEY`, parks again rather than substituting anything. A cold section does not burn one of the section's attempts. `takehomeSectionCacheKey` is the single content-addressed key for a take — section-0 `balanced` latency plus the per-engine variant — shared by the lane prefetch and the per-section read, so a prefetched take is always found rather than paid for twice. The prefetch skips indexes that already hit that key (`selectCloneRenderIndexes`); `S2 lane staged` is only a GPU row that was just written. Already-staged indexes are mastered while the next uncached batch renders, and a tick with nothing staged still publishes one window of 8 afterwards. `narrationSpeed` is not calibrated on a Modal tick, because the batch request does not send it and a changed speed would miss the take just staged. |
| `modal/s2_contract.py` | Reference-clip and transcript validation, sampling parsing, lane planning, snapshot fingerprint, per-call seeding, container limits, the `GpuExecutor` that owns the CUDA context, boot provenance, the **clone conditioning recipe**: `history_anchor` (anchor each unit to the row's first take), `inserted_pause_s` (clause / sentence / paragraph ladder), the `UNIT_MAX_CHARS` / `MERGE_PARA_MAX_CHARS` / pause constants, `units_summary` (the unit shape a section went out as), and **`split_long_text`** — the total unit splitter (whole paragraph → balanced sentence takes → clause → word → raw slice), which can never emit an over-long unit and therefore can never make a section fail. Stdlib only, so the GPU image gains no dependency and every rule runs in tests. |
| Clone conditioning | `job 12534aaa` (2026-11-06) drifted inside every section — similarity to the reference 0.93 → 0.70, F0 −15–20 Hz, pitch range halved — and reset at each section boundary. That is per-row, so it is the per-row history chain: conditioning unit *n* on unit *n−1*'s generated audio walks the timbre away from the reference one step per unit. `history_anchor` now returns **only the row's first turn** (the take generated from the reference alone) for every later unit, so each one is a single hop from a clean sample. Prompt shape is unchanged; `HISTORY_ANCHOR_FIRST=False` restores upstream. Trimming takes to a short audio tail was rejected: a full paragraph of text beside 1.2 s of audio is a mismatched prompt. |
| Unit width and pauses | Two rounds of tuning blamed the wrong thing. `job 1f0137a1` (first post-#244 book) had 7–13 gaps ≥ 0.35 s per minute against ~6.5 before, so #244 set `UNIT_TARGET_CHARS=200` and #245 moved it to 300 with a 0.22/0.40/0.96 pause ladder. Joel still reported *"it stops and starts every time"*. The cause was never the gap **width**: a unit boundary is a hard splice (each take's own trailing silence is trimmed and a fixed pause inserted), and the **target** — not the ceiling — decided how many there were, so lowering one while the other still forced sentence-sized pieces changed almost nothing audible. There is now **one** width authority, `UNIT_MAX_CHARS = 560`, and no packing target. A paragraph under the ceiling is one generation, so the model places every breath inside it; a longer one is cut into the fewest, most even sentence-aligned takes (`_balanced_pack`: greedy count for the minimum, DP to minimise *and* even out the longest unit, so a paragraph never ends in a one-sentence stub). Measured on two ~17,100-char books: 78/74 units and 68/67 splices at #244, 57/55 and 47/48 at #245, **43/40 and 33/33** now; forced mid-sentence breaks 30/13 → 8/3. The pause ladder is unchanged. The ceiling itself is set by the model: `MAX_NEW_FRAMES` (1,024) at ~21.5 frames/s caps one take at ~47.6 s, and a take that hits it is `truncated` (section retried, then failed), so 560 chars is sized to fit 43.1 s at a pessimistic 13 chars/s and a test reads the constant out of source. A row's **last** take gets no inserted pause, because the app crossfades the join and a trailing paragraph-length block was up to 0.96 s of silence in front of it. **Missing section (still pinned):** the old `_CLAUSE_END` was `(?<=[,:—])\s+`, which requires whitespace after the dash, so `dynamic—something` never split; a 318-char unit made the container answer 422 and `_section_units`' `raise` dropped the whole 1,705-char section. The clause pattern is a zero-width lookbehind over `, : ;` plus the Unicode dash family, `split_long_text` always returns legal units, and the container's guard hard-slices rather than raising: a missing section is a hole a listener hears. |
| Clone book completeness and cache identity | `job 75944dc9` (2026-11-06, after #246) finished `ready` in 32 s with **5 of 11** sections, and Modal's own access log had **zero** requests for the failure window. Three defects hid each other. **(1) The generation allowance refused the book.** A per-account daily character cap (default 500,000) plus a global one (2,000,000) had been exceeded — 492,425 used, 17,022 requested — so an `ensureModalCloneJobAllowed` boolean refused the GPU pool, skipped the lane dispatch entirely, and every section then threw `Clone provider modal failed and this book may not switch engines`, a sentence about a call never made, three times each in about a second. The allowance has since been **removed entirely** (2026-11-07, product direction): no per-account cap and no global cap. `MODAL_S2_USER_DAILY_CHARS` and `MODAL_S2_GLOBAL_DAILY_CHARS` are not read by the running app. A stale worker `.env` does not refuse a book. Engine selection is configuration only (`resolveCloneProviderPin`), and no usage figure can pin a book to the backup engine. Only `usage_logs` accounting remains — written best-effort under action `modal_s2_clone`, never able to refuse or block — so cost stays observable. Real provider auth/quota/billing errors still surface as themselves. **(2) The cache key had no recipe in it.** `takehomeCacheVariant` returned the literal `s2-pro-modal-v1`, so #244's 300-char, #245's 400-char and #246's 560-char recipes all hashed identically; the five "ready" sections were byte-identical to S2C7/S2C8 takes, so the new runtime's narration never played. It is now `s2-pro-modal-${cloneNarrationRecipeId()}` — `u560-m260-p220-400-960-a1` — containing only inputs that change audio (unit ceiling, merge width, pause ladder, history anchor), never a deploy id or SHA. A test parses `modal/s2_contract.py` and fails on drift. **(3) "Ready" did not mean complete.** Assembly accepted `mostIndexesReady` (over half) or `doneCount > 0`, so that book was published as finished. Assembly now requires every index; a book with holes is published `failed` with `"N of M sections could not be narrated… not a complete audiobook"`, `progress < 100`, and the section files left in place. Auto-advance does not jump a hole on that `failed` row (`skipUnavailable` is only for `status === "ready"`). `job 75944dc9` itself was not regenerated. The harness disables the section cache unless `TTS_SECTION_CACHE=1`, which is why the clone **lane staging** path had no test; the completeness and acceptance suites set it to `1`. |
| Missing section in the player | `nextPlayableIndex(segments, from, { skipUnavailable })`. Advancing used to require every earlier index ready, so on a finished book with a hole the rest of the book was unreachable behind a section that would never render. The flag is true only when `job.status === "ready"`; while generating, order is preserved and nothing is skipped. |
| `modal/s2_endpoints.py` | One absolute URL per Modal endpoint. Rejects a URL that carries a path, and a ready or control URL that points at the batch host, because each `@modal.fastapi_endpoint` is its own hostname. `MODAL_S2_CONTROL_URL` is the CPU submit/poll/cancel host. |
| `modal/test_s2_contract.py` | Offline proof of those rules (`python3 -m pytest modal -q`). |
| `scripts/s2/staging-smoke.mjs` | HTTP acceptance against a deployed endpoint: ready, per-lane batch rows, distinct containers, one build, scale-to-zero. Synthetic text and a generated clip only. |
| `docs/s2-gpu-staging-runbook.md` | The GPU steps this repo cannot run: staging deploy, direct snapshot build, restore coverage, four-lane fanout, synthetic end-to-end, promotion and rollback. Production stays `min_containers` 0 and `max_containers` 1. Step 8c keeps that cap at 1 after a deploy. Raising it needs explicit owner approval. `MODAL_S2_MAX_GPUS` (default 20) is the worker lease count. `min_containers` stays 0. The code is `@modal.concurrent(max_inputs=2)` so one render and one light input share the GPU. The live image stays at `max_inputs=1` until an owner deploy. The worker does not POST the GPU web endpoints while `MODAL_S2_CONTROL_URL` is set, so that deploy is not required to stop a second H100. A redeploy would wipe GPU snapshots. |

Fish also has a WebSocket `/v1/tts/live` for LLM token streaming; Echomancer does
**not** proxy it — previews and listen already have full text, so HTTP chunked
streaming is enough and fits serverless.

### `GET /api/tts/voices`

Returns `{ voices, listenVoices, source, openRouterConfigured, researchPreview, slimCatalog, … }`
with optional price/ETA when `charCount` is passed. App ships a slim catalog
(Drew, Heart, George, plus Walter when configured, plus session clones).
Echomancer Andrew, Andrew (`standard`), Ryan, Clara, Randolph, and Michelle
are not listed. A stored Echomancer Andrew book still resolves. A new request
that names that id uses Drew.

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

**Stored Andrew / Ava / Libby / Michelle** path. Once Esther is configured, new requests that name Ava or Libby use Esther and do not reach this adapter. Until then they stay on Edge. Talks to Microsoft Edge’s undocumented Read Aloud
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

The picker plays a committed recording of `PREVIEW_TEXT` for the listed stock
voices (`public/voice-previews/<id>.mp3`: `ava`, `libby`, `george`, `sowell`,
and Drew's sample when it is committed). The page preloads the slim ids plus
Walter. `POST /api/tts/preview` returns those bytes. A request that names
Andrew (`standard`) or Echomancer Andrew (`echomancer-andrew`) is served
Drew's sample and does not call Paradee or Edge. `standard.mp3`,
`ryan.mp3`, and `echomancer-andrew.mp3` stay on disk and are not listed.
A missing file falls through to browser speech, then live synthesis.
While Ava and Libby are listed, their cards play `ava.mp3` and `libby.mp3`. Once Esther is configured, a preview request that names either plays `heart.mp3`. Randolph's old id plays Drew's. Fish clones
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

### The clone GPU engine (`modal/`), and the `S2C_ENGINE` switch

`S2C_ENGINE` selects which decode path a container runs, and it defaults to
**`v9`** — the behaviour the deployed app has today. A plain `modal deploy`
therefore changes nothing about how a book sounds; `v10` is opt-in and is what
`scripts/s2/staging-env.sh` sets on the staging app.

It is read **at import**, pinned into the container env (`_BUILD_ENV`, hence
`S2C_BUILD`), and never re-read per request: a snapshot has to be built for the
exact kernels it will run, so a runtime override that disagreed with the
snapshot would hand a restored container a path it never compiled.

| v10 change | v9 behaviour (`S2C_ENGINE` unset) | Switch to isolate |
|---|---|---|
| Active batch width bucketed to `(1,4,8,16,24,32)` from the parallel unit count | steps `S2B_BATCH` rows, dummies included | `S2B_BUCKET=0` |
| An idle lane steals a later unit of a section whose unit 0 is done | one unit at a time per section | `S2B_WORK_STEAL=0` |
| Four coarse, pre-warmed CUDA-graph KV buckets | 128-token rounding (32 shapes, a few warmed) | `S2B_KV_BUCKET` |
| `_fast_step`: no mask, no `repeat_interleave`, no CPU scalar | upstream `forward_generate_fast` | `S2B_FAST_DECODE=0` |
| `masked_fill` instead of `torch.where(…, float("-inf"), …)` | upstream `logits_to_probs` | `S2B_FAST_DECODE=0` |
| Codec decoded per finished section during AR, then encoded and uploaded | all AR, then all codec, then all encode, then all upload | `S2B_PIPELINE_CODEC=0` |
| `weight_norm` frozen, codec mask cached, micro-batch 16, length-sorted | parametrized convs, mask rebuilt per call, micro-batch 8 | `S2B_CODEC_TUNING=0` |
| The opening wave's prompts prefilled in one right-padded causal pass | one serial prefill per lane | `S2B_BATCHED_PREFILL=0` |

**v9 is a separate loop, not a set of flags.** `_render_legacy` is PR 283's
decode loop transcribed: lane `r` owns `slots[r]` for the whole call, units run in
index order, nothing is work-stolen. That pinning decides the audio — the sampler
draws from one batched RNG stream, so a lane assignment that differs (say
"longest remaining section first") consumes different random numbers and renders
different tokens for any book whose sections differ in length. `_embed` and
`_fast_step` likewise keep their deployed bodies (a scalar `torch.where`, a CUDA
`fast_pos` slice) under `LEGACY_RENDER`, because the v10 rewrite is equal in exact
arithmetic and not bitwise in bfloat16.
`modal/test_s2_legacy_identity.py` imports the base branch's module out of git and
compares embeddings, sampling and the loop's statements directly.

| `EOS_CHECK_EVERY=16` | 8 | `S2B_EOS_CHECK_EVERY` |
| Folded-GQA SDPA decode attention | handwritten compiled path | `S2B_SDPA_DECODE=1` (off by default) |
| Top-k-block sampling | full-vocabulary sort | `S2B_TOPK_FAST_SAMPLE=1` (off by default) |

**A bare `modal deploy` targets staging, and the production name is not enough.**
A deploy invalidates every GPU snapshot for its app, so a branch under review
must not be able to evict production's. One resolver decides the target for the
service, `modal/s2_clone_warm.py` and `scripts/s2/check-input-queue.py`
(`s2_contract.resolve_app_name`), with `s2_contract.heartbeat_dict_name` following
the same name:

| `S2C_APP_NAME` (or legacy `MODAL_S2_APP_NAME`) | `S2C_ALLOW_PRODUCTION` | target |
|---|---|---|
| `echomancer-s2-clone` | `1` | production |
| `echomancer-s2-clone` | unset | **staging** |
| any other name | either | that app |
| unset | `1` | production |
| unset | unset | staging |

Spelling the production name out is **not** an opt-in: typing a name is not a
decision about snapshots, and deploy commands get copy-pasted from docs. The
worker's prewarm (`src/lib/tts/providers/modal-clone-warm.ts`) therefore exports
`S2C_ALLOW_PRODUCTION=1` for its own `modal run …::cover` child, because that
cover is the production path. `scripts/s2/cancel-unstarted-pending.py` keeps a
production default on purpose — it cancels a pending input, and an unnamed
invocation there means the live app.

`deploy_identity` is that resolution plus the heartbeat Dict and the control
Dict. Every function in the S2 app (the GPU class, `s2_control`, and `ready`)
bakes those four strings into its env. A function env replaces the process
environment, so a container that re-imports the module without them resolves
as staging and opens `echomancer-s2-clone-staging-s2-control`. The baked names
are what a re-import sees. Production and staging do not share those stores.

Why `v9` is the default: the worker and the Modal app ship separately, and the
app is a ~15-minute snapshot rebuild, so there is always a window where one has
changed and the other has not. A `modal deploy` with no new env vars must
reproduce today's audio, and `modal/test_s2_engine_switch.py` asserts it does —
down to the 128-token KV rounding and the upstream fast-transformer call.

**What is bit-identical and what is not.** Freezing `weight_norm`, caching the
codec mask, length-sorting the codec micro-batch, `EOS_CHECK_EVERY`, the coarse
KV buckets and the streaming order change no sample, and each has a test that
says so (`modal/test_s2_codec_tuning.py`, `modal/test_s2_numerics.py`). The
fast-transformer rewrite and the batched prefill are numerically equal to
upstream's step and to the single-row prefill in fp32 —
asserted against the pinned upstream source, which is how two real bugs were
found: the fast loop must write fast-KV position 0 from the **slow** hidden
state (its logits are discarded, but every later codebook step attends it), and
each fast layer's attention reads its *normalised* input.

**The step must *compile*, and that is tested.** Every earlier numeric test
bypassed `torch.compile` (the CPU harness set `engine.step = engine._decode_step`),
so two production boot bugs lived in that gap:

- the v9 path called `globals().get("logits_to_probs")`, and
  `torch.compile(fullgraph=True)` refuses to trace the `globals` builtin — the
  **default** engine failed to compile before a single section could render;
- a `float` attribute read inside the step (`self.codebook_inv_scale`, every
  `RMSNorm.eps`) was wrapped by Dynamo as a 0-D CPU `float64` placeholder, which
  Inductor reports as `skipping cudagraphs due to cpu device (arg10_1)`.

`modal/test_s2_compile.py` now traces the **real** `_decode_step` through
`torch.compile(fullgraph=True, dynamic=True)` for both engines (at two widths,
against eager) **and** through `aot_autograd` + Inductor decompositions on a
`meta` model to assert zero surviving CPU tensor placeholders (`arg10_1`). Both
sampler names are bound inside `gpu_image.imports()` and called directly;
`torch._dynamo.config.specialize_float` is set before compiling so every float
attribute becomes a constant; `selftest()` reads
`torch._dynamo.utils.counters["inductor"]["cudagraph_skips"]` and **raises** on a
non-zero count under `v10` (`FAST_DECODE=1`), so a skip fails the boot instead of
quietly halving throughput on every call while keeping the `v9` rollback bootable.

**A CUDA graph needs three calls, not one — and consistent `inference_mode` across all 24 shapes.** Inductor's `CUDAGraphTreeManager`
warms up on call 1 for a new `(width, kv_len)` key, records on call 2 and replays
on call 3. `_warm_kv_buckets()` runs `WARM_STEPS_PER_SHAPE` (3) steps per shape,
feeding the output back into the next step as `render` does, so all 24 shapes are
recorded inside the snapshot. Every caller of `self.step` on v10
(`_render_pipelined`, `_warm_kv_buckets`, `_replay_decode_shapes`, `selftest`)
allocates its step tensors (`x, pos, prev, temp, topp`) inside
`torch.inference_mode()` so `ADInplaceOrView` never toggles between step 0 and
step 1; `setup_caches` pads `KVCache` by 8 columns (`4104` vs `MAX_SEQ_LEN=4096`)
so `kv_len=4096` stays strided like `512/1024/2048` instead of triggering a
`524288 != 128*kv_len` recompile; `_configure_dynamo_for_step()` raises
`recompile_limit` / `cache_size_limit` (`>= shapes*2 + 16`, min 64) and
`accumulated_recompile_limit` (min 512); and `selftest()` asserts
`compiled_graphs <= len(decode_shapes())`. Bucketing is forced off when
`S2B_FAST_DECODE=0`, because upstream's `forward_generate_fast` writes a
`BATCH`-row KVCache that a narrower active batch cannot broadcast into.

**A restore that invalidates the graphs recaptures once.** `cudaGraphExec_t`
handles are captured before the snapshot, and `cuda-checkpoint` restoring onto a
different Modal worker variant may invalidate them. `_verify_graphs()` therefore
calls `engine.recompile_step()` (resetting `cudagraph_trees` and Dynamo and
re-wrapping `_decode_step` onto a fresh `CUDAGraphTreeManager` backed by
Inductor's warm disk cache on the `echomancer-compile-cache` volume, or
`/opt/torchinductor` when `S2C_COMPILE_CACHE=0`) and re-runs `_warm_kv_buckets()`,
logs `graphs=recaptured(24)` and only fails on a second failure.
The mega-cache file is read as bytes and passed to `load_cache_artifacts`; a
path string is not a cache. torch 2.15's loader returns None when the bytes
do not install, and that None is a failed load. The process environment is
pointed at the published run before that load: `cache_dir()` reads
`TORCHINDUCTOR_CACHE_DIR` on every call, and `populate_cache` writes the
graphs there. A corrupt mega-cache stays on the volume. Inductor and Triton
files already in that same published run are still the cache a later worker
uses when the torch version, GPU name, and compute capability match. A lock
or a temp file does not count. `torch._inductor.config` and Triton's knobs
are pointed at the same directory after import. A new run directory is
created only when the published tree has neither a loadable mega-cache nor
those artifact files.
`check-cudagraphs.py` accepts zero `cudagraph_skips` plus both `ok(N)` and
`recaptured(N)`, with `N` equal to `--expect-shapes`.

**The codec's host copy is pinned, and its event is recorded after it.** A D2H
copy into pageable memory is synchronous on the calling thread — it would stall
the AR loop inside `submit_decode` and inflate `generate_s`. The copy therefore
goes into `pin_memory=True` buffers with `non_blocking=True`, the event is
recorded **after** every copy is enqueued (recording first let `query()` report
done while the DMA was still writing, which is corrupted section audio), and
`collect_decode` drops both the device and pinned buffers once the caller has its
arrays.

**Every decode switch is forwarded into the container.** `@app.cls(env={...})`
replaces the container's environment rather than extending it, so a switch
`_BUILD_ENV` omits does not reach the container - and since each is also in
`snapshot_fingerprint`, the deploy hashed one value locally while the container
re-hashed another. Every isolation toggle in `staging-env.sh` was a no-op on
Modal until all of `S2B_*`, `S2C_MAX_BATCH_ITEMS` and `S2C_ENCODE_WORKERS` were
listed, and `batched_prefill` / `cpu` / `warm_steps` were added to the
fingerprint.

**One R2 pool for the container's life.** `S2CloneWorker` builds a
`KeepAlivePool` in `publish()` and closes it in `exit()`; `UploadPool.close()`
closes a pool it owns. A pool per request paid a handshake per object and left
its idle sockets to GC.

**Nothing in the worker's planner changed to assume a speedup.**
`MODAL_CLONE_FULL_BATCH_CHARS_PER_SECOND` stays at the measured 528, so a v10
page is *over*-estimated in wall time until staging measures a real rate. The
24-row baseline is still what a 32-row page is interpolated toward.

**Rollout order for the worker.** A 32-row page needs `/ready` to report both
`audio_transport: "r2"` and `max_batch_items >= 32`
(`modalCloneBatchRowsForTransport`). Against the live v9 container the worker
plans ≤ 24 inline rows, so a worker deployed first cannot collect
`422 batch_too_large`. Its R2 reads are bounded-concurrent (`mapPool`, 8) and the
per-object delete is not awaited, so a page does not spend the warm-hold budget
on round trips.

Staged A/B procedure, gates and cost: `docs/s2-gpu-staging-runbook.md` §9a. The
tools are `scripts/s2/bench-ab.mjs` (record) and `scripts/s2/qa-compare.ts`
(gate).

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
| `prepareCloneSampleFile` | `clone-sample-quality-browser.ts` — client `AudioContext.decodeAudioData` → same decision module |

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

### Book titles — `src/lib/book-title.ts`

A title the person did not type comes from the uploaded file's name, so it
arrives as a file name (`the_hobbit_-_tolkien.pdf`). One helper cleans it:

- `bookTitleFromFileName(name)` — drops the document extension and any path,
  turns `_` runs into spaces and repeated dashes into ` - `, splits a slug's
  glued hyphens when it has no capitals (`the-hobbit` → `The Hobbit`) while
  keeping a real one (`Spider-Man`, `Catch-22`), and title-cases a name with
  no capitals at all (`PRIDE_AND_PREJUDICE` → `Pride and Prejudice`, Roman
  numerals and initialisms kept). Text with no readable words becomes
  `Untitled`. A typed title only gets trimmed.
- `normalizeStoredBookTitle` is the read-time rule. A title with no
  underscore and no extension is a title a person typed and is returned
  verbatim; anything else is repaired. `serializeJob` applies it, so an older
  row heals in the library, player, download, and Media Session without a
  write.
- `bookTitleHeadingClass(title)` is the player heading's size step: display
  size for a short title, down to `text-xl` for a 120-character one, so a long
  title wraps inside a phone screen instead of running off it.

`POST /api/jobs`, the rename `PATCH`, the upload view, and the voice step all
use the same helper, so the stored `jobs.book_title` and every surface agree.

### Validation — `src/lib/validation.ts`

- `uploadStoragePathSchema`: exact `pdfs/<uuid>/content.txt`
- `createJobSchema`: `mode: stock`, `jobKind`, path, optional voice fields,
  `charCount`, `parentJobId`; `bookTitle` runs through
  `bookTitleFromFileName` before the 1–200 character check

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

The Stop button. Owned; 400 if already `ready`/`failed`; calls
`stopBookRemotely(id, "cancelled")` first (refuse new remote calls, ask the
worker to drain held ones, §28), then sets `cancelled` and clears lease
fields so a mid-wave worker cannot keep writing.

### `PATCH /api/jobs/[id]` `{ action: "retry" }`

Only `failed` → keep ready segments, set `next_section_index` to the lowest
unready index, clear error/lease → `queued` → `enqueueTakehomeAdvance`.

### `PATCH /api/jobs/[id]` `{ action: "rename", bookTitle }`

Owned (404 otherwise). Collapses whitespace, trims, runs
`normalizeStoredBookTitle` (a rename that arrives as a raw file name is
cleaned; a typed title keeps its own casing), requires 1–200 chars, and writes
`jobs.book_title`. The library lists each book as a row, without
a card. The library and the player keep the pencil hidden until a right-click
on the title. A cloned voice name selects that voice; a right-click on the
name shows the same pencil. The download filename follows the new title.

### `DELETE /api/jobs/[id]`

Owned, including a row this user already soft-deleted (a retry returns 200 and
purges again; another session is 404). `GET` / `PATCH` still use the
non-deleted lookup. `softDeleteJob` sets `deleted_at`, clears the lease,
cancels a still-running book, cancels that job's queued CPU tasks, and
releases the take-home create key. `stopBookRemotely(id, "deleted")` runs
before any object is removed. `scheduleDeletedJobPurge`
(`src/lib/jobs/delete-owned-job.ts`) re-reads the row and, only when that
`user_id` still has `deleted_at` set, lists `audiobooks/<jobId>/` (token id,
trailing slash) and deletes those keys with R2 `DeleteObjects` in batches of
1,000. Every batch is sent; a partial error throws once without the key, and
the same `after()` pass lists again (up to four passes). `after()` keeps the
JSON inside the route's 60s `maxDuration`. A list is paginated; a repeated
continuation token stops it. Keys outside the prefix are dropped.
`pdfs/<uploadId>/` (trailing slash) and the uploads row go only when no
live job uses that folder and the uploads row is this user's or has no
owner. Paths remembered in `segments_json` are not deleted on their own.
`ownsStoragePath` treats a soft-deleted book as not owned, so playback is
404 while the objects still exist. Lease writes, heartbeats, and
`releaseLease` require `deleted_at IS NULL`, so a tick cannot put the row
back in the queue. `commitSectionAudio` and concat skip the upload when the
book is already closed, and delete an object that landed after the close.
The worker tick purges `audiobooks/<jobId>/` again when it sees `deleted_at`.
That last part runs on the VM worker, which has to be restarted; the Modal
CPU image is a separate deploy and is not the default.

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

**Production Whole-book host:** an always-on Ubuntu VPS running pm2.

| | |
|--|--|
| Process | Node + pm2 `echomancer-takehome` (`src/worker/takehome-server.ts`) |
| Bind | **`127.0.0.1:8788` only** (pm2 sets `WORKER_HOST`). Never publish 8788. |
| TLS | **Caddy on the VM** terminates HTTPS for `worker.echomancer.xyz` → loopback 8788 (hostname and DNS rows as documented in `WORKER.md`; operator-reported) |
| DNS | A record on **Vercel** (apex `echomancer.xyz` uses Vercel nameservers). Not a Cloudflare zone. |
| Vercel | `WORKER_URL=https://worker.echomancer.xyz` + `WORKER_SECRET` (HTTPS only) |
| Concurrency | `effectiveOrchestratorConcurrency` (`src/worker/concurrency.ts`): local CPU (default) runs one book unless `WORKER_LOCAL_MULTIBOOK=1`; with `CPU_RUNNER=modal` it is `ORCH_CONCURRENCY` (default 8, max 64) unless `WORKER_CONCURRENCY` is set |
| TTS | Orchestrates Kokoro (`echomancer-sowell`), the S2 clone pool, Fish, and legacy Edge/Paradee rows; CPU tasks run locally or on `echomancer-cpu` (`CPU_RUNNER`). Does **not** run a GPU and does **not** call Google Cloud TTS. |
| Routes | `src/worker/takehome-http.ts`: open `GET /health` (and `/`), `GET /ready`; secret-gated (`authorizeWorkerRequest`: `WORKER_SECRET`, Bearer or `x-worker-secret`) `POST /jobs`, `/extract`, `/listen-prep`, `/clone-prewarm`, `/drain`, `/clone-preview`, `/capacity-warm`, `/reference-quality`. `src/worker/takehome-server.ts` also proxies `POST /paradee/synthesize` for stored Echomancer Andrew books. |

The Next.js app on Vercel only enqueues. Live Listen / Live Stream stay on
Vercel. Document extract runs here in a child process (`POST /extract`);
Cloudflare is the fallback when this process is unreachable or unhealthy.
Runbook: `WORKER.md`. Docker Compose is an optional appendix.

`trycloudflare.com` quick tunnels are **not** production `WORKER_URL`.

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
| Worker POST fails | Logged. The job stays `queued` for the VM drain loop |

Dispatch from Vercel (then 200 immediately): `POST /api/jobs` (takehome),
`POST /api/jobs/[id]/takehome`, `PATCH` retry.

Missing `WORKER_URL` in production:
`POST /api/jobs` takehome returns **503** `TAKEHOME_NOT_CONFIGURED`
**before insert**. After a job row exists, dispatch failures are logged and
the job stays `queued` for the VM drain loop (still HTTP 200). The VM
runtime must have Turso, R2, `INTERNAL_JOB_SECRET` / `WORKER_SECRET`
(`src/lib/jobs/worker-secrets.ts`). Fish / Google keys only when that
voice is used.

`TTS_POLL_NUDGE_BUDGET_MS` code default is **0**, and production is reported
at 0. At 0, neither poll synthesizes. They are not the same write:

- `GET /api/jobs` (library) calls `nudgeStaleTakehomeJobs`, which always runs
  `releaseExpiredTakehomeLeases` when the page contains a take-home that is
  not `ready`, then returns without a wave.
- `GET /api/jobs/[id]` (player) calls `nudgeStaleTakehomeJobIfNeeded`, which
  returns immediately at budget 0 and does not sweep.

Lease reclaim for a live book belongs to the VM drain. A non-zero budget is
the old Hobby path that also synthesizes; do not turn it on in production.

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
once (`cloneOutlineRepackKind` in `process-job.ts`). A stored Google / Randolph job
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
`planCloneSectionChars(rawText.length)`: section 0 stays 1,000, a short
book puts the rest in one call, and a long book uses 2,500–6,000
characters so the steady pages approach 24 rows and about 3.5 minutes.
The pack ceiling is the cold-safe row (6,000). `modalCloneSectionChars`
remains the 4,000 default when a caller has no total
(`MODAL_S2_SECTION_CHARS`).
A row renders its units in sequence, so a ~7,700
character section does not fit the placement budget. That is what froze
`job 7e4a8b48`. Edge stays on catalog character limits and
`edgeGoogleTakehomeTargetChars` (`ceil(chars / 8)`, floor 1,500, cap the
catalog max). Section 0 is capped near 800 characters for every provider,
including even packing, so the first audio is about a minute (Live Listen
still uses ~480-character windows). Later sections stay near the even target
on the Fish path, and on the clone schedule (1,000, then the length plan) on the clone path.
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
the rest of the wave continues. Kokoro CPU books and S2 clone books do not
transcribe: no Whisper process, no whisper CPU task, and no transcript retry.
They retry one take on silence, on a duration more than 25% off the calibrated
rate, and (S2) on a truncated take. Edge and a Fish-pinned clone still
transcribe. Transcription for those engines defaults to self-hosted Whisper
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
An S2 book never reaches this check. An earlier (now removed)
`prioritizeZero` path claimed only `[0,1]` so the player could start after
one Fish round-trip; that starved parallel workers and is no longer the
default. `/health` `concurrency` is the orchestrator slot count (books in flight, `effectiveOrchestratorConcurrency`),
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
| `TTS_VM_WAVE_BUDGET_MS` | 900000 | Always-on VM wave clock |
| `TTS_TAKEHOME_FANOUT` | 4 or 5 | Fish/clone pin; else 4 if live in flight. Does not raise Edge/Google. |
| `TTS_MAX_TICKS_PER_WAVE` | 40 | Safety cap |
| `TTS_CRON_JOBS_PER_RUN` | 3 | Fallback cron batch |
| `TTS_POLL_NUDGE_BUDGET_MS` | 0 | UI poll synth budget; `0` = read-only |
| `TTS_RETRY_BACKOFF_MS` | 1000 | Between section attempts |
| `TAKEHOME_MAX_INFLIGHT_PER_USER` | 1 | Live leases one user may hold. `0` turns the cap off. Enforced on claim, not only on the list |
| `TAKEHOME_GLOBAL_ACTIVE` | 16 | Cluster-wide live take-home leases. `0` turns it off. Not a CPU or provider cap |
| `ORCH_CONCURRENCY` | 8 | Orchestrator slots when `CPU_RUNNER=modal` and `WORKER_CONCURRENCY` is unset |
| `CPU_DISPATCH_ACCEPT_MS` | 20000 | How long the orchestrator waits for the CPU HTTP accept. Not the task budget |
| `CPU_PLACEMENT_LEASE_S` | 180 | Lease written before the POST. A timeout keeps it. No second container until it expires without a heartbeat |
| `CPU_FUNCTION_TIMEOUT_S` | 900 | Master, whisper, extract child deadline |
| `CPU_CONCAT_TIMEOUT_S` | 3600 | Concat child deadline. The Modal function timeout is the max of this and the section budget |
| `CPU_YIELD_SEC` | 3 | How long a book waiting only on CPU stays off the drain |

| Function | Role |
|----------|------|
| `claimTakehomeLease(jobId)` | Atomic UPDATE to `processing` + new token **only if** no active lease. A successful claim also stamps `takehome_fairness.last_served_at` for that user |
| `heartbeatLease` | Extend expiry while holding token. After the wave deadline, renews while a section is inside its lifecycle cap (`shouldRenewTakehomeLease`): synth, retries, master, upload, segments write. Cap is every attempt budget plus `SECTION_MASTER_LEASE_MS` (3 min). Mastering narrows the window to that 3 min |
| `writeWithLease` | Progress UPDATE … AND token = ?; 0 rows → `LeaseLostError` |
| `releaseLease` | Clear token; set queued/failed |
| `releaseInFlightTakehomeLeases` | Shutdown: same UPDATE as `releaseLease` for tokens this process still holds, status `queued` |
| `processTakehomeTick` | Claim → heartbeat → `runClaimedTick` → cleanup |
| `runClaimedTick` | Load frozen `sections.json` (rebuild once if missing, or once when a clone outline is wider than a call and nothing is published) → claim index set → synth bound per index → one bad section is `retry`/`failed`, not an immediate `failJob` → hole-retry → assemble only when nothing is still claimable. Every index ready → `ready` at progress 100. Any hole → `failed`, progress under 100, audio kept |
| `synthesizeSection` | Fish script tags; cache lookup; section 0 `balanced`, later `normal` + `chunk_length` 300; 429 waits; reject silence. Each attempt passes `AbortSignal.timeout(sectionAttemptBudgetMs)`. Fish is ~10 chars/s plus 60s, and the signal is created after `withFishSlot` acquires the slot. Edge is `edgeSectionBudgetMs` (chunk waves plus `EDGE_SECTION_SLACK_MS`, no extra multiplier; inactivity 22s, per-chunk cap 45s–240s). Google Cloud TTS is not synthesized |
| `runTakehomeWave` | Loop ticks until done/busy/error/budget/max ticks |
| `runTakehomeUntilSettled` | VM host: waves until terminal. After a wave, if another take-home is runnable, returns `yielded`. A book that is only waiting on CPU also returns `yielded` and sets `sched_not_before`, so the slot can run someone else. Local ffmpeg stays one slot. `CPU_RUNNER=modal` uses `ORCH_CONCURRENCY` (default 8) when `WORKER_CONCURRENCY` is unset |
| `drainTakehomeQueue` | Fallback: release expired → list queued → waves |
| `listDrainableTakehomeJobs` | Queued + lease-expired processing, deduped. Users who have waited longer since their last claim come first; same-user ties stay `updated_at`. A user already at `TAKEHOME_MAX_INFLIGHT_PER_USER` (default 1) is skipped |
| `releaseExpiredTakehomeLeases` | Abandoned `processing` → `queued` |
| `nudgeStaleTakehomeJobs` / `nudgeStaleTakehomeJobIfNeeded` | Poll paths (lease sweep only when nudge=0) |

**Lease invariant:** two workers must never bill Fish for the same section.
Losing a lease mid-write abandons safely; successor resumes from the lowest
unready index (holes first). Ready files are not shifted.

### Queue hardening and CPU tasks

Local CPU still orchestrates one book. `WORKER_CONCURRENCY` above 1 is
clamped unless `WORKER_LOCAL_MULTIBOOK=1`. `CPU_RUNNER=modal` is the
horizontal path: several orchestrator slots, a cluster lease cap, and
CPU containers that scale to zero. An offline burst of 200 fake-provider
books finishes under a cap of two ticks at a time. A second test runs two
worker loops against one database with `TAKEHOME_GLOBAL_ACTIVE=2` and
finishes 8 books with overlapping synthesis at or under that cap. Neither
test is 200 simultaneous provider calls, and neither calls Modal. The
deploy in `docs/cpu-modal-runbook.md` was not run here.

What did land, so a second worker can be added later without double-creating
books or doubling provider calls:

- **Create identity.** `takehome_create_keys` (`src/lib/jobs/takehome-identity.ts`)
  reserves one live take-home per user, upload, provider, catalog voice, and
  provider voice. The insert is a single statement. Startup backfill points
  the key at the oldest live row and does not delete historical duplicates.
  A failed, cancelled, or deleted book does not hold the key. Deleting
  releases it. Retrying the same row, which queues it again, returns that
  row. A new create after a book that was left failed may insert.
  Overlapping creates that lose the race get `409` if the winner has
  not committed yet, otherwise the existing job id.
- **Shared permits.** `provider_slots` (`src/lib/tts/provider-slots.ts`) caps
  Fish take-home calls at 5, Edge sections at `TTS_EDGE_GOOGLE_SECTION_CONCURRENCY`
  (default 8), and Modal clone HTTP lanes at `MODAL_S2_SECTION_CONCURRENCY`
  (default 4). A clone book wave does not take one of those lanes. Its cap is
  `modal_gpu_leases` (`src/lib/tts/providers/modal-gpu-lease.ts`): one row
  per book, `MODAL_S2_MAX_GPUS` (default 20) globally and
  `MODAL_S2_MAX_GPUS_PER_USER` (default 5) per user. Those counters do not
  raise production `echomancer-s2-clone` above `max_containers` 1; a second
  book queues on that GPU. Rows are renewed by the same
  heartbeat and deleted on tick end, shutdown, or expiry. Slot ids on
  `provider_slots` are `0 .. cap-1`. Acquire steals a row only after
  `expires_at`. Release and renew require the owner token. Renew runs inside
  the existing lease heartbeat (one extra `UPDATE` per beat, not a poller).
  A full cap is tried once. Sections that already hold a slot finish and
  write `segments_json` before the book goes back to `queued`. The drain
  interval is the retry. The section is not failed, and nothing sleeps on
  the table. Shutdown deletes slots owned by the leases this process still
  holds, so a restart does not inherit them for the rest of the TTL.
  Paradee sections share `TTS_PARADEE_FANOUT` (default 3). Any other stock
  provider (OpenRouter, Gemini, Grok) shares a cap of 5. Fish take-home
  still skips its Fish permit when the book is pinned to Modal, so a GPU
  call does not spend a Fish seat.
- **The same permits cover the calls that used to skip them.**
  `synthesizeModalClone` and a warm `synthesizeModalClonePreview` each hold
  one Modal lane for the HTTP call and release it in `finally`. A full lane
  throws `ProviderSlotBusyError` before `fetch`. A per-section fan-out still
  holds one of those lanes around `renderModalCloneBatch`. A book wave does
  not: the GPU row is the cap, and the wave is one lane. A batch does not
  take two lanes. A full lane does not fall
  through to Fish and does not substitute a voice. Live Fish
  (`beginLiveFish`) holds one of the five account permits until the body
  ends or the caller cancels, and renews both that permit and the
  `fish_inflight` row. A sixth live request throws. Saved previews stay
  storage reads. A preview or listen that has to synthesize holds the
  voice's permit for that request (`holdListenerSlot`); Edge, Paradee, and
  other stock streams hold one permit for the whole session and put the
  job back to `queued` if the cap is full, before any audio. A permit with
  no take-home lease renews itself every TTL/3 until release. Owner-mismatched
  release deletes nothing.
- **Edge 429.** This process still halves its own in-memory gate.
  `noteEdgeGoogleThrottle` also writes `provider_throttle` for 120 seconds.
  The next Edge tick sizes its wave from that row, and every Edge acquire
  uses `min(configured, shared)`. Another process does not have to see the
  429 itself. There is no poller. When the row expires, the configured cap
  returns.
- **CPU tasks.** `cpu_tasks` (`src/lib/cpu/tasks.ts`) is the queue for
  `master`, `whisper`, `concat`, and `extract`. The id is
  `kind:subject[:index]`. Claim steals only an expired lease. Complete and
  fail require the owner token. A full host does not burn an attempt.
  Three failed attempts mark the task `failed`. Input and output are
  object keys, not a shared temp path. `placed_at`, `started_at`,
  `finished_at`, and `deadline_at` are the queue-wait and active-time
  columns. One log line per dispatch and per finished task is prefixed
  `[cpu]`. `CPU_RUNNER=local` (the default, including tests) claims and
  runs on this process. `CPU_RUNNER=modal` claims first, with
  `CPU_PLACEMENT_LEASE_S` (default 180) and `deadline_at` set to the
  kind's budget, then POSTs `{ taskId, ownerToken }` to `MODAL_CPU_URL`
  (host only, no path). The client waits `CPU_DISPATCH_ACCEPT_MS`
  (default 20s), not the container budget. A timeout, a reset, or a
  response that never completed leaves the lease live and returns
  `accepted`, so a late owner can still finish and a second caller does
  not POST. `429`, `400`, and `401` release that placement. A connection
  that never opened (`ECONNREFUSED`, `ENOTFOUND`) releases it too. A
  `RemoteCallRefused` of `budget` or `cancelled` is the same release: the
  log is `result: deferred` with that code, and the row is not left
  claimed. `in_flight` keeps the lease. A
  completed HTTP error, including 404 and 500, is rejected: the attempt
  increment is undone, the row is `failed`, and it is not posted again.
  A body that says the workspace is disabled is not that rejection and
  not a cold GPU. The attempt is undone, the process stops posting for
  15 minutes, and the book is `failed` with the usage-stopped message.
  Spoken takes and `provider_pin` stay. Enqueue does not reopen a
  `failed` row or a row that already used its three attempts. A book
  with holes is not concatenated. Concat runs only when every section
  is ready. `scripts/repair-raw-masters.ts` remasters verified raw
  objects after a backup, and only with `--confirm-service-available`
  or `--approve-local`. It does not synthesize and does not call Modal.
  The container adopts `CPU_TASK_OWNER` and does not claim a second
  token. It keeps the invocation until the child exits, so a client that
  already gave up does not cancel the work. Late `completeCpuTask` from
  any other token is a no-op. Section children are killed at
  `CPU_FUNCTION_TIMEOUT_S` (900). Concat uses `CPU_CONCAT_TIMEOUT_S`
  (3600). The Modal function timeout is the greater of those. The app
  name is `echomancer-cpu` (`modal/cpu_worker.py`). It is not the S2 GPU
  app, so a CPU deploy does not reset that autoscaler. The image's
  `python` is apt Python. Later Modal layers run `python -m pip` and, on
  builder 2024.10, `uv pip install --system`, neither of which passes a
  PEP 668 flag. `workers/cpu/Dockerfile` removes Debian's
  `EXTERNALLY-MANAGED` marker and sets `PIP_BREAK_SYSTEM_PACKAGES` and
  `UV_BREAK_SYSTEM_PACKAGES` so those layers install into the same
  interpreter as faster-whisper. The image proves that with a flagless
  `python3 -m pip install --dry-run` of the installed requests pin.
  `pip config get` is not that proof: it does not read the env var. A venv would miss the `--system` layer.
  `scripts/cpu/smoke-remote.ts` is the executable check before
  `CPU_RUNNER=modal` on the VM: one synthetic `cpusmoke…` job, two short
  tones, remote master, caller disconnect, single-flight, and concat.
  It deletes only that job's rows and `audiobooks/<id>/` keys.
  `min_containers=0`. `CPU_MAX_CONTAINERS` (default 4),
  `CPU_FUNCTION_CPU` (default 2), `CPU_FUNCTION_MEMORY_MB` (default 4096),
  and `CPU_SCALEDOWN_SECONDS` (default 10) are the knobs. The container
  cap is not a dollar cap. Cold start, idle before scaledown, and a burst
  up to the cap are the spend. No dollar figure is recorded here.
- **Unmastered audio is not a ready section.** When mastering is on, the
  provider take is stored at `audiobooks/<jobId>/raw/NNNN.<ext>` and the
  section stays `mastering` until the master task writes
  `audiobooks/<jobId>/sections/NNNN.mp3`. A full host, a failed master,
  and a cancel do not copy the raw bytes onto that section key and do
  not set `status: ready`. The player only reads `ready` rows. A cancelled
  job cancels the task before publish.   Host permits are
  `cpu-host:<CPU_HOST_ID>:<kind>` (`src/lib/cpu/task-slot.ts`). Processes
  on one machine share that host's cap. Another machine has its own.
  ffmpeg and concat use the CPU count (`CPU_HOST_CONCURRENCY` overrides).
  Whisper, for engines that still transcribe, uses the Edge fan-out (default 8). Extract uses
  `EXTRACT_NODE_CONCURRENCY` (default 1, max 4). A missing permit table
  still runs the work. A full Whisper cap defers the section instead of
  skipping the check and marking it ready. A transcript error or a
  missing sidecar still keeps the take. Provider account caps stay on
  their own slot names and are not the CPU queue.
- **Claim order.** `takehome_fairness` is the user clock. One library's own
  books still yield in `updated_at` order. Across users, the user served
  less recently goes first. The per-user processing cap is 1 until
  `TAKEHOME_MAX_INFLIGHT_PER_USER` is set. `0` disables it.
- **Cancel.** The route still clears the lease. The tick checks status and
  token before each new section. The provider call already in flight is not
  aborted. A lease-conditioned write cannot set that row back to `processing`
  or `ready`.

Cache keys, `provider_pin`, object paths, narration recipe, allowances, and
`min_containers=0` are unchanged. There is still no app character cap.
Drama 3 is still not called. Snapshot compile stays off the book path.

Deleting a take-home calls `releaseTakehomeCreateForJob` after
`deleted_at` is set, so the next create can insert. A retry that queues the
same failed row is what the next create returns; it does not insert a second
book. A crash between insert and commit still commits the existing live row
instead of opening another.

Cost of the queue writes, on one worker: one key write per take-home create,
one fairness write per successful claim, one slot insert and delete per Fish
section, Edge section, Paradee section, other stock section, clone lane,
per-section Modal call, and warm clone preview. A live Fish request, a stock
preview, and a live stream add one slot plus a renew `UPDATE` about every
30 seconds until release. An Edge 429 adds one throttle upsert, and each
Edge tick reads that row once. Each local CPU task adds a claim, a
heartbeat about every 15 seconds, and a complete. A master also writes the
raw object and the section object. The drain's user-cap subquery is
bounded by its existing `LIMIT` (50 on the VM, 3 on the cron fallback).
Modal CPU spend starts only after the app is deployed and `CPU_RUNNER=modal`.
The knobs are in `docs/cpu-modal-runbook.md`. This change did not call Modal
or a paid speech API, and it does not state a measured dollar cost.

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
| Recipe | Two chains, chosen in `prepareSectionForStorage` (`src/lib/tts/section-master.ts`). **Stock, Kokoro (Drew, Walter, George), Fish, and Paradee**: `masterPodcastFiltersAf` — highpass 80 Hz (2 poles), wide −1.8 dB at 280 Hz, +1.6 dB at 3.4 kHz, light `deesser` (i=0.4), then `loudnorm` `I=-16` `TP=-1.5` `LRA=11` (`MASTER_LOUDNORM_*`). **Modal clone** passes `"s2"`: the container already applied `S2_SPECTRAL_CHAIN` (highpass 70 Hz, cuts at 190/430/3400/6800 Hz, +5 dB at 8 kHz, lowpass 15.5 kHz). The app then loudnorms to `I=-19` `TP=-3` `LRA=11` (`MODAL_S2_MASTERING`). Both graphs insert `voiceEqStageAf()` (`src/lib/tts/voice-eq.ts`) immediately before that loudnorm: resample to 44.1 kHz in the same graph, then lowshelf/equalizer/highshelf (63 Hz −4, 125 −2, 250 omitted, 500 +1, 1 kHz +2, 2 kHz +3, 4 kHz +1, 8 kHz −3, 16 kHz −4). `TTS_VOICE_EQ=0` omits the stage and leaves the previous chain. The join does not run it again. That is not the −16 podcast pass. The loudnorm pass is measured and applied linearly when the section is at least 3 seconds (`SHORT_SECTION_MASTER_SECONDS`). Under that, ffmpeg 5.1's linear loudnorm lands near −32 LUFS and 6.1/7.1 still sit about 2–3 LU quiet of the target, so the section runs the spectral chain and voice curve, measures `integratedLufs`, and applies one `volume` gain clamped to ±24 dB plus `alimiter=level=false` at the true-peak ceiling. A clip too short to measure, or one whose duration cannot be read, keeps one-pass loudnorm with `linear` unset. ffmpeg and ffprobe are asynchronous, and ffmpeg in flight is capped at the CPU count, so one section does not freeze the other sections' QA. Encode **44.1 kHz mono 128 kbps** MP3 (`-reservoir 0` so a later cut can land on a frame). Finish downloads the mastered sections together and packet-copies those files. The splice search stops once a frame is comfortably quiet, and those short ffmpeg calls are not held behind the section-master CPU cap. Each join re-encodes only the crossfade window (the fade plus a short lead-in, under about two seconds) and byte-appends it; the section bodies are `-c copy`. A splice is kept when its sample step stays under seven times the p99 beside it. 128 kbps mono is the clean spoken-word rate; 64 kbps smears the presence lift. A section without `mastered`, or any mix with an older section, still takes the full-book encode. If the sections were already mastered and the join fails, finish encodes the crossfade with no second loudnorm. Frame positions are read from the MP3 headers (a per-section ffprobe crowd timed out a 1,297-section book at 60s). A section under four seconds is re-encoded with the same crossfade into the next section, or into the previous section at the end of the book, and the rest of that neighbor is still packet-copied, so one heading does not send the book through the full encode. The fallback encode is capped to the decoded sample count, and a full file that already uploaded is not marked failed when the lease is gone. `TTS_SECTION_MASTER=0` forces the full encode. DeepFilter opt-in does too. |
| DeepFilter | **Off by default.** Opt in with `TTS_MASTER_DFN=1` (wet `MASTER_BLEND_ENHANCED` 0.4) and/or `TTS_MASTER_DFN_WET>0`. Explicit `TTS_MASTER_DFN_WET=0` skips DFN even if `TTS_MASTER_DFN=1`. Missing `deep-filter` still runs the ffmpeg chain. Long books are DFN-chunked (`MASTER_DFN_CHUNK_SECONDS`) only when DFN runs. |
| Host | Always-on VM (`WORKER=1`). `VERCEL=1` always skips. Enabled when `WORKER=1`, `TTS_MASTER_FULL_BOOK=1`, or `DEEP_FILTER_BIN` is set. |
| Binaries | Ubuntu `ffmpeg` (required) on the take-home VM. The Modal CPU image (`workers/cpu/Dockerfile`) replaces the bookworm 5.1 `ffmpeg` and `ffprobe` binaries with a pinned static GPL build, n8.1.3, sha256 `fce424851b0a982bdd4ac4e96f0e7b32cf29de999e54500676d41ad175ed0c79`, and refuses a version below 6.1. Apt ffmpeg stays installed so PyAV keeps its libraries. Rust `deep-filter` 0.5.6 stays installed on Ampere (`aarch64-unknown-linux-gnu`, SHA-256 pinned in `install-oracle.sh`) for the opt-in path. The take-home Dockerfile keeps the same musl pin. |
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

Moving between Home, Library, Voices, and a player does not wait on a
server render of the viewer. Those shells are client pages. The first paint
reads a non-HttpOnly `ec_signed_in` hint (`1` or `0`, no name or email)
that the proxy sets from the already-verified session. An inline script
sets `html[data-auth]` before paint, so Sign in shows for a signed-out
visitor without `GET /api/viewer`, and a signed-in visitor does not flash
either. The header slot keeps its size. Unknown stays blank
until the viewer answers. `GET /api/viewer` (`src/app/api/viewer/route.ts`)
then fills the name: a signed-out cookie never touches Turso, and a
signed-in one is a user-row read plus `isMarkupOperator`. A missing user
row is still signed in, with a blank name. A database error is 503 and is
not stored as signed out. The payload includes a `key` (a hash of the
session id). When that key changes, the tab drops its screen cache.
`src/components/navigation-warmup.tsx` starts only that viewer read. Jobs
are warmed from Home and the dashboard chrome. Voices are warmed from the
Voices page and from a hover or focus on the Voices link, because
`GET /api/tts/voices` can start a GPU restore. `src/lib/nav/screen-cache.ts`
paints the last payload immediately. A page mount always revalidates. The
20s window only skips a second warmup. Editing the list locally does not
refresh that timestamp. Creating, deleting, cancelling, or retrying a book
drops the jobs entry, and a fresh list removes books that left it. A
library row is enough to paint the player title and, for a take-home, to
start the file already listed. A later 401, 403, or 404 clears that row
and shows the error. A network or 5xx failure keeps the row and shows a
notice. The detail request still loads chapters. The player reads its id
from the pathname, so it does not suspend on `use(params)` into a spinner.
The plus is a prefetched `Link` to `/` and is not rendered on Home.
Library rows use the default prefetch. Voices and the player do not use
`useSearchParams` around the whole screen, which had suspended into a
spinner. The query string is read on the client (`useSyncExternalStore`).
History updates notify on a microtask, because Next writes the URL in an
insertion effect after the new page renders, and that includes
`replaceState` for the clone tab. `GET /api/jobs` releases expired
take-home leases when the list contains one that is queued, waiting, or
processing. Failed and cancelled books do not sweep, and the sweep shares
the 30s poll throttle. The write runs in `after()` so it does not hold the
JSON. Sign-in still reads `getViewerIdentity()` so a signed-in visitor is
redirected before the form. Account uses the same viewer payload as the
header. That helper no longer runs the jobs schema migrator first. The
viewer revalidates on focus and when the tab becomes visible, and a
BroadcastChannel message asks other tabs to do the same.

The page ground is the root background (`src/app/globals.css` on `body`).
A seamless SVG tile — `public/patterns/hatch-dots-dark.svg` in the default
dark theme, `public/patterns/hatch-dots-light.svg` under `.light` — repeats
a sparse field of hand-hatched dots. Light mode draws them in a cool
grey-blue a little darker than the cream; dark mode draws them a little
lighter than the near-black, both at a low opacity so the field stays quiet.
The tile is 800px square. Below 768px it is drawn at 640px, so the dots are
slightly smaller. It does not animate. `forced-colors` drops the image.
Full-page shells are transparent so the tile shows on every route. Cards
(`bg-card`), the landing composer, the sticky header, the mobile tab bar,
menus, player sheets, and the read-along overlay keep an opaque fill, so
type on those surfaces is unchanged.

Landing chrome is quiet: native buttons, inputs, and a thin underline tab.
Copy lives in `LANDING` (`src/lib/ux-copy.ts`): title, Upload / Paste,
Text / URL, primary CTA. No hero essay, format tip, feature grid, or
privacy blurb: the wordmark and the composer are the page, and `/privacy`
is the one place the statement lives. Voices and Library are not in the
bar. Sign in opens a menu that lists them, and a signed-in name opens the
same destinations. Home does not
show a cookie or “books will move” sentence, or the plus. That plus
stays in the dashboard chrome (Library, Voices, player) as an icon whose
name is `NAV.newBook`; it is absent wherever the page already opens a book
upload, which today is `/` only (`showHeaderNewBook`). `/sign-in` is the
title and the Google / email controls, with no password or cookie explanation.
Those cookie facts stay on `/privacy` only. Library, Voices, and the emailed
confirm page do not repeat them. An empty signed-out library is just empty.
A disabled Choose a voice says why (`LANDING.needBook`, `needLink`, or the
50-character paste floor). Make audiobook stays available on the anonymous
cookie. `/terms` has no page; `src/app/not-found.tsx` is the dark screen for
an unknown address, and it does not invent terms.

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

- The Voices tab lists Drew, Ava, Libby, and George until Esther is configured, and Drew, Esther, and George after that, plus Walter when that endpoint is set; a voice whose endpoint is not ready is dropped. The heading is
  **Voice**. Each row’s preview plays with one tap, with or without an upload.
  A tap, or **Make audiobook** with no book, writes `ec_stock_voice_pick`,
  including a `clone:` id. After upload or paste that id stays selected when
  it is still in this person's clone list; a deleted clone is cleared and
  the stock default is used. The narrator suggestion does not
  replace a saved pick. `POST /api/jobs` rejects an unknown or unowned
  `clone:` id with `CLONE_NOT_FOUND` instead of inserting the default voice. **Clone a voice** is a row under the stock list
  (`?path=clone`, `src/lib/voice-path.ts`). It opens the clone form on the
  same screen. Saved clones (`clone:<uuid>`) are also rows in that main list,
  on the Voices page and on the new-book step, marked **Your clone**
  (`voicesForMainList`). They stay selectable when the clone panel is closed.
  The panel's **Your voices** list is the same set. Opening the panel does not
  change the selected voice (`voiceIdAfterPathChange`). A chosen clone is not
  replaced by the stock suggestion (`selectionOnStandardPath`). YouTube clipping for an anonymous
  session says to sign in (`GET /api/clips` `reason: "sign-in"`). The upload
  control is the one on this page.
- When extract finishes, listen prep starts in the background (the take-home worker when `WORKER_URL` is set). `GET /api/pdf/upload/[id]/narrator` reads the cached chunk notes and returns their aggregate. It does not send the book. The Standard list shows immediately. A waiting line stays up until the suggestion arrives. It is not the Whole-book cue pass, which still runs later on the full cleaned speakable after a voice is chosen. The reply is short JSON. The matching line is marked in brackets (`Andrew (recommended)`). Articles, biography, and general nonfiction are Andrew. History is Ryan. A novel names its kind. Romance, cozy, and contemporary use Esther. While Ava is still listed, that suggestion highlights Ava. Any other novel may be Drew, Esther, or George. Clones are never suggested. The Standard list is already on screen. The suggestion fills in when the reply arrives. The suggestion pre-selects until the person taps a line. A missing key or a bad reply leaves the picker as it was. A successful reply is stored as `pdfs/<uploadId>/narrator.json`. Changed text is also stored as `pdfs/<uploadId>/listen-cleaned.txt`.
- Standard: slim stock only. Until Esther is configured the list is Drew, Ava, and Libby, plus George and Walter when those endpoints are set. After that it is Drew, Esther, and George, plus Walter. Drew is catalog id `drew`. Esther is Kokoro `af_heart` (catalog id `heart`, customer name `HEART_DISPLAY_NAME`). George is Kokoro `bm_george`. Walter's id is still `sowell`. Echomancer Andrew (`echomancer-andrew`, Paradee), Andrew (`standard`), Ryan, Clara, Randolph, and Michelle are not listed. A stored Ava or Libby book still resolves on Edge; a new request or saved pick that names either uses Esther only once that endpoint is set. A stored Echomancer Andrew book still resolves; a new request or saved pick that names that id uses Drew. Each listed name is one tappable preview. Narration delivery prefs are not shown here.
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
- Play control: short sample. The five slim voices play `public/voice-previews/<id>.mp3` (preloaded). Fish / clones use `GET /api/tts/live`. A saved clone with `previewUrl` plays that signed URL the way a stock voice plays its file. The selected clone preloads as metadata. On 4G that card may use `preload=auto` and up to 8 visible cards preload as metadata. Save-data, 2G, 3G, and a browser with no network hint (mobile Safari) do not preload the list. Selecting a clone does not POST `/api/capacity/warm`. The list remembers that key, or a ten-minute miss, so the next list does not stat storage. Otherwise it asks `GET /api/tts/clones/[id]/preview`, which streams a remembered key and walks fish v2, then the legacy engine-free key, then an older s2-pro take only when that key is missing. "Preparing preview…" is shown only after `202`. Drama 3 has no key, so its takes can never be found. A miss enqueues one Fish bake of the standard line on the worker and answers `202 PREVIEW_PREPARING`. The picker polls storage and does not enqueue again. A failure is `409 PREVIEW_BAKE_FAILED`; the row shows Try again, and Retry waits out a backoff before one more Fish call. The bake uses this clone's Fish `reference_id` and writes only the fish v2 key. It does not call `synthesizeModalClonePreview` and does not care whether the S2 pool is warm. Creating a clone enqueues the same bake. An older clone with no stored preview bakes on the first Play, one clone at a time. Re-playing a saved voice is a storage read. `src/lib/preview-audio.ts` owns the audio element: one element for every row, and a `play()` rejected by our own `pause()` resolves as `"interrupted"` rather than a toast, which is what produced the `AbortError` message "The play() request was interrupted by a call to pause()".
- Clone sample: `uploadCloneVoice` (presign JSON → PUT R2 → `POST /api/tts/clones`)
- Next (**Make audiobook**): pending clone sample → `uploadCloneVoice`, then
  `startStockBook` (`src/lib/stock-job-create.ts`) — one `POST /api/jobs`
  bounded by 20s. The button does not wait for extract. It replaces the
  voice page with the player. A double tap returns the same queued,
  processing, or ready take-home. The match is reserved in
  `takehome_create_keys` before the job row is inserted, so two overlapping
  requests cannot both create. A failed or cancelled book can be created again.

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
`<audio>` element lives in the **root-layout playback shell**
(`src/components/playback-provider.tsx`), not on this page: a route change
must not unmount it. That shell also keeps the stored playhead moving while
no player page is mounted (`src/lib/player/shell-resume.ts`, every 5s and on
`pagehide`), because otherwise the position froze at the moment of
navigation and closing a tab from the mini player reopened the book there.
It sets no `crossOrigin` and is not routed through Web
Audio (a cross-origin source would make Web Audio output silence; R2 CORS is
not required for element playback). Any AudioContext the app does open is
tracked by `src/lib/player/audio-graph.ts` and resumed before a shell Play,
so a suspended graph cannot mute a resumed listen. The job poll is
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
the **remembered rate** (1× until the listener picks one): tap the compact
label to cycle, or a small chevron to pick any rate from **0.8×** to
**1.5×** in **0.05** steps. That rate is one `localStorage` key
(`ec-player-speed`) for every book and survives a reload and the next book;
a stored value that is not a preset snaps to the nearest one. One
`max-w-2xl` column: transport spacing and play size
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
chapter as artist, the voice as album, `icon-512.png` as artwork, the
playhead (`setPositionState`), and play, pause, seekbackward,
seekforward, seekto, and chapter skip. The page reports that state and its
own transport to the shell (`reportSession`); the shell installs the
handlers once in the root layout, so they outlive the page. See
`docs/mobile-background-playback.md` for what each browser allows. The downloaded MP3 carries the same
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
scrubber, a bookmark control, speed, and the chapter title. It asks the Fullscreen API, but the
overlay is always `fixed inset-0` with `100dvh`, because iOS has no element
fullscreen and a request can be refused — so the CSS path alone is
complete. The Exit control closes it. Esc closes it too, except an open bookmark
list takes that key: the list closes and focus stays, including when the browser
used Esc to leave element fullscreen. An open speed list is dismissed first.
Leaving browser fullscreen by any other path closes focus. A saved preference
reopens it on the next visit. Scrolling is
`behavior: smooth` unless `prefers-reduced-motion` is set, in which case
placement is immediate.

**Resume.** The player used to open every file at 0: the `<audio>` element
has no memory, and nothing stored a playhead. `playback_positions`
(`user_id`, `job_id`, `position_seconds`, `section_index`, `updated_at`)
keeps the last place for that listener and that book. The page also writes
`localStorage` key `ec-resume:<jobId>` so the first paint and a signed-out
browser restore before the server answers. The device the listener is
actively using wins. An idle tab, and a tab that has not applied the
server row yet, does not overwrite another device. A strictly newer
`updated_at` wins until the listener seeks. The same timestamp does not
rewind a playhead that has already passed that row. Pressing play before
that row arrives does
not discard it: the page seeks there and keeps playing. Writes happen
about every 5 seconds while audio is playing and the tab is visible, and
immediately on pause, seek, track change, and when the tab hides.
Becoming visible re-reads `GET /api/jobs/[id]/position` and, when this tab
is not playing, adopts a newer row. It does not write on its own, and a
position that has not moved is not written again. A source change resets
the element to 0 and pauses it; that 0 is the load, so it is not stored. A
pending book time is stored instead. A pending seek stays until the
file can apply it. The 12 second expiry starts once metadata is available
and the seek still has not landed. It does not run while the element is
HAVE_NOTHING, so a slow file still seeks when its metadata arrives. If
that expiry drops a target, the page does not store the start of the file
until the listener seeks or playback moves forward from a position this
tab already confirmed. Nothing is written until the job
response has merged the server row, or that request has failed, and the
unrestored playhead is not written under the server's clock.
`PUT /api/jobs/[id]/position` sends the `updated_at` this tab last read.
The server updates the row only when that value still matches, or when
the write is a seek or a part change. A stale write gets 409 with the
current row. The tab takes that `updated_at` as its new base. If it is
playing, or the listener has seeked since the last confirmed write, it
retries the live playhead once. If it is idle, it seeks to the returned
row. A rejected position is not stored as the winner. A timestamp a 200
has confirmed is never replaced by an older one. The stored number is the
book clock when the part on screen is inside the contiguous ready prefix.
A ready part after a hole keeps that part's own clock for skip, the
scrubber, focus mode, and the lock screen. A finished book within 10
seconds of the end is stored as 0. A book still generating clamps to the
audio that exists. A failed book does not restore. Reopening seeks to that
time and does not press play. An explicit seek is kept. The library line
is `Resume at 33:12` when that time is worth
returning to. Sign-in copies the anonymous rows onto the durable user and
keeps the later one. `GET /api/jobs` and `GET /api/jobs/[id]` include
`resume_position_seconds`, `resume_section_index`, and
`resume_updated_at`. The detail read creates the table first, and a
position read that fails still returns the job with those fields null.

**Bookmarks.** The same one-tap control sits beside playback speed on the
main player and under the scrubber in focus mode. A tap stores the current
book-clock timestamp for this listener and this book
(`POST /api/jobs/[id]/bookmarks`) and the status says `Bookmarked 33:12`.
The chevron opens a short list sorted by that clock. Each row is the
timestamp. A tap seeks there; a remove control deletes the row. There is
no note field and no snippet. A new mark within 2 seconds of an existing
one on the same clock is that mark, including a second tap while the first
request is still in flight. The icon fills for a new mark. The status says
`Already bookmarked` when the server (or that second tap) reports the
existing mark, and it stays up for 2 seconds. Older rows that stored a
part-local time and a label still play: the label is kept in the table and
hidden, and the part time is placed on the book clock when that part's
duration is known. Anonymous bookmarks and resume positions move with the
rest of that browser's library on sign-in. The table is `bookmarks`
(`user_id`, `job_id`, `position_seconds`, `section_index`, `label`).
Another person's book is 404. The lock-screen session seeks on the same
book clock as the scrubber. Read-along stays on the file's own clock.

Stream jobs can `POST …/takehome`. Operator Fish markup is a separate
page (`/dashboard/player/[id]/markup`). The link is rendered only for a
session on `ECHO_OPERATOR_EMAILS` / `ECHO_OPERATOR_USER_IDS` while
`ECHO_OPERATOR_TOOLS=1` (or outside production). Other signed-in owners
do not see it. The operator can open markup for any job id.

### `src/hooks/useAudioProcessor.ts`

No Web Audio. Audio plays from a cross-origin R2 URL, and
`createMediaElementSource` on a cross-origin element outputs silence. The old
graph only applied a fixed 0.75 gain, now `audio.volume = 0.75`. Speed via
`playbackRate`, read from the shared preference store
(`src/hooks/use-playback-speed.ts` → `SPEED_PREF_KEY`, one key for every book),
so a reload and the next book keep the chosen 0.8×–1.5× rate. A stored value
that is not a preset is snapped to the nearest one
(`normalizePlaybackSpeed`). Same hook API as before.

### Playback shell — `src/components/playback-provider.tsx`

One `<audio>` in the root layout. The player page points it at a source
(`setSource`), reports the book clock and its transport (`reportSession`), and
on unmount only calls `detachSession` — the element, `src`, metadata, and
action handlers all stay. `src` is released by exactly three things: the mini
player's Close, a different book's source, and a book that may no longer play
(`releaseForJob`). A pause, a hidden tab, `pagehide`, and `beforeunload` never
release it; recording the position on those events is unchanged
(`use-playback-resume.ts`).

The mini player is a labelled `<section>` above the mobile tab bar with a
spacer of its own height, so it never covers a page. It appears only once the
listener has actually started the book (`started`) and the route no longer
matches it (`playerIdFromPathname`). It reads the playhead from the element
itself, so a 4 Hz clock never re-renders the page under it. Its transport is
a labelled button pair, its progress bar is a native range input with
`aria-valuetext`, and its title links back to the player.

**Play/pause is the element's, not the page's.** The page renders
`usePlayback().playing`, which the shell derives from the one element's own
`play` / `playing` / `pause` / `ended` / `emptied` / `loadedmetadata` events
(`elementIsPlaying`). A page-local `useState(false)` was wrong in both
directions: navigating away unmounts the page while the element keeps
playing, and a book that never stopped fires no `play` event, so re-entry
showed Play over playing audio and its tap called `play()` on an
already-playing element — which resolves without doing anything. The tap
handler reads the element again at tap time for the same reason, and so do
seek and skip: a handler closed over an older render must not start a book
the listener has paused. `ended`, and a decode `error`, are not playing
(`play()` on either does nothing useful). The page report carries the book
clock and the transport (`reportSession`) but not `playing`; only the element
can say that.

Re-entry adopts the live element rather than the stored row: the same file
(ignoring a cache-busting `?r=` and an absolute origin), its part from
`partIndexForSrc`, its playhead and a finite duration. A playhead that is
already playing, past the start, or on a later part is not moved to a stored
or server row, and the page does not re-point `src` or reload. Paused at the
start of that same file still takes the stored resume, on the URL the element
already holds.

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
| `trigger-takehome.test.ts` | create / retry / takehome wake the VM worker; a failed POST stays queued; production without `WORKER_URL` is 503; extract does not leave the worker path |
| `takehome-dispatch.test.ts` / `takehome-worker-client.test.ts` | Worker POST; failed POST stays with the caller; production 503 without `WORKER_URL`; dispatch source never imports another host; HTTP retries |
| `worker/takehome-loop.test.ts` / `takehome-http.test.ts` | Per-job inflight + concurrency; health / auth / enqueue |
| `dispatch-extract.test.ts` | Extract Worker URL POSTs Cloudflare; local/tests extract inline |
| `mastering.test.ts` | default DFN wet 0 / podcast chain + 44.1 kHz 96 kbps loudnorm; fail-open; skip tiny / already-mastered |
| `mastering-loudness.test.ts` | ffmpeg smoke: delivery chain near −16 LUFS, true peak ≤ −1 dBTP |
| `voice-eq.test.ts` | shared curve before loudnorm; band centres within 1 dB; loudness and true peak unchanged; join stays filter-free |
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
| `remote/remote-budget.test.ts` / `remote-invariants.test.ts` / `remote-book-path.test.ts` | Daily budget counts only trailing-day overlap; Fish and previews are not charged; in-flight estimates block slipping under the cap; one in-flight call per section; a cancelled book makes zero new calls; drain restores with min 0 |
| `capacity/warm.test.ts` / `api/capacity/warm/route.test.ts` | Pool mapping and holds; the route rejects a request with no session, does nothing on a proxy-header-only session, and accepts a guest cookie without synthesizing |

**Commands and scope (Implemented in `package.json`):** `npm test` / `npm run
test:run` (Vitest; this checkout tracks 268 `*.test.ts` files),
`npm run typecheck`, `npm run lint`, `npm run test:clip-slider` (Playwright,
`e2e/`), plus `pytest` under `modal/` (23 `test_*.py` files, offline by
`modal/no_live_modal.py`). Suites named after Google SSML cover stored-row and
budget logic; Google Cloud TTS is never called. This audit did not run any of
them.

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
# Operator-reported as set on Vercel (2026-11-07 notes). Hostnames are not in this repo.
# MODAL_S2_CONTROL_URL      # s2_control submit/poll/cancel endpoint used by the remote-call layer (§28, Remote calls).
# S2C_MAX_CONTAINERS=1      # code default (clamp 1–64). A production cap above 1 needs S2_ALLOW_PROD_CAP_ABOVE_1.
# S2C_SCALEDOWN=300         # code default. The live scaledown window is not verified by this audit.
# min_containers is 0 in modal/s2_contract.py (container_limits); there is no env to raise it.
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
FFMPEG_PATH                  # Ubuntu apt on the VM
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
TTS_VM_WAVE_BUDGET_MS / TTS_TAKEHOME_FANOUT
TTS_* worker knobs (see §19)
TTS_PRICE_* / STREAM_MAX_AUDIO_SECONDS
```

### Deploy notes

- `.gitignore` must **not** use a bare `auth` pattern — that hid `src/lib/auth/`
  and broke Vercel builds (`Module not found`). Use `/auth` for root SQLite only.
- `vercel.json` is the bare schema with no `crons`. Whole book is the VM worker
  behind Caddy (`WORKER_URL` → `src/worker/takehome-server.ts` on
  `127.0.0.1:8788`; the hostname in `AGENTS.md` is the operator's). Polls are read-only.
- Procedures live in `DEPLOYMENT.md` (Vercel + Turso + R2), `WORKER.md` (pm2
  worker, deploy and rollback), and `docs/*-runbook.md` (`cpu-modal`,
  `drew-walter-voice`, `george-voice`, `heart-voice`, `s2-gpu-staging`,
  `sowell-voice`). This doc does not duplicate them.

### Observability (Implemented)

There is no third-party telemetry dependency in `package.json` (no Sentry or
OpenTelemetry). What exists:

- `GET /api/health` (`src/app/api/health/route.ts`): `healthy` (200) when
  Turso answers `SELECT 1` and R2 is configured, else `degraded` (503). It
  returns no per-service detail.
- Worker `GET /health` (inflight, concurrency, uptime, extract inflight) and
  `GET /ready` (200/503) on the take-home worker.
- `POST /api/log`: browser error reports, rate-limited and fail-open.
- `remote_calls` rows: every remote flight and its outcome is persisted by
  the event sink in `src/lib/remote/reconcile.ts` → `persistRemoteEvent`
  (`src/lib/remote/store.ts`); open calls are re-hydrated on worker start.
  Spend loads every `started` row and looks up each flight's end through
  `idx_remote_calls_flight_end` / `idx_remote_calls_flight_outcome_end`.
  Book spend has no time window, and an open call older than a day still
  counts, so that load is not cut to the trailing day. The inflated-span repair is one
  index range on `ended_at` per process per day, not a full-table update on
  every reconcile.
- `usage_logs`: best-effort accounting (for example `modal_s2_clone`).
- Server logs are `console.*` lines with `[takehome-worker]`, `[remote]`,
  `[section-master]`-style prefixes, read through pm2 logs on the VM and
  Vercel function logs.
- Generate secrets with any CSPRNG (`openssl rand -hex 32` or PowerShell
  equivalent); they are not vendor API keys.

---

## 26. Invariants checklist

1. **Identity is server-minted.** Cookie/header always re-verified with HMAC.
2. **Wrong owner → 404** on jobs/storage (not 403).
3. **Job create never synthesizes.** The VPS worker does. Polls do not synthesize.
4. **Lease token gates all take-home progress writes.**
5. **Silence is failure.** Preview / sections / stream windows all guard.
6. **Stream cursor advances only after audible bytes.**
7. **Shared PDF folders survive** until the last sibling job is deleted.
8. **Accent variants are Gemini-only;** style prompts only for vendors that honor them.
9. **OpenRouter `pricing.prompt` is untrusted** without override / plausibility window.
10. **`/api/storage` is the only browser file path** — ownership checked every time. A playback `Range` is a same-origin 206, capped at 256 KiB when the request is open-ended or larger. A later range stays on that URL; redirecting it makes Chrome raise a network error and the player returns to 0:00. `full.mp3` playback is served after a leading ID3 tag so a seek to zero does not read the chapter tag; the stored object is unchanged. A request with no `Range`, and a named download, 302 to a presigned R2 URL. Finished-book downloads use a presigned `download_url` minted on the owned job routes.
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

## 28. Cost, budgets, scaling & prewarm

Nothing in code keeps a container running. Every Modal app is declared with
`min_containers: 0` (`modalAppRegistry`; `modal/s2_contract.py`
`container_limits`, `modal/sowell_worker.py`, `modal/cpu_worker.py`). A warm
container exists only while a request, a book, or a short warm hold is using
it, and then scales to zero after its scaledown window.

### Fleet caps (Code default)

| App | Min | Max | Scaledown | Notes |
|-----|-----|-----|-----------|-------|
| `echomancer-s2-clone` (H100 GPU) | 0 | `S2C_MAX_CONTAINERS`, default **1** (clamp 1–64) | `S2C_SCALEDOWN`, default 300 s | A production cap above 1 needs `S2_ALLOW_PROD_CAP_ABOVE_1`. The drain may brake the live max and restore the value it read; any other change is an operator running `scripts/s2/set-live-autoscaler.py`. Live value is operator-reported as max 1. |
| `echomancer-sowell` (CPU Kokoro) | 0 | `SOWELL_MAX_CONTAINERS`, default 16 (clamp 1–16) | default 5 s (clamp 2–1200) | Drew, Walter, George, Esther. |
| `echomancer-cpu` (CPU) | 0 | `CPU_MAX_CONTAINERS`, default 4 | 10 s | Mastering, Whisper for engines that still transcribe, join, extract when `CPU_RUNNER=modal`. The five-minute New Book warm is a worker keepalive when the worker is told this window. A fleet size, not a spend cap. |

`MODAL_S2_MAX_GPUS` (default 20) is a count of `modal_gpu_leases` rows the app
will hand out (`src/lib/tts/providers/modal-gpu-lease.ts`). It does not start
or reserve GPUs; the Modal max above is the real ceiling.

### Remote-call budgets — `src/lib/remote/layer.ts` (Implemented)

Calls to the paid remotes go through the remote-call layer, which tracks each
flight and its spend (`remote_calls`). `countsTowardGpuBudget` counts the
providers `s2-clone`, `kokoro`, `modal-cpu`, and `prewarm` on every path,
including `preview`; Fish calls are never counted, and other providers are
not counted on the preview path. Admission checks four budgets before a
counted call is made:

| Env | Default |
|-----|---------|
| `REMOTE_BOOK_BUDGET_USD` | 20 per book |
| `REMOTE_DAILY_BUDGET_USD` | 80 per day |
| `REMOTE_BOOK_BUDGET_MS` | 6 h of remote time per book |
| `REMOTE_DAILY_BUDGET_MS` | 12 h of remote time per day |

Budgets are enforced unless `REMOTE_ENFORCE_BUDGETS=0`; under Vitest they are
off unless it is `1`. On a breach the book fails with "This book is over its
remote-call budget." Remote time is the merged busy interval of a book's
calls (`mergedIntervalMs`). The Stop button (`POST /api/jobs/[id]/cancel`) and
`DELETE /api/jobs/[id]` call `stopBookRemotely` (`src/lib/remote/stop.ts`),
which refuses new remote calls for that book in this process and asks the
worker to drain the calls it holds (`requestBookDrain`).

### Prewarm and capacity warm (Implemented)

- **Capacity warm** — `POST /api/capacity/warm` (`src/app/api/capacity/warm/route.ts`,
  client `src/lib/capacity/client.ts`, policy `src/lib/capacity/warm.ts`).
  Requires an existing `ec_session` cookie. `poolsForWarm` maps the reason:
  a voice page with a `clone:` voice → nothing (a preview is a stored MP3;
  `prewarmS2Clone` is not called); a Kokoro voice → `kokoro`; book
  create → `cpu` (plus `kokoro` for a Kokoro voice). A clone book does not
  gain an S2 warm from create. Holds are short:
  `cpu` 300 s, `kokoro` 25 s, `s2` 90 s, and `KOKORO_WARM_CONTAINERS` is 1.
  The worker's `/capacity-warm` route sends a warm request for cpu/kokoro and
  calls `prewarmS2Clone` for s2. A hold does not change `min_containers`.
- **S2 prewarm** — `prewarmS2Clone` (`src/lib/remote/prewarm.ts`) is itself a
  remote call (provider `prewarm`, est. 90 s, est. $0.10), so it is admitted
  against the budgets above. It runs `modal run modal/s2_clone_warm.py::prewarm`
  and reports `unconfigured` without `MODAL_TOKEN_ID` or `MODAL_S2_WARM_CMD`.
- **Clone pool prewarm on catalog** — `/api/tts/voices` does not call
  `requestClonePoolPrewarm`. Preview Play does not either. That POST held a
  Vercel function until the worker timed out and never spoke the preview.
- `prewarmModalCloneSnapshot` (`src/lib/tts/providers/modal-clone-warm.ts`)
  returns false and spawns nothing. `kickModalCloneSnapshotWarm` runs the
  snapshot cover only after a placement misses its restore budget, with a
  20-minute cooldown, and is off when `MODAL_S2_WARM_HOOK=0`.

A clone preview plays a stored Fish-baked file once it exists; it does not
start the GPU (§1.3).

### Not verified

Real per-call prices, live scaledown windows, and current monthly spend are not
in this repo. The `estCostUsd` values are admission estimates, not invoices.

---

## 29. Known limitations

- **One take-home worker.** Whole-book generation, extract, listen prep and
  drain all run in one pm2 process (`src/worker/takehome-server.ts`). If it is
  down, books queue and no generation runs. Restart and rollback are in `WORKER.md`.
- **Clone books share one GPU.** With the S2 cap at 1, concurrent clone books
  wait on `modal_gpu_leases`; a cold container pays snapshot restore or
  compile time. Snapshot coverage of the live image was not verified.
- **Edge TTS is unofficial.** Stored Andrew/Ava/Libby/Ryan/Michelle books use
  the Edge Read Aloud websocket (`src/lib/tts/edge-tts.ts`), which has no SLA
  and can break when Microsoft changes the handshake.
- **Paradee is kept for one stored id.** Only a stored `echomancer-andrew`
  book reaches `src/lib/tts/providers/paradee.ts`.
- **Vercel body size.** Uploads go straight to R2 by presigned PUT, so the
  ~4.5MB function body limit applies only to JSON routes.
- **Fixed-window rate limits.** `rate_limits` counters allow a burst at a
  window edge; `storage-read` and `client-log` fail open when Turso fails.
- **Budgets are partial.** Dollar budgets use admission estimates
  (`estCostUsd`), and Fish hosted-API calls sit outside them.
- **Guest library is cookie-bound.** An `anon_*` library lives only in this
  browser's `ec_session` cookie (1 year). Signing in merges it into the
  account (`mergeAnonymousOwnership`); clearing cookies or signing out before
  that loses access to it.
- **Incomplete books fail.** A book with any missing section is published
  `failed` with its sections kept; job `75944dc9` was not regenerated.

---

## Remote calls

S2, Fish, Kokoro (Drew, Walter, George), Modal CPU, clone previews, and the
S2 prewarm all enter through `src/lib/remote/layer.ts`. One flight per
provider, book, and section: a second start joins the running call or is
refused while that call is still live. A refusal is `ModalCloneHeldError`.
It does not kick `::cover` and it does not start the Fish clock. The S2 book path is submit-then-poll on the CPU function `s2_control`
(`MODAL_S2_CONTROL_URL`). That function has no GPU. It spawns
`S2CloneWorker().render_batch` (the class is instantiated; a method read
on the Cls raises) and returns `{call_id, status:"pending"}`
immediately. The worker writes that id on the flight before it polls. The
same endpoint with `{call_id}` or `?call_id=` returns status via
`FunctionCall.get(timeout=1)`, and `{call_id, cancel:true}` calls
`.cancel(terminate_containers=True)` and then reads the status. Stop and
the drain cancel by that HTTP call. There is no function-call listing and
no tag match: the CLI listing does not include the request body. A timeout
after the id is stored stays `still_live` until that id is terminal.
`expired` is a terminal miss. NotFound on `get()` stays unknown
(`error: not_published`): the input may still be pending, so the same id
is polled and one resubmit uses the same idempotency key. After the render
wait plus 30s of that miss, the flight settles like `expired` and no longer
blocks `::cover`. The attempt does not move. A poll that is not OK, or whose
body is not JSON, stays unknown and is polled again; it does not finish the
flight. Startup
and the hourly pass read the oldest-polled stored ids, eight per pass, so
a pending prefix cannot starve the rest. A completed HTTP response, including an abort
of Fish, Kokoro, or Modal CPU, is retryable. `still_live` is not cleared
by Stop.

The submit carries `idempotency_key` `job:sections:attempt`. The control
function stores it in a Modal Dict for six hours and returns the existing
call id on a repeat. `render_batch` returns the audio JSON object. A poll
never puts response bytes into JSON.

Deploy the Modal app, run `::cover`, then restart the worker with
`MODAL_S2_CONTROL_URL`. The deploy rebuilds `S2CloneWorker` GPU snapshots,
so `::cover` after the deploy is mandatory. A batch body uses submit-poll
whenever that URL is set. A timeout (no HTTP status) retries the same
idempotency key until the control deadline. The window then reads the
Dict with `{lookup:true, idempotency_key}` and does not spawn. No id is
`submit_unconfirmed`: the attempt stays, and the next tick posts the same
key. Three empty lookups, or 135s, fail the section, and that last lookup
is stored when it finds an id. A completed HTTP 5xx is the function
answering, so nothing was spawned. Those responses retry only inside the
45s deadline. The Dict is still read once. With no id, the section is
`failed` and the book is `failed` with "The voice engine didn't start.
Try again." A processing book with no section would otherwise keep
showing "Starting the clone voice…". Reconcile and drain resolve a key that has
no stored id the same way. The GPU post is used when the URL is unset, or
when the control body names a different protocol. A `{text}` post stays on
`MODAL_S2_SYNTHESIZE_URL`. A body that already contains `items` inside the
accept window is still the finished audio.

`FunctionCall.cancel(terminate_containers=True)` is followed by a status
read. A pending read, or a thrown NotFound with no terminal status, is
still live. `expired` and `init failure` are terminal. `not_found` is not:
the input may still be pending, so the attempt does not move.
The drain cancels through the HTTP endpoint. Brake, restore, and the running
container count are the same endpoint (`{autoscaler:"read"|"brake"|"restore"|"count"}`),
with the same bearer. The control container applies them to the app it was
deployed as. The request does not choose an app. The worker does not run the
Modal CLI and does not need the `modal` package. It brakes only when that
cancel is still non-terminal and, re-checked immediately before the brake, no
other S2 book has a live call. It waits until the extra containers are gone,
or until that wait expires, and then restores the live max read before the
brake. A throw after the brake restores the same max. The hourly heal restores
a brake row only when the live max is still 0. Any other live cap is left
alone and the row is cleared, so a later hour does not overwrite a cap set
after the drain. `min_containers` stays 0. It does not stop a container first,
and it does not stop the Modal app. `planDrain(0)` restores 0, not 1.
`::cover` is blocked for every book by an S2 flight that has a function-call
id and is `running` or `still_live`. A flight with no id yet blocks cover only
for its own book.

A budget breach fails that book. It does not park it as cold and it does
not switch narrator. Dollars come from persisted `remote_calls` rows, stored
in milliseconds. A reload replaces that book's reservations instead of
appending them. Overlapping Kokoro lanes count as one wall clock. The daily
figure is the overlap of each call with the trailing 24 hours. One call is
never charged longer than the book time budget, and the slice that is kept
is the most recent one, so GPU time that still sits in the trailing day is
not dropped in favour of hours that already fell out of it. An in-flight
estimate stays on the ledger until the call ends. Elapsed time merges
across parallel lanes; reservations still in the future are summed, because
those calls run one after another. An abandoned row whose end was moved
forward by a later cleanup pass is clamped once at startup and again each
hour; a second pass does not move the end. A started row whose own end was
slid is marked abandoned by that clamp, so the load does not treat the
clamped span as still open and stretch it back to now. Fish hosted-API renders are
outside that GPU budget. A clone, Kokoro, or Modal CPU call still counts
when its path is `preview`. Under
Vitest budgets are off unless `REMOTE_ENFORCE_BUDGETS=1`.

The same registry (`modalAppRegistry`) describes the S2, Kokoro, and Modal
CPU apps. Each has `min_containers: 0`. Startup and the hourly pass load
the newest row per `flight_key`. A health check with no restore sample skips. The clone
prewarm is one restore-only RPC that cancels itself on timeout. Apart from
the drain's brake-and-restore above (which only restores the max it read),
the live autoscaler is set by an operator with
`scripts/s2/set-live-autoscaler.py` (`--max-containers`, `--scaledown-window`,
`--brake`); see `docs/s2-gpu-staging-runbook.md`.

## Related reading order (first week in the codebase)

1. `src/proxy.ts` → `lib/auth/session.ts` → `lib/auth/guard.ts`
2. `app/api/pdf/upload/route.ts` → `lib/jobs/dispatch-extract.ts` → `workers/extract`
3. `app/api/jobs/route.ts` → `lib/jobs/takehome-dispatch.ts` → `lib/jobs/serialize.ts`
4. `lib/tts/catalog/*` → `lib/tts/providers/{sowell,drew,george,heart,fish,modal-clone,edge,paradee}.ts` (Edge and Paradee are legacy)
5. `lib/tts/stream-session.ts` + `app/api/jobs/[id]/stream/route.ts`
6. `src/worker/takehome-server.ts` + `WORKER.md` + `lib/tts/process-job.ts` (claim → frozen-script → synthesizeSection → remux)
7. `modal/s2_contract.py` + `docs/s2-gpu-staging-runbook.md` for the clone pool. The runbook is the procedure. A blank checklist is not evidence the step was done.
8. `app/dashboard/{voice,queue,player}` with `lib/ux-copy.ts` open beside them
9. `src/test/harness.ts` + `src/test/acceptance/book-path.acceptance.test.ts`

*Document tracks Echomancer v2 source as of 2026-11-21 (`e4b6ef2`, #316):
Next.js on Vercel, Turso + R2, the pm2 take-home worker behind Caddy, Modal
apps `echomancer-s2-clone` (GPU, min 0 / max 1 by default), `echomancer-sowell`
and `echomancer-cpu` (CPU, min 0), and Fish for clone previews and stored Clara
books. Edge serves stored legacy books (and Ava/Libby until Esther is
configured); Paradee serves stored Echomancer Andrew books only. Live deploy overrides and unverified gaps are in
"How to read claims" at the top. Job `75944dc9` was not regenerated.*
