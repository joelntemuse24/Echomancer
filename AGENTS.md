# Echomancer v2 — Agent Guide

> Documents → audiobook. Shipped stock voices are **Andrew**
> (catalog id `standard`, Edge `en-US-AndrewNeural`), **Ava** (`en-US-AvaNeural`,
> not Dragon HD), **Libby** (Edge `en-GB-LibbyNeural`), and **Ryan**
> (Edge `en-GB-RyanNeural`). Clara and Michelle are unlisted and still
> resolve for books already made with them. A new request that names Clara
> uses Libby. One that names Randolph or Google uses Andrew. A book already
> stored as Randolph keeps its audio and is not spoken again. Do not add rejected
> Edge females (Jenny, Sonia, Aria) or Ava
> Dragon HD. **Fish voice cloning** stays on the direct Fish API
> (`FISH_API_KEY`). No self-hosted TTS, no webhooks.

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

Email sign-in is the second way in: a single-use link sent through Resend
(`RESEND_API_KEY` + `AUTH_EMAIL_FROM`; `src/lib/auth/email-login.ts`,
`/sign-in`, `/api/auth/email{,/verify}`). It lands on the same `user_*` as a
Google account with that verified address. Missing Resend env hides the option
and returns 503. See `TECHNICAL_DESIGN.md`.

## Who runs generation

**Whole book runs on an always-on VPS worker (pm2)**, not inside Vercel
isolates and **not** on Trigger.dev in production. Document extract runs
on that same Node process, in a child so it does not take a TTS slot.
Cloudflare `workers/extract` is only the fallback when the Node worker
is unreachable or unhealthy.

| Host | Entry | Role |
|------|-------|------|
| Always-on VM | `src/worker/takehome-server.ts` | Whole-book TTS in-process, document extract in a warm child (`POST /extract`). Binds `127.0.0.1:8788`. Caddy terminates HTTPS at `worker.echomancer.xyz`. See `WORKER.md`. |
| Trigger.dev (**legacy**) | `takehome.advance` | Fallback only when `WORKER_URL` is unset or `TAKEHOME_TRIGGER_FALLBACK=1`. Not the production Whole-book runner. `takehome.drain` has no schedule in this repo. The copy still deployed on Trigger is old and still claims `queued` rows every minute — turn that schedule off in the Trigger dashboard. |
| Cloudflare Worker | `workers/extract` | Extract fallback when the Node worker is unreachable or unhealthy. Same `runUploadExtract` pipeline. Free-plan CPU still kills a large PDF, so it is not the default. |
| Vercel | `POST /api/pdf/upload` | Presign only (tiny JSON). Browser PUTs to R2. **No file bytes, no extract.** |
| Vercel | `POST /api/pdf/upload/[id]` complete | HEAD + `POST $WORKER_URL/extract` for every document. Cloudflare if that POST fails, then Vercel (`inline` / `after()`), then fail. **Not Trigger.** `GET` and the player job poll share `advanceStuckExtract`: one attempt counter (4) and a 20-minute cap, message "This file took too long to read. Try again." |
| Vercel | `POST /api/jobs` / `…/takehome` / retry | Enqueue + `POST $WORKER_URL/jobs` — **no Fish** |
| Vercel | `GET /api/cron/process-jobs` | Operator fallback (`CRON_SECRET`) |
| Vercel | `POST /api/jobs/[id]/process` | Operator fallback (`INTERNAL_JOB_SECRET`) |

Live Listen and Live Stream stay on Vercel.

**Delivery cadence** (`resolveDeliverySettings`) applies to Whole book **and**
Live Stream / Live Listen: pauseStyle and title cleanup. Soft crossfade is
Whole-book concat only. Fish whole-book and Live Listen send the cleaned words with no
square-bracket cues. Headings sit on their own paragraph with ending
punctuation. A book's own `[brackets]` become parentheses before Fish
synthesis, because Fish treats `[..]` as direction. The published S2 cue
list stays so leftover tags are dropped, not spoken. Edge and Google
still insert `[break]` / `[long-break]` as silence, then map them
(Google SSML, Edge punctuation). Fish section audio uses cache variant
`fish-plain-v1` so an older cued take is not replayed. Picker previews
use the short one-liner (`PREVIEW_TEXT`). There is no book-level
`[conversational seminar tone]` prefix. Google maps
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
voices need no Fish key. A book already stored as Randolph plays and
downloads that audio. It is not synthesized again.

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

An Edge socket that stays quiet for 25s after it has opened, or past a cap
scaled to the section (45s–5min; a 4,000-character section is about 5min),
closes and throws `Edge TTS stalled`. `synthesizeSection` passes
`AbortSignal.timeout` on every attempt. Fish is budgeted at about 10
characters a second plus 60s, and that clock starts after the account slot
is acquired. Edge uses its stream cap plus 20s. Google Cloud TTS is not
synthesized. The lease heartbeat keeps renewing for a section's whole lifecycle — synth,
retries, mastering, upload, and the `segments_json` write — up to a cap of
every attempt budget plus three minutes for mastering. A batch that started
just before the wave budget still holds its lease while ffmpeg is running.
The heartbeat pauses once that cap has passed, so a stuck step lets go. On
worker shutdown, after the 30s idle wait, this process releases the leases
it still holds back to `queued`, matched to the lease token, so a lapsed
`processing` row is not what the legacy drain claims. After each wave, if
another take-home is `queued`, or `waiting` with an upload that is already
`ready` or `failed`, the run returns and the drain takes the oldest runnable
job. Sections already stored stay put. The VM stays on one
book at a time: Edge synthesis is network-bound, and ffmpeg mastering is
CPU-bound, so a second job would stack encodes.

## Empty audio

Providers sometimes answer HTTP 200 with a bare WAV header or zero-filled bytes.
`src/lib/tts/audio-guard.ts` → `isEmptyOrSilentAudio` is checked by **preview,
take-home sections, and stream windows**. Behaviour on silence: retry once
without accent direction (over-steered Gemini input is a known cause), then fail.
A stream never advances `stream_cursor` past a passage that was not narrated.

Fish clone sections do not run the squeak check unless `TTS_SQUEAK_CHECK=1`.
A labelled set of 20 excerpts, 10 of them spectral-detector hits, had 0 true
squeaks (0/10 true positives), so detection and the notch stay off. With the
flag, a whole section is still not re-spoken unless `TTS_SQUEAK_REGENERATE=1`.

## Stock providers (`src/lib/tts/`)

**Preferred: OpenRouter (one key, all speech models)**

| | |
|--|--|
| Env | `OPENROUTER_API_KEY` |
| Catalog | Live `GET openrouter.ai/api/v1/models?output_modalities=speech` → expand `supported_voices` |
| Synth | `POST openrouter.ai/api/v1/audio/speech` (OpenAI-compatible stream) |
| Code | `providers/openrouter.ts`, `catalog/openrouter-catalog.ts` |

Direct fallbacks (optional): gemini / grok with their own keys.
Google Cloud TTS is not used. A stored Randolph book plays its saved audio.

Catalog API: `GET /api/tts/voices` · `source: "openrouter" | "static" | "research"`

**Default slim catalog:** **Standard** (`standard` → `en-US-AndrewNeural`),
**Ava** (`ava` → `en-US-AvaNeural`), **Libby** (`libby` → Edge
`en-GB-LibbyNeural`), **Ryan** (`ryan` → Edge `en-GB-RyanNeural`) plus user
clones. No Gemini / MiniMax / rejected Edge
females (Jenny, Sonia, Aria) and no Ava Dragon HD. Clara and Michelle are
not listed. Customer UI shows those four names
only. Picker samples for those four are committed Edge recordings at
`public/voice-previews/<id>.mp3`, preloaded on the voice page. Re-record
them when `PREVIEW_TEXT` changes. Edge stock Live Listen / Whole book do not spend Fish. A stored Clara
job still needs `FISH_API_KEY` on the account that owns her reference.

**Andrew / Ava / Libby / Ryan (Edge TTS) caveats:** server synthesis talks to
Microsoft Edge’s undocumented Read Aloud websocket (`speech.platform.bing.com`,
same family as `edge-tts`). No Azure Speech key. Microsoft can change,
rate-limit, or block this path; if it dies, swap `src/lib/tts/providers/edge.ts`
for Azure or another adapter. Do not show raw Microsoft voice ids in customer
copy.

**Clara (curated Fish stock, unlisted):** `src/lib/tts/curated-fish-stock.ts`
still resolves her reference for a book already stored as Clara. New picks
and new job requests that name Clara use Libby. Synthesis for a stored Clara
job uses `fishTtsProvider` **with** `reference_id`. Do not send OpenRouter
catalog UUIDs.

**Stock suggestion:** when extract is ready, the voice page calls
`GET /api/pdf/upload/[id]/narrator` before it shows the Standard list. That
call is separate from Whole-book cue markup. Markup runs later, after a
voice is chosen. Cleanup starts when extract finishes and runs once
per upload. Each chunk returns a short note (kind, tone, point of view,
dialogue). The suggestion is the aggregate of those notes. It does not
send the book again. The matching
line is labeled in brackets: `Andrew (recommended)`. Articles, biography, and general
nonfiction preselect Andrew. History preselects Ryan. A novel may be
any stock voice. Clones are never suggested. The person
can always choose; a tap keeps their pick. The list waits at most a couple
of seconds for the reply, then shows anyway. A missing key or a bad reply
leaves the picker as it was. The list shows immediately. A short waiting
line fills the suggestion in when the notes are ready. The cleaned text and
a hash of the source are stored as `pdfs/<uploadId>/listen-cleaned.txt` and
`listen-prep.json`, including when nothing was dropped. A chunk that failed
or used the fallback model is retried on the next claim, up to three
attempts, and only those chunks are sent again. Freeze uses the best cleaned text for this source and does not
wait when that file exists. With nothing saved yet it waits for the
other pass (up to `LISTEN_PREP_PASS_WAIT_MS`, default 45s). If the tick
cannot fit a full model pass it requeues instead of freezing a skipped
or truncated clean, and it does not write a running record for that
skip. It does not persist raw text. The cleanup model may drop a paragraph or replace it with spoken wording (links, glued words, lists, symbols, mangled entities). A replacement that deletes more than a tenth of the paragraph's letters is discarded and the original is read, unless the paragraph is clutter. The listen-prep pre-pass drops
sequential page numbers, Gutenberg boilerplate, and an exact running
header that sits above or below a page number at least five times.
Digits are not stripped. A digit-stripped OCR match also drops
refrains and diary heads, so it is not used; Souls-style `POLK`/`FOLK`
heads stay for the model. PDF running heads
and page numbers are removed at extract time from pdf.js positions
(`pdf-furniture.ts`). A repeated edge line drops when it sits outside the
body block. Blank pages do not set that block, and tops that jitter by a
few points still count as one edge. A line inside the block stays, including
the extra last line of a longer page. Page numbers that share an offset drop
even when they sit one line below the text. Font size keeps a line
only when it is an outlier in its group. A bare or numbered chapter,
lecture, or letter heading stays unless that exact line repeats. Page
numbers follow the page offset even when the box is taller than the body
on that page. Roman folios use the same offset check.
Edge lines only are kept for the pass. EPUB guide hrefs are full paths
compared exactly. An empty fragment is ignored, and cover/nav files are
not put back when the filter matches nothing. Nested `toc`/`loi` sections
are removed, including `imprint`. Dedication and epigraph stay. A model drop that is
mostly contents rows (page-number or roman tail, dot leaders, or
Chapter/Part N) is kept through the body-sentence cap.

**Randolph:** removed from the picker and from synthesis. A saved pick or a
new request that names Randolph or Google Cloud TTS uses Andrew. A book
already stored as Randolph still plays and downloads. Those files are not
rewritten and are not spoken again. Do not show `en-GB-Neural2-O` in the picker.

**Fish voice cloning:** set `FISH_API_KEY` → upload a sample on `/dashboard/voice`
→ Fish trains a private `reference_id` → clone appears in the picker (`clone:<uuid>`,
provider `fish`). Synthesis for clones uses the **direct Fish API** (not OpenRouter),
because private reference ids are account-scoped. Samples presign → PUT R2
→ `POST /api/tts/clones` `{ uploadId }` (never a fat Vercel body). See
`POST /api/tts/clones/upload`.

**Voice from YouTube:** on the Clone screen, paste a link or type a search.
Results stay on the page. An official IFrame player plus a 10–40s range
previews the stretch. The default range is 20 seconds. The two handles sit on a
scrolling timeline, so a long video does not stack them on one point. Dragging
a handle moves only that edge and stops at 10 or 40 seconds. Dragging the span
moves the window and keeps the length. On a source of 30 minutes or more, Fine
tune stays under that timeline. On a shorter source it appears at the first
touch of the timeline and then stays for the rest of that screen. One step
moves the start or the end by one second, and it stops at 10 seconds, 40
seconds, and the ends of the video. A held step stops when that edge cannot
move. The label is one line, the clock span
and "40s max". The label, the clip request, and the worker all use those whole
seconds, and they stop at 40. A new clone is named from the video title (a leading name such
as "Henry Kissinger") or from the uploaded file name, and the list shows
that name without an accent. Accent stays on the stored row and defaults
to American; there is no accent picker. "Use this clip" is
the same on mobile and desktop: it queues the server clip. There is no tab
share and no microphone step. The button says "Fetching the clip", then
"Preparing the voice", with a thin bar that stays short of full until the
clone is ready. Fish `enhance_audio_quality` stays on. A YouTube clip also
sends a nova-3 transcript when that call returns within 3 seconds. An email
in `YT_SERVER_CLIPS_EMAILS` can queue `POST /api/clips`. The queue-time
`videos.list` call also stores the source length on the row
(`youtube_clips.video_seconds`), and the worker picks the Apify actor from
it (`APIFY_TOKEN` on the worker only, never logged). Sources of 30 minutes
or more (`CLIP_SEGMENT_SOURCE_SEC`) go to the segment actor
`entertained_rattlesnake/youtube-audio-segment-downloader` first
(`{ videos: [url], format: "wav", startTime, endTime, transcribe: false }`,
`maxTotalChargeUsd` $0.15); shorter ones go to `utils/youtube-link`
(`{ videos: [{ url, timeframe, audioQuality: "best" }] }`, original
container, `maxTotalChargeUsd` $0.05). A classified failure — bot check,
sabr-gapped, timeout, empty or invalid file, wrong duration, or a file past
the 16 MiB cap — falls back to the other actor once; a 402 budget stop does
not. Each attempt has its own wall clock (90s; 180s for the link actor on a
long source), aborts its run on timeout, and logs actor, reason, and
timings. The segment actor reports SUCCEEDED even when the video failed:
its audio and `FAILED_<videoId>.json` live in the run's key-value store, not
the dataset, and a 40 s WAV is ~7.7 MB. An empty dataset with no status
message is classified from the run log. Age, sign-in, bot-check, and
"no usable connections" are restricted and are not retried.
`audio-download-failed` and `sabr-gapped` are transient and retry once.
Clip length is the downloaded file (ffprobe), because the dataset
`duration` is the whole video. Once the run succeeds, the audio download
starts without waiting for the charge; `usageTotalUsd` is read beside it
(or the charge events: `AUDIO_DOWNLOADED` $0.015 plus `AUDIO_LONG_EXTRA`
$0.004 per 10-minute block; `video-started` $0.05 plus
`audio-minute-processed` $0.04 per started minute). A successful download
records at least the floor ($0.015 link, $0.09 segment) when the charge has
not settled. A missing or blocked video fails at no charge. Someone who
cannot use the server clip uploads a file instead. Search uses YouTube Data API v3 (`YOUTUBE_API_KEY`)
and requires a signed-in `user_*`. An anonymous session is rejected, so a
cookieless request cannot spend quota. `search.list` (`part=snippet`, 100
units) supplies the title, channel, and thumbnail. `videos.list` asks only
for `contentDetails` (1 unit) to read the duration. The same query is cached
for 10 minutes in `youtube_search_cache`. The route still allows 8 searches
per 10 minutes. A pasted link still opens the player when the person is
signed out or the key is missing. YouTube clones store the URL, range, and
consent time, stay private, and are not shareable.

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

1. `POST /api/jobs` `{ mode: "stock", jobKind: "takehome", catalogVoiceId, pdfStoragePath }` → `queued` when the text is ready, or `waiting` while the upload is still `uploaded` or `extracting`. The path is owner-checked with `getOwnedUploadByPath` (`pending` and streams stay `TEXT_NOT_READY`). A second tap for the same book and voice returns that live job, including one parked `waiting`. Make audiobook opens the player, which shows "Reading your book" and calls `advanceStuckExtract` while it waits. The worker claims `waiting`, returns `deferred` on the first tick (the TTS slot is released, the drain cadence picks it up again), and adopts the upload's failure message if the read failed. `waiting` is not `queued` or `processing`, so the old Trigger `takehome.drain` claim does not match it. When a read finishes — the VM extract hook, Vercel `extractUploadedDocument`, a stall fail, and the Cloudflare Worker — that upload's `waiting` take-homes become `queued`, or `failed` with the upload's message, and the VM hook wakes the drain. A `waiting` job whose file is already `ready` or `failed` also counts as runnable, so a book created while its file was still being read gets a turn at the next wave even if that handoff was missed. The drain already claims `waiting`.
2. Worker claims the lease and synthesizes a batch per tick, many ticks per invocation. Edge and Google pack toward `ceil(chars / 8)` per section (floor 1,500, cap the voice max — 4,000 for Standard), breaking on a paragraph or sentence. The first section is about 800 characters for every provider, including Fish, and it ends on a sentence. A heading does not close a section until it holds about 1,500 characters; a shorter chapter stays a marker inside the section, and finalize times it from that text offset. They run up to 8 sections at once (`TTS_EDGE_GOOGLE_SECTION_CONCURRENCY`, default 8). `TTS_SECTIONS_PER_TICK=8` is what lets that claim through. Fish and clones stay on the account cap (4, or 5 when nothing live is in flight) even when the tick is 8. A Fish book whose pack leaves a short tail after a multiple of 5 folds that tail into the previous section when it is the same chapter and still under the hard max. A 429 or 503 from Edge or Google halves how many of those sections stay in flight; the section still retries with `TTS_RETRY_BACKOFF_MS`. Each finished section is checked while the rest of the wave continues. The worker's `OPENROUTER_API_KEY` sends the section to OpenRouter `deepgram/nova-3`. That speech-to-text endpoint ignores provider order and price-routes `openai/whisper-large-v3-turbo` to DeepInfra, which transcribes a full section at about realtime. Nova-3 is hosted only by Deepgram. The whole check, including the duration read, is capped at 5 seconds of wall clock (`ms=` is that wait). The transcript request runs on a worker thread, so `AbortSignal.timeout` cancels it even when this thread is busy. `TTS_SECTION_QA_ENABLED=0` skips the check even when a key is set. Duration is read from the MP3 or WAV bytes in process. A repeated or missing run of 6+ words, word error over 15%, or duration more than 25% off the calibrated characters-per-second rate regenerates that section once, then splits at the nearest sentence and keeps the lower-error take. A transcript error, or a wait past the cap, keeps the audio and does not stop the book. Without the key the worker logs `qa skipped: no provider` once and finishes the book. One log line per checked section.
3. Progress lands in `segments_json` / `next_section_index`; the job returns to `queued` between waves
4. Each section is mastered as soon as it is synthesized (same chain: high-pass, low-mid cut, presence, light de-ess, loudnorm −16 LUFS / −1.5 dBTP, 44.1 kHz mono 128 kbps). Loudnorm is measured, then applied. ffmpeg and ffprobe for that pass are asynchronous, and ffmpeg in flight is capped at the CPU count, so one section's master does not freeze the other sections' QA. True peak at −1.5 keeps a short, peaky take a little under −16; it is not run through loudnorm again. Finish downloads the mastered sections together and packet-copies them. The splice search stops once a frame is comfortably quiet, and those short ffmpeg calls are not held behind the section-master CPU cap. The crossfade is a short re-encode of the join window (under about two seconds), not a second pass over the book. The splice is kept when its sample step matches the audio beside it. A consonant in the window is not a click. A bad frame is skipped. A section that skipped the pass, or a mix with older unmastered sections, still uses the full-book encode. If every section was already mastered and the join still fails, finish crossfades and encodes without running loudnorm again. Frame positions come from the MP3 headers, so a long book does not start one ffprobe per section. A section under four seconds is re-encoded with the same crossfade into its neighbor (the rest of that neighbor stays a packet copy), so one heading does not send the book through the full encode. The fallback encode is limited to the decoded audio, and an upload that already landed is not marked failed when the lease has moved on. DeepFilter opt-in stays on the full encode (`TTS_SECTION_MASTER=0` forces it).
5. Frontend polls and can play ready sections early

## Job flow (stream)

1. `POST /api/jobs` `{ mode: "stock", jobKind: "stream", catalogVoiceId, ... }`
2. Player opens `GET /api/jobs/[id]/stream` — pipes provider audio, one reader at a time. Live Stream does not drop a leading copyright page, so `stream_cursor` stays an offset into the unstripped text
3. Capped by `STREAM_MAX_AUDIO_SECONDS` / character budget
4. Optional `POST /api/jobs/[id]/takehome` for a full offline copy

## Chapters

`pdfs/<uploadId>/chapters.json` is the one source of truth, written at
extraction (and by text / pasted-link uploads). EPUB reads the NCX / nav TOC
(label = display title, target's first paragraph or `#fragment` text =
alignment anchor, so class-based headings still get their real names); PDF
reads the outline; DOCX reads heading styles, Title/Subtitle, or a run of
short bold lines; everything else falls back to rule-based heading lines.
A printed contents page near the front is the next source when the outline
or nav matches under half its entries: part labels become the display title
(`Part One`), the quoted title and era are an optional `subtitle`, and topic
lines are `children` (`level: 2`) only when a printed page number maps
through the part offset, or the topic's two rarest distinctive words
cluster once inside that part (within about twelve words, and one of them
is specific). A quoted contents line is a topic. Anything else is dropped. Outline, EPUB nav, and DOCX levels nest the same way
(chapters under parts). Heading-line books stay a flat list. Printed-toc
children are display positions and are not TTS section breaks. Detection
runs before title-casing; ALL-CAPS titles title-case with Roman
numerals kept; titles cap at 120 chars; a label repeated under different
Books / Parts is prefixed (`Book One · Chapter I`); a dense Contents run of
5+ bare labels with no text between is dropped whole. An outline matching
under half its entries yields to the printed contents page, then to the
body's own heading lines; one giant title is ignored. A low-confidence
heading list may be narrowed by the listen-prep model, which may only return
indexes of existing candidates. `scripts/rechapter-takehome.ts` rewrites
`playback-chapters.json`, `section-starts.json`, and the upload
`chapters.json` for a finished job and does not resynthesize. The LLM cleanup never drops a chapter heading line
(`protectedHeadings` in the listen-prep record; an unprotected clean is
re-run). At freeze the outline's `match` lines are the chapter markers when
at least half align, and the stored display titles replace the source lines.
A heading closes the open section only once that section holds about 1,500
characters. Title-page scraps, ISBN, edition, copyright, Library of Congress,
and publisher lines, and one- or two-word or mid-phrase fragments, are not
chapters. A leading copyright page is skipped unless `TTS_SKIP_FRONT_MATTER=0`.
Finalize measures the assembled audio and writes `playback-chapters.json`
with real `startSeconds` / `endSeconds` (the job route prefers it; the old
char-fraction path is the fallback) and muxes the chapters into the download
as ID3v2.3 CHAP frames via ffmetadata (`-c copy`, no extra encode). A book
with no real chapters keeps the numbered Section list — names are never
invented.

## Deleting a job

The `pdfs/<uploadId>/` folder is **shared** — a chapter preview and a full book
are separate jobs over one upload. `DELETE /api/jobs/[id]` removes
`audiobooks/<jobId>/` eagerly but only removes the upload folder when no
non-deleted sibling job still references it.

## Key paths

```
src/proxy.ts # Issues the session cookie
src/lib/auth/{session,guard,google,authjs,identity,actions,sign-out}.ts # Identity + Google + ownership
src/lib/jobs/{serialize,worker-auth,takehome-dispatch,takehome-worker-client,trigger-api,trigger-takehome,trigger-secrets}.ts
src/lib/turso/{jobs,uploads,cloned-voices,clone-uploads}.ts
src/lib/rate-limit.ts # Fail-open vs fail-closed limiters
src/lib/document-formats.ts # Accepted types + upload ceiling (client-safe)
src/lib/clone-sample-formats.ts # Clone sample types + 32 MB ceiling (client-safe)
src/lib/uploads/{extract,http,rate-limit,chapters-store}.ts
src/lib/book-chapters.ts # chapters.json: detection, alignment, display titles
src/lib/upload-client.ts # Book + clone-sample presign → PUT storage
src/lib/tts/
 types.ts, pricing.ts, premium.ts, split-text.ts, speakable-text.ts, normalize-speakable.ts, delivery-settings.ts, narration-script.ts, fish-s2-cues.ts, narrator-suggestion.ts, narrator-recommendation.ts, ssml-pauses.ts, narration-pace.ts, eta.ts, section-size.ts
 audio-guard.ts, accent-prompt.ts, preview-text.ts, voice-persona.ts, pcm-wav.ts, crossfade-audio.ts
 standard-voice.ts, curated-fish-stock.ts, browser-speech.ts, edge-tts.ts
 clone-sample-audio.ts, clone-sample-quality.ts, clone-sample-quality-metrics.ts, clone-sample-quality-analyze.ts, fish-clone.ts, reference-quality/{config,dsp,score,models,check,client,remaster}.ts, catalog/{allowlist,openrouter-catalog,voices.json,index}.ts
 providers/{openrouter,fish,edge,google,grok,gemini}.ts
 process-job.ts, stream-session.ts, concat-audio.ts, stream-finalize.ts, job-scratch.ts, mastering.ts, mastering-worker.ts, schema-migrate.ts
 section-index.ts, section-cache.ts, fish-slots.ts, id3-chapters.ts
src/lib/player/playback-chapters.ts # Player chapter list + measured timestamps
src/lib/player/playback-speed.ts # Listen-time 0.8–1.5 cycle, default 1.15× (not Fish speed)
src/lib/player/seek.ts # ±10s skip clamp + fine-tune window/grid (not Fish speed)
src/components/player-seek-group.tsx # Seek bar + permanent Fine tune slider
src/components/player-speed-control.tsx # Cycle label + chevron rate list
src/worker/takehome-server.ts # Always-on Whole-book HTTP + drain loop + POST /extract
scripts/oracle/ # VPS worker bootstrap (install-oracle.sh, pm2, smoke)
src/trigger/takehome.ts # Optional Trigger takehome.advance + takehome.drain
src/lib/jobs/dispatch-extract.ts # Worker / Vercel extract dispatch (not the VM)
workers/extract/ # Cloudflare Worker extract host
workers/takehome/Dockerfile # VM image (ffmpeg + deep-filter)
docker-compose.yml # Optional Docker path (pm2 is primary)
WORKER.md # VPS + pm2 + Caddy (`worker.echomancer.xyz`) runbook
src/trigger/extract-upload.ts # upload.extract + upload.drain are no-ops (TTS stays on the VM)
trigger.config.ts
src/app/api/pdf/upload/          # JSON presign
src/app/api/pdf/upload/[id]/     # complete + poll
src/app/api/pdf/upload/[id]/narrator/ # DeepSeek stock suggestion on the cleaned book
src/app/api/pdf/upload/[id]/object/ # local PUT (dev/tests only)
src/app/api/text/upload/ # Paste text or a public URL (same content.txt ownership shape)
src/app/api/auth/[...nextauth]/ # Auth.js Google OAuth + CSRF
src/app/api/auth/logout/ # Sign out → fresh anon cookie
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
AUTH_URL=https://echomancer.xyz # Canonical origin for Auth.js callbacks and emailed sign-in links
RESEND_API_KEY=... # Optional: email sign-in links. Needs AUTH_EMAIL_FROM too.
AUTH_EMAIL_FROM=... # e.g. Echomancer <login@echomancer.xyz> (domain verified in Resend)

# ── TTS Providers ──────────────────────────────────────
OPENROUTER_API_KEY=... # Leftover catalog, listen-prep fallback, and section transcript QA (same key on the VM)
FISH_API_KEY=... # Required for Fish voice cloning + cloned-voice synthesis
# FISH_API_BASE_URL=https://api.fish.audio # optional override
# YOUTUBE_API_KEY=... # Data API v3 search on the Clone screen (Vercel). Signed-in users only. search.list is 100 quota units; videos.list is durations only. Not used to download audio.
# YT_SERVER_CLIPS_EMAILS=you@gmail.com # Allowlist for server-side YouTube sections. APIFY_TOKEN stays on the worker only.
# LISTEN_PREP_MODEL=xiaomi/mimo-v2.6-flash # Whole-book cleanup. Reasoning off for xiaomi/* (MiMo ignores minimal and spends the output budget). Strict json_schema. Provider order DeepInfra, Xiaomi, GMICloud; fallbacks off so Novita is not used.
# LISTEN_PREP_REASONING=off # off | minimal. Default off for xiaomi/*, minimal for other primary models. The DeepSeek fallback stays off.
# LISTEN_PREP_FALLBACK_MODEL=deepseek/deepseek-v4.1-flash # Together then DeepInfra. Prose check stays on. Then the pre-pass result.
# LISTEN_PREP_CONCURRENCY=8 # parallel chunks per book, 1–32
# LISTEN_PREP_GLOBAL_CONCURRENCY=20 # requests in flight across books on the worker
# LISTEN_PREP_CHUNK_TIMEOUT_MS=20000 # per attempt, 1s–120s. One retry after ~2.5s on 429 or 5xx.
# ECHO_OPERATOR_TOOLS=1 # production master switch for Fish markup. Off until set.
# ECHO_OPERATOR_USER_IDS=user_... # preferred. Durable ids (not the Google subject). Operator can read any job.
# ECHO_OPERATOR_EMAILS=you@gmail.com # only a verified Google email on users.email. Empty allowlist denies.
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
TTS_SECTIONS_PER_TICK=8 # Max claim set. Edge/Google use it up to 8. Fish stays at 5.
TTS_EDGE_GOOGLE_SECTION_CONCURRENCY=8 # Edge/Google sections in flight. 1–8. Fish ignores this.
# TTS_SECTION_QA_ENABLED=0 # skips section transcript QA even when OPENROUTER_API_KEY is set (`qa skipped: disabled`). No key logs `qa skipped: no provider`.
# TTS_SKIP_FRONT_MATTER=0 # Read a leading copyright / ISBN / Library of Congress page. Unset: those notice lines are left out of narration.
# REFERENCE_QUALITY_GATE=0 # Vercel kill switch. Unset: worker POST /reference-quality scores the clone sample. 0 skips the gate (cloning proceeds).
TTS_WORKER_WAVE_BUDGET_MS=240000 # Vercel fallback wave clock
TTS_TRIGGER_WAVE_BUDGET_MS=900000 # Trigger Cloud wave clock (minutes)
TTS_TAKEHOME_FANOUT= # Optional pin; default 4 if live Fish is in flight, else 5
TTS_CRON_JOBS_PER_RUN=3 # Fallback cron batch size
TTS_LEASE_TTL_SECONDS=90 # Lease lifetime between heartbeats
TTS_POLL_NUDGE_BUDGET_MS=0 # Production: polls are read-only. Do not synthesize on GET /api/jobs
TTS_MAX_TICKS_PER_WAVE=40
TTS_RETRY_BACKOFF_MS=1000
WORKER_URL=https://worker.echomancer.xyz # Vercel → Caddy on the VPS
WORKER_SECRET=... # Shared with the VM (falls back to INTERNAL_JOB_SECRET)
# TAKEHOME_TRIGGER_FALLBACK=1 # Also fire **legacy** Trigger if the worker POST fails
TRIGGER_SECRET_KEY=... # Legacy fallback only when WORKER_URL is unset
TRIGGER_PROJECT_ID=proj_... # trigger.config.ts project ref (legacy only)
EXTRACT_WORKER_URL=https://echomancer-extract.<account>.workers.dev # Fallback only, when WORKER_URL is down
EXTRACT_WORKER_SECRET=... # Bearer shared with the Worker; falls back to INTERNAL_JOB_SECRET
# EXTRACT_NODE_CONCURRENCY=1 # Warm extract children on the VM. Separate from WORKER_CONCURRENCY. 1–4.
# EXTRACT_NODE_HANDOFF_SECONDS=75 # Cloudflare fallback with no content → Node if it has not already had two attempts, else Vercel
# EXTRACT_CF_RESEND_SECONDS=45 # One Cloudflare re-send before that handoff
# EXTRACT_NODE_HEARTBEAT_STALE_SECONDS=180 # No Node heartbeat → retry once, then Cloudflare, then Vercel
# EXTRACT_NODE_HARD_CAP_SECONDS=1200 # Wall clock from the first accept
# EXTRACT_MAX_ATTEMPTS=4 # One counter across Node, Cloudflare, and Vercel
# EXTRACT_CHILD_MEMORY_MB= # Optional V8 old-space cap for the extract child. Parent heap flags are always kept.
# EXTRACT_CHILD_RECYCLE_MB=1024 # Replace a warm child after a read that leaves the heap this high
# EXTRACT_CHILD_TIMEOUT_MS=600000 # Kill a warm child that has not finished one extract. The upload then follows the stall path.
# TTS_MASTER_SKIP=1 # disable the second-pass remaster (the delivery encode still runs)
# TTS_SECTION_MASTER=0 # finish the book with the full loudnorm encode (rollback)
# TTS_MASTER_FULL_BOOK=1 # local opt-in (never on Vercel)
# TTS_MASTER_DFN=1 # opt-in DeepFilterNet3 (wet 0.4 unless TTS_MASTER_DFN_WET is set)
# TTS_MASTER_DFN_WET=0.4 # DFN wet mix; default 0 = ffmpeg-only remaster
# DEEP_FILTER_BIN=/usr/local/bin/deep-filter # set by install-oracle.sh / pm2
# FFMPEG_PATH=/usr/bin/ffmpeg # Ubuntu apt on the VM
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
