# Echomancer v2 — Agent Guide

> Documents → audiobook. Shipped stock voices are **Andrew**
> (catalog id `standard`, Edge `en-US-AndrewNeural`), **Michelle** (`en-US-MichelleNeural`), **Clara**
> (curated Fish), and **Randolph** (Google `en-GB-Neural2-O`). Do not add
> rejected Edge females (Ava, Libby, Jenny, Sonia, Aria). UK Fish female is
> still TBD via `curated-fish-stock.ts`. **Fish voice cloning** stays on the
> direct Fish API (`FISH_API_KEY`). No self-hosted TTS, no webhooks.

## Product pricing

- **Target:** ~**€4.50** per typical take-home book (a target, not a hard ceiling).
- **Dynamic pricing:** `src/lib/tts/pricing.ts` → `estimatePriceEur({ charCount, voice })`.
- Live listen is capped (~1 hour of audio) for cost control; take-home is a separate job.

## Generation paths

| Path | `generation_mode` | `job_kind` | Backend |
|------|-------------------|------------|---------|
| Live Stream | `stock` | `stream` | Vercel: provider stream → `GET /api/jobs/[id]/stream` |
| Full download ("Whole book") | `stock` | `takehome` | Always-on VM worker: `runTakehomeUntilSettled` → R2 |

## Ownership model — read this first

**Nothing is unowned.** Signed-out visitors get a signed anonymous session
(`anon_<32 hex>`) from `src/proxy.ts` via `src/lib/auth/session.ts`. Google
sign-in (Auth.js v5) upgrades the same `ec_session` cookie to a durable
`user_*` id stored in Turso `users` — never the Google `sub`.

- Routes read identity through `resolveSessionUserId()`. Trigger jobs keep
  using `jobs.user_id` (that same id after a merge).
- On Google sign-in, this browser's `anon_*` jobs / uploads / cloned_voices
  are reassigned to the signed-in `user_*`. The same Google account on two
  browsers shares one `user_*`.
- Sign-out issues a **fresh** `anon_*` cookie so the previous library is not
  leaked.
- Ownership checks live in `src/lib/auth/guard.ts`. A job owned by someone else
  is reported as **404**, never 403, so ids cannot be enumerated.
- `/api/storage/**` resolves each key back to its owning job or upload. Object
  keys are guessable, so the key is never treated as a secret.
- `POST /api/jobs` rejects any `pdfStoragePath` with no `uploads` row for the
  caller.

`SESSION_SECRET` is **required in production**. Without it the app refuses to
sign sessions rather than minting a per-instance key, which would scatter
identities across serverless instances and lose people their libraries.
Google sign-in also needs `AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET` (and
`AUTH_SECRET` or reuse `SESSION_SECRET`). Missing Google env fails closed on
the sign-in route (503); anonymous upload / Live Listen still work.

## Who runs generation

**Whole book runs on an always-on Oracle Always Free VM**, not inside Vercel
isolates and **not** on Trigger.dev in production. Extract stays on
Cloudflare Workers.

| Host | Entry | Role |
|------|-------|------|
| Always-on VM | `src/worker/takehome-server.ts` | Imports `runTakehomeUntilSettled` in-process. Oracle Always Free Ampere (`VM.Standard.A1.Flex`, 2 OCPU / 12 GB, Ubuntu aarch64) + pm2 `echomancer-takehome`. Binds `127.0.0.1:8788`. Caddy terminates HTTPS at `worker.echomancer.xyz` (Vercel DNS A; domain is not a Cloudflare zone). See `WORKER.md`. |
| Trigger.dev (**legacy**) | `takehome.advance` / `takehome.drain` | Fallback only when `WORKER_URL` is unset or `TAKEHOME_TRIGGER_FALLBACK=1`. Not the production Whole-book runner. |
| Cloudflare Worker | `workers/extract` | Document parse next to R2 (`unpdf` / mammoth / JSZip). Fast cold start. Voice pick is unblocked while extract runs. |
| Vercel | `POST /api/pdf/upload` | Presign only (tiny JSON). Browser PUTs to R2. **No file bytes, no extract.** |
| Vercel | `POST /api/pdf/upload/[id]` complete | HEAD + dispatch extract (Worker if `EXTRACT_WORKER_URL` is set, else `after()` / in-process). **Not Trigger.** `GET` re-nudges stuck `uploaded` (20s) or `extracting` (180s). |
| Vercel | `POST /api/jobs` / `…/takehome` / retry | Enqueue + `POST $WORKER_URL/jobs` — **no Fish** |
| Vercel | `GET /api/cron/process-jobs` | Operator fallback (`CRON_SECRET`) |
| Vercel | `POST /api/jobs/[id]/process` | Operator fallback (`INTERNAL_JOB_SECRET`) |

Live Listen and Live Stream stay on Vercel.

**Delivery cadence** (`resolveDeliverySettings`) applies to Whole book **and**
Live Stream / Live Listen: pauseStyle and title cleanup. Soft crossfade is
Whole-book concat only. Whole-book Fish / Edge / Google run **one logical**
OpenRouter cue-tag pass on the frozen speakable (DeepSeek Flash; long books
are paragraph-chunked and tagged in parallel), then the packer splits. The
tagger inserts allowlisted Fish S2 square-bracket cues only. It infers text
type and maps attitude and delivery onto that list (denser than the old
10-per-8k clamp). Narrative nonfiction and audiobook prose prefer
`[confident]` and `[emphasis]`. Dense `[calm]` is the breath register on
exposition, so `[calm]` stays only when that sentence is soothing or the
speaker is calm, and it is not stacked with another cue. `[soft tone]` is
the lullaby cue and is removed from Whole-book Fish text rather than
rewritten into `[calm]`. Effect cues stay only when the same sentence
depicts that sound. `[shouting]`, `[screaming]`, `[hysterical]`, and
`[extremely excited]` stay allowlisted but are remapped onto `[confident]`,
`[emphasis]`, `[curious]`, or `[indifferent]` unless that sentence clearly
shouts. Whole-book Expressive uses those same warrant rules, including a
warranted `[shouting]`. A short title is `[confident]` plus `[long-break]`.
`[break]` and `[long-break]` stay the shared pause IR (paragraph and
sentence beats). They are silence, not breath effects. Fish section audio
uses cache variant `fish-cues-steady-v5` so an older breathy take is not
replayed. The Standard vs Expressive compare preview is unchanged.
Fish receives exactly:

```
Chapter One

[confident] The harbor was quiet after the rain. She closed the ledger and said, "We leave at dawn."
```

One allowlisted `[confident]` on the spoken line. `[soft tone]` is the
lullaby cue (gentle, quiet) and s2.1-pro-free breathes on this short
sample, so the compare path does not use it. No effect cues (`sighing`,
`gasping`, `groaning`, laughing, and the rest of the effect list), no
`[whispering]`, no `[emphasis]`, no `[long-break]`, and no emotion stack
on the two-word title. Edge compare keeps the pause after "Chapter One"
and no tone tag, so the two previews still differ. Unknown brackets are
stripped. `EXPRESSIVE_PREVIEW_CACHE_REVISION` is `compare-confident-v2`
so clips saved with the soft-tone script are missed.

That Expressive compare clip is saved once at
`previews/expressive/<sha256>.mp3` (R2 in production, `STORAGE_PATH` in
dev). The hash is the cache revision, catalog id, Fish reference id,
model, and the exact script above. A later tap of Andrew, Michelle, or
Randolph Expressive — including Play both — reads the object and does
not call Fish. Changing the script or `FISH_TWIN_*_REF` misses and
records a new clip. Bump `EXPRESSIVE_PREVIEW_CACHE_REVISION` in
`src/lib/tts/expressive-preview-cache.ts` to force a new take of the
same words and reference. The preview HTTP response stays
`Cache-Control: private, no-store`. Whole-book synthesis does not use
this object.
There is no book-level `[conversational seminar tone]` prefix. Google maps
Fish `[break]` / `[long-break]`
to SSML `<break>` (`ssml-pauses.ts`). Edge Read Aloud rejects custom `<break>`
(1007), so the same IR becomes punctuation breaths inside the stock
speak/voice/prosody envelope. Emotion/tone square brackets are stripped for
Edge / Google so they are never spoken as words. OpenRouter / Gemini stay
untagged so they do not speak the words. Preview one-liners stay short; they
still honor `ttsOptions` when sent.

`POST /api/jobs` **enqueues only** and returns immediately. Production
`TTS_POLL_NUDGE_BUDGET_MS=0`: Library/Player polls may sweep expired leases
but **must not synthesize**. Missing both `WORKER_URL` and `TRIGGER_SECRET_KEY`
on Vercel is a **503** (`TAKEHOME_NOT_CONFIGURED`) **before insert**. After
insert, a worker POST failure leaves the job `queued` for the VM drain loop
and still returns 200.
Missing Turso / R2 in the VM worker fails startup loudly rather
than stalling `queued`. `FISH_API_KEY` is required only when the job uses a
Fish clone, a curated Fish stock voice, or leftover `fish-narrator`. Edge stock
voices need no Fish key. Randolph needs `GOOGLE_TTS_API_KEY` or
`GOOGLE_TTS_ACCESS_TOKEN`.

Nothing "self-chains": HTTP self-calls from `/process` caused Vercel **508 Loop
Detected**, and `after()` was observed not to run. Continuation is the lease +
index cursor in the `jobs` row.

## Leases, not timeouts

A worker claims a job by writing a random `processing_lease_token` with
`lease_expires_at`, then **heartbeats** while it works. Every progress write is
conditioned on still holding the token, so a worker whose lease was reclaimed
cannot clobber its successor. Reclaim happens only when a lease actually expires.

The previous "stale after 75s" rule could not distinguish a hung worker from a
slow one, so any section slower than the window was synthesized twice.

## Empty audio

Providers sometimes answer HTTP 200 with a bare WAV header or zero-filled bytes.
`src/lib/tts/audio-guard.ts` → `isEmptyOrSilentAudio` is checked by **preview,
take-home sections, and stream windows**. Behaviour on silence: retry once
without accent direction (over-steered Gemini input is a known cause), then fail.
A stream never advances `stream_cursor` past a passage that was not narrated.

## Stock providers (`src/lib/tts/`)

**Preferred: OpenRouter (one key, all speech models)**

| | |
|--|--|
| Env | `OPENROUTER_API_KEY` |
| Catalog | Live `GET openrouter.ai/api/v1/models?output_modalities=speech` → expand `supported_voices` |
| Synth | `POST openrouter.ai/api/v1/audio/speech` (OpenAI-compatible stream) |
| Code | `providers/openrouter.ts`, `catalog/openrouter-catalog.ts` |

Direct fallbacks (optional): google / gemini / grok with their own keys.
**Randolph requires Google Cloud TTS credentials** (not optional for that voice).

Catalog API: `GET /api/tts/voices` · `source: "openrouter" | "static" | "research"`

**Default slim catalog:** **Standard** (`standard` → `en-US-AndrewNeural`),
**Michelle** (`michelle` → `en-US-MichelleNeural`), **Clara** (`clara` → Fish
`a50f1ee074124ba2b1dc44623f99abbe`), **Randolph** (`randolph` → Google
`en-GB-Neural2-O`) plus user clones. No Gemini / MiniMax / rejected Edge
females (Ava, Libby, Jenny, Sonia, Aria). Customer UI shows those four names
only. Edge stock Live Listen / Whole book do not spend Fish. Clara needs
`FISH_API_KEY` on the account that owns her reference.

**Standard / Michelle (Edge TTS) caveats:** server synthesis talks to
Microsoft Edge’s undocumented Read Aloud websocket (`speech.platform.bing.com`,
same family as `edge-tts`). No Azure Speech key. Microsoft can change,
rate-limit, or block this path; if it dies, swap `src/lib/tts/providers/edge.ts`
for Azure or another adapter. Do not show raw Microsoft voice ids in customer
copy.

**Clara (curated Fish stock):** `src/lib/tts/curated-fish-stock.ts` is the
registry. Add a friendly id + account `reference_id`, a `voices.json` card, and
the id to `SLIM_STOCK_VOICE_IDS` to list another Librivox / Archive.org
narrator (UK female still TBD). Synthesis uses `fishTtsProvider` **with**
`reference_id`. Do not send OpenRouter catalog UUIDs.

**Fish twins for Standard / Michelle / Randolph:** `src/lib/tts/fish-stock-twins.ts`.
The picker ids do not change, and the default choice stays on Edge (Andrew,
Michelle) or Google (Randolph). The Andrew card is labeled **Andrew**
(catalog id stays `standard`). **Expressive** (`Andrew (Expressive)`, and
the same for Michelle / Randolph) sits beside that name on those three
slots only — not Clara, not user clones. Each twin is a Fish clone of that
slot's own Edge or Google voice, same flow as any other clone: `POST /model`,
`visibility=private`, `train_mode=fast`. Paste the 32-hex id into
`FISH_TWIN_*_REF` (or bake it once it exists). Expressive is selectable when
that id is wired **and** the quality gate is open (`FISH_TWIN_STANDARD=1`,
and the same for Michelle / Randolph). Set both on Vercel and the VM.
Andrew is the ears bar. An Expressive job stores `tts_provider=fish` and
uses the same DeepSeek cue-tag path as Clara. A Standard job stays
`edge` / `google` even if the gate is open. The picker shows Expressive
once a reference is wired; if the gate is still closed the line is not a
preview (“Not available yet”). No reference hides the line. Tapping a
name plays that delivery: Edge or Google for the plain name, the Fish
compare sample for Expressive. Play both previews a fixed sample on each
path and does not need a book. Clara's
reference is a different narrator, not Michelle's twin. This tree ships
with all three gates closed and `fishReferenceId` empty. A twin synthesis
with a non-hex voice id fails closed instead of speaking Fish's default
voice.

**Stock suggestion:** when extract is ready, the voice page calls
`GET /api/pdf/upload/[id]/narrator` before it shows the Standard list. That
call is separate from Whole-book cue markup. Markup runs later, after a
voice is chosen. Cleanup starts when extract finishes and runs once
per upload. Each chunk returns a short note (kind, tone, point of view,
dialogue). The suggestion is the aggregate of those notes. It does not
send the book again. The matching
line is labeled in brackets: `Andrew (recommended)` or
`Andrew (Expressive, recommended)`. Articles, biography, and general
nonfiction preselect Andrew on standard delivery. History preselects
Randolph on standard delivery. A novel may be any stock voice, standard or
expressive. Clara stays standard. Clones are never suggested. The person
can always choose; a tap keeps their pick. The list waits at most a couple
of seconds for the reply, then shows anyway. A missing key or a bad reply
leaves the picker as it was. The list shows immediately. A short waiting
line fills the suggestion in when the notes are ready. The cleaned text and
a hash of the source are stored as `pdfs/<uploadId>/listen-cleaned.txt` and
`listen-prep.json`, including when nothing was dropped, so freeze and later
visits do not clean the book again.

**Randolph (Google Cloud TTS):** `src/lib/tts/providers/google.ts`. Set
`GOOGLE_TTS_API_KEY` (or `GOOGLE_API_KEY`) or `GOOGLE_TTS_ACCESS_TOKEN`.
Without a key, Randolph preview / jobs fail closed with a config error. Do not
show `en-GB-Neural2-O` in the picker.

**Fish voice cloning:** set `FISH_API_KEY` → upload a sample on `/dashboard/voice`
→ Fish trains a private `reference_id` → clone appears in the picker (`clone:<uuid>`,
provider `fish`). Synthesis for clones uses the **direct Fish API** (not OpenRouter),
because private reference ids are account-scoped. Samples presign → PUT R2
→ `POST /api/tts/clones` `{ uploadId }` (never a fat Vercel body). See
`POST /api/tts/clones/upload`.

**Fish live preview:** `GET/POST /api/tts/live` proxies Fish’s **HTTP chunked**
TTS (`latency=balanced`) so previews progressive-play without buffering the whole
clip. With `FISH_API_KEY`, Fish catalog voices also resolve to the direct Fish
adapter for listen streams. Legacy `fish-narrator` jobs still resolve and use
Fish’s default S2.1 Pro Free voice — **never** send the OpenRouter catalog UUID
(`00a1b221-…`) as native `reference_id`. Clones (`clone:<uuid>`) send the real
account reference. Live errors before audio starts return JSON (not HTML `/500`).
WebSocket `/v1/tts/live` is not used (LLM token streaming only).

Optional override: when `MINIMAX_FREE_API_BASE_URL` + `MINIMAX_FREE_API_TOKEN`
are set, primary becomes MiniMax Free API Storyteller instead. See
`RESEARCH_PREVIEW.md`.

## Premium HD voice gate

```
PREMIUM_HD_ENABLED=true # or
PREMIUM_HD_ALLOWLIST=sessionUserId,ip
```

When off, HD voices are hidden in the UI and rejected at preview, job create and
take-home spawn. All voices use the same stock pipeline.

## Job flow (take-home)

1. `POST /api/jobs` `{ mode: "stock", jobKind: "takehome", catalogVoiceId, pdfStoragePath }` → `queued`
2. Worker claims the lease and synthesizes up to `TTS_SECTIONS_PER_TICK` sections per tick, many ticks per invocation
3. Progress lands in `segments_json` / `next_section_index`; the job returns to `queued` between waves
4. On the final section it concatenates and encodes once (podcast delivery chain: high-pass, low-mid cut, presence, light de-ess, loudnorm −16 LUFS / −1.5 dBTP, 44.1 kHz ~192 kbps). That file is the upload. A second pass runs only for DeepFilter opt-in or a section that skipped the chain (fail-open).
5. Frontend polls and can play ready sections early

## Job flow (stream)

1. `POST /api/jobs` `{ mode: "stock", jobKind: "stream", catalogVoiceId, ... }`
2. Player opens `GET /api/jobs/[id]/stream` — pipes provider audio, one reader at a time
3. Capped by `STREAM_MAX_AUDIO_SECONDS` / character budget
4. Optional `POST /api/jobs/[id]/takehome` for a full offline copy

## Deleting a job

The `pdfs/<uploadId>/` folder is **shared** — a chapter preview and a full book
are separate jobs over one upload. `DELETE /api/jobs/[id]` removes
`audiobooks/<jobId>/` eagerly but only removes the upload folder when no
non-deleted sibling job still references it.

## Key paths

```
src/proxy.ts # Issues the session cookie
src/lib/auth/{session,guard,google,authjs,identity,actions,sign-out}.ts # Identity + Google + ownership
src/lib/jobs/{serialize,worker-auth,takehome-dispatch,takehome-worker-client,trigger-api,trigger-takehome,trigger-extract,trigger-secrets}.ts
src/lib/turso/{jobs,uploads,cloned-voices,clone-uploads}.ts
src/lib/rate-limit.ts # Fail-open vs fail-closed limiters
src/lib/document-formats.ts # Accepted types + upload ceiling (client-safe)
src/lib/clone-sample-formats.ts # Clone sample types + 32 MB ceiling (client-safe)
src/lib/uploads/{extract,http,rate-limit}.ts
src/lib/upload-client.ts # Book + clone-sample presign → PUT storage
src/lib/tts/
 types.ts, pricing.ts, premium.ts, split-text.ts, speakable-text.ts, normalize-speakable.ts, delivery-settings.ts, narration-script.ts, fish-s2-cues.ts, fish-cue-tagger.ts, narrator-suggestion.ts, narrator-recommendation.ts, ssml-pauses.ts, narration-pace.ts, eta.ts, section-size.ts
 audio-guard.ts, accent-prompt.ts, preview-text.ts, expressive-preview-cache.ts, voice-persona.ts, pcm-wav.ts, crossfade-audio.ts
 standard-voice.ts, curated-fish-stock.ts, fish-stock-twins.ts, fish-delivery-heat.ts, browser-speech.ts, edge-tts.ts
 clone-sample-audio.ts, clone-sample-quality.ts, clone-sample-quality-metrics.ts, clone-sample-quality-analyze.ts, fish-clone.ts, catalog/{allowlist,openrouter-catalog,voices.json,index}.ts
 providers/{openrouter,fish,edge,google,grok,gemini}.ts
 process-job.ts, stream-session.ts, concat-audio.ts, stream-finalize.ts, job-scratch.ts, mastering.ts, mastering-worker.ts, schema-migrate.ts
 section-index.ts, section-cache.ts, fish-slots.ts
src/lib/player/playback-speed.ts # Listen-time 0.8–1.5 cycle, default 1.15× (not Fish speed)
src/lib/player/seek.ts # ±10s skip clamp (not Fish speed)
src/components/player-speed-control.tsx # Cycle label + chevron rate list
src/worker/takehome-server.ts # Always-on Whole-book HTTP + drain loop
scripts/oracle/ # Always Free VM bootstrap (install-oracle.sh, pm2, smoke)
src/trigger/takehome.ts # Optional Trigger takehome.advance + takehome.drain
src/lib/jobs/dispatch-extract.ts # Worker / Vercel extract dispatch (not the VM)
workers/extract/ # Cloudflare Worker extract host
workers/takehome/Dockerfile # VM image (ffmpeg + deep-filter)
docker-compose.yml # Optional Docker path (pm2 is primary)
WORKER.md # Oracle Always Free + pm2 + Caddy (`worker.echomancer.xyz`) runbook
src/trigger/extract-upload.ts # upload.extract + upload.drain are no-ops (TTS stays on the VM)
trigger.config.ts
src/app/api/pdf/upload/          # JSON presign
src/app/api/pdf/upload/[id]/     # complete + poll
src/app/api/pdf/upload/[id]/narrator/ # DeepSeek stock suggestion on the cleaned book
src/app/api/pdf/upload/[id]/object/ # local PUT (dev/tests only)
src/app/api/text/upload/ # Paste-text intake (same content.txt ownership shape)
src/app/api/auth/[...nextauth]/ # Auth.js Google OAuth + CSRF
src/app/api/auth/logout/ # Sign out → fresh anon cookie
src/app/api/me/ # Signed-in chrome
src/app/api/tts/{voices,preview,live,clones,clones/upload}/
src/app/api/jobs/[id]/{stream,process,takehome,download,cancel,markup}/
src/app/api/cron/process-jobs/
src/app/dashboard/{voice,queue,player/[id]}/
src/test/{setup-env,harness}.ts # In-memory libSQL + temp storage
TECHNICAL_DESIGN.md # Update on relevant changes
```

## Env

```bash
# ── Identity (REQUIRED in production) ──────────────────
SESSION_SECRET=... # Signs session cookies; falls back to INTERNAL_JOB_SECRET
AUTH_SECRET=... # Optional; Auth.js reuses SESSION_SECRET when unset
AUTH_GOOGLE_ID=... # Google OAuth client id
AUTH_GOOGLE_SECRET=... # Google OAuth client secret
AUTH_URL=https://echomancer.xyz # Canonical origin for Auth.js callbacks

# ── TTS Providers ──────────────────────────────────────
OPENROUTER_API_KEY=... # Primary — leftover catalog + Whole-book cue tagger (Fish / Edge / Google; same key on the VM)
FISH_API_KEY=... # Required for Fish voice cloning + cloned-voice synthesis
# FISH_API_BASE_URL=https://api.fish.audio # optional override
# FISH_CUE_TAGGER_MODEL=deepseek/deepseek-v4.1-flash # cheap/fast default (not :free roulette); OpenRouter still pins provider.only to ["deepseek"]
# FISH_CUE_TAGGER_TIMEOUT_MS=40000 # max wait for the whole tagging pass (1s–120s)
# FISH_CUE_TAGGER=0 # disable Whole-book Fish S2 cue tagging
# LISTEN_PREP_MODEL=google/gemini-3.8-flash # Whole-book cleanup. minimal reasoning, strict json_schema, Google AI Studio then Vertex.
# LISTEN_PREP_FALLBACK_MODEL=deepseek/deepseek-v4.1-flash # Together then DeepInfra. Prose check stays on. Then the pre-pass result.
# LISTEN_PREP_CONCURRENCY=8 # parallel chunks per book, 1–32
# LISTEN_PREP_GLOBAL_CONCURRENCY=20 # requests in flight across books on the worker
# LISTEN_PREP_CHUNK_TIMEOUT_MS=20000 # per attempt, 1s–120s. One retry after ~2.5s on 429 or 5xx.
# FISH_TWIN_STANDARD=1 # ears gate passed vs Edge Andrew. Also set FISH_TWIN_STANDARD_REF. Default off (Edge).
# FISH_TWIN_STANDARD_REF= # 32-hex id from a private fast Fish clone of Edge Andrew. Invalid values are ignored.
# FISH_TWIN_MICHELLE=1 # same pair for Michelle (clone of Edge Michelle, not Clara).
# FISH_TWIN_MICHELLE_REF=
# FISH_TWIN_RANDOLPH=1 # same pair for Randolph (clone of Google en-GB-Neural2-O). Default off (Google).
# FISH_TWIN_RANDOLPH_REF=
# ECHO_OPERATOR_TOOLS=1 # production master switch for Fish markup. Off until set.
# ECHO_OPERATOR_USER_IDS=user_... # preferred. Durable ids (not the Google subject). Operator can read any job.
# ECHO_OPERATOR_EMAILS=you@gmail.com # only a verified Google email on users.email. Empty allowlist denies.
GOOGLE_TTS_API_KEY=... # Required for Randolph (Google Cloud TTS). Also used as a direct fallback.
GOOGLE_TTS_ACCESS_TOKEN=... # Alt to API key (OAuth). Either this or GOOGLE_TTS_API_KEY for Randolph.
GEMINI_API_KEY=... # Optional direct fallback (Gemini TTS)
GEMINI_TTS_MODEL=gemini-2.5-flash-tts
XAI_API_KEY=... # Optional direct fallback (Grok TTS)
XAI_TTS_URL=https://api.x.ai/v1/tts

# ── Premium HD gate ────────────────────────────────────
PREMIUM_HD_ENABLED=false # or true to enable for all
PREMIUM_HD_ALLOWLIST= # Comma-separated session ids / IPs

# ── MiniMax Free API (optional slim test catalog) ───────
# When both are set: catalog = Storyteller (default) + Gemini Kore only.
# See RESEARCH_PREVIEW.md
# MINIMAX_FREE_API_BASE_URL=http://127.0.0.1:8000
# MINIMAX_FREE_API_TOKEN=realUserID+_token

# ── Workers ────────────────────────────────────────────
INTERNAL_JOB_SECRET=... # Required — protects /api/jobs/[id]/process
CRON_SECRET=... # Required — protects /api/cron/process-jobs
TTS_SECTIONS_PER_TICK=6 # Max claim set size (capped by fan-out)
TTS_WORKER_WAVE_BUDGET_MS=240000 # Vercel fallback wave clock
TTS_TRIGGER_WAVE_BUDGET_MS=900000 # Trigger Cloud wave clock (minutes)
TTS_TAKEHOME_FANOUT= # Optional pin; default 4 if live Fish is in flight, else 5
TTS_CRON_JOBS_PER_RUN=3 # Fallback cron batch size
TTS_LEASE_TTL_SECONDS=90 # Lease lifetime between heartbeats
TTS_POLL_NUDGE_BUDGET_MS=0 # Production: polls are read-only. Do not synthesize on GET /api/jobs
TTS_MAX_TICKS_PER_WAVE=40
TTS_RETRY_BACKOFF_MS=1000
WORKER_URL=https://worker.echomancer.xyz # Vercel → Caddy on the Oracle VM
WORKER_SECRET=... # Shared with the VM (falls back to INTERNAL_JOB_SECRET)
# TAKEHOME_TRIGGER_FALLBACK=1 # Also fire **legacy** Trigger if the worker POST fails
TRIGGER_SECRET_KEY=... # Legacy fallback only when WORKER_URL is unset
TRIGGER_PROJECT_ID=proj_... # trigger.config.ts project ref (legacy only)
EXTRACT_WORKER_URL=https://echomancer-extract.<account>.workers.dev # Cloudflare extract host
EXTRACT_WORKER_SECRET=... # Bearer shared with the Worker; falls back to INTERNAL_JOB_SECRET
# TTS_MASTER_SKIP=1 # disable the second-pass remaster (the delivery encode still runs)
# TTS_MASTER_FULL_BOOK=1 # local opt-in (never on Vercel)
# TTS_MASTER_DFN=1 # opt-in DeepFilterNet3 (wet 0.4 unless TTS_MASTER_DFN_WET is set)
# TTS_MASTER_DFN_WET=0.4 # DFN wet mix; default 0 = ffmpeg-only remaster
# DEEP_FILTER_BIN=/usr/local/bin/deep-filter # set by install-oracle.sh / pm2
# FFMPEG_PATH=/usr/bin/ffmpeg # Ubuntu apt on the VM
# TTS_WHOLE_BOOK_DELIVERY_PREFIX is retired and ignored. Line-level cues replaced the seminar prefix.
# TTS_CONCAT_CROSSFADE_MS=120 # equal-power joins (80–150; 0 = hard concat, no edge trim)
# ECHOMANCER_SCRATCH_DIR= # default os.tmpdir()/echomancer; one dir per job, removed after upload
# ECHOMANCER_SCRATCH_MAX_AGE_HOURS=24 # startup + periodic sweep of stale scratch
# ECHOMANCER_SCRATCH_SWEEP_MS=900000 # sweep interval (minimum 60000)
# TTS_FINALIZE_TIMEOUT_MS=21600000 # stuck ffmpeg kill (default 6h)

# ── Uploads ────────────────────────────────────────────
MAX_UPLOAD_MB=512 # Server ceiling (R2 PUT; not the Vercel body cap)
NEXT_PUBLIC_MAX_UPLOAD_MB=512 # Same value, so the UI can state it

# ── Stream limits ──────────────────────────────────────
STREAM_MAX_AUDIO_SECONDS=3600
STREAM_CHARS_PER_MINUTE=900

# ── Pricing ────────────────────────────────────────────
TTS_PRICE_MARKUP=2.0
TTS_PRICE_FIXED_EUR=0.5
TTS_USD_TO_EUR=0.92
TTS_MIN_PRICE_EUR=1.99

# ── Turso (database) ───────────────────────────────────
TURSO_DATABASE_URL=... # Required
TURSO_AUTH_TOKEN=... # Required

# ── Cloudflare R2 (storage) ────────────────────────────
R2_ACCOUNT_ID=... # Required in production
R2_ACCESS_KEY_ID=... # Required in production
R2_SECRET_ACCESS_KEY=... # Required in production
R2_BUCKET_NAME=echomancer-audio
R2_PUBLIC_URL=... # Optional

# ── App ────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=https://your-domain.com
STORAGE_PATH=./data/storage # Dev only — ignored when R2 is configured
```

## Schema

`src/lib/tts/schema-migrate.ts` → `ensureTtsJobColumns()` runs on request paths
and is **additive only** (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`).
It owns `jobs`, `uploads`, `usage_logs`, `cloned_voices`, `clone_uploads`, `fish_inflight`. `migrate-turso.sql` is
the same schema for a fresh database and is also non-destructive — add new
columns to the `JOB_COLUMNS` list in `schema-migrate.ts`, not to the SQL file.

## Tests

`npm run test:run` — route handlers run for real against an in-memory libSQL
database and a temp storage directory; only the speech provider is faked
(`src/test/harness.ts`). Before finishing work, `npm run lint`,
`npm run typecheck`, `npm run test:run` and `npm run build` must all pass.

## Docs

- `TECHNICAL_DESIGN.md` — **code-level walkthrough** of every important module
  (update whenever architecture or product behavior changes)
- `RESEARCH_PREVIEW.md` — slim test catalog (MiniMax Free API + Gemini Kore)
- `FISH_VOICE_CLONING.md` — Fish Audio clone upload → private narrator flow
- `README.md` — overview
- `TURSO_R2_SETUP.md` — infra
- `DEPLOYMENT.md` — Vercel
