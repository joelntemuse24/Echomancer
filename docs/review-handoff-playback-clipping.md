# Reviewer handoff: playback, YouTube clipping, and audio reliability

## User goal and review mandate

The user requested a smoother and faster frontend, improved sound quality where justified, and special attention to YouTube clipping, chapters, and transcript follow-along. After the audit they authorized implementation of all fixes, specifically requesting scrutiny of database/storage impact, scalability, VM performance, additional access requirements, and explicit UI/reliability/code-quality tradeoffs.

The user has now requested a PR for an agent with stronger production access. Review this as a draft implementation requiring independent assessment and live validation. Synchronized reading remains a requirement. The current stream fallback is temporary; the user explicitly challenged any suggestion that synchronization is impossible or that the feature should be abandoned.

## Architecture and access context

Read AGENTS.md, TECHNICAL_DESIGN.md, WORKER.md, and docs/playback-clipping-reliability.md before changing behavior. Next.js runs on Vercel; whole-book generation and document extraction run on an always-on Node VM. Turso stores identity/jobs/leases; R2 stores uploaded documents and audio. Ownership checks precede presigning. Fish clone creation is direct and paid; stock Edge voices and existing output must retain their current behavior.

The author had GitHub administrator permissions, local Windows/Edge, FFmpeg/FFprobe, and source access. Production secrets, SSH target/access, signed-in allowlisted browser state, and live Turso/R2 access were not established. No production deployment, migration, stored-book rewrite, or VM restart was performed. Browser tests use local real components/page logic with mocked API/media/provider boundaries. No subjective listening or live paid clone completion was validated.

## Audit triggers and implemented changes

1. The player switched section files to full.mp3 using section-count fractions despite unequal durations. It now waits for measured timing and preserves local position; missing timing retains section playback with bounded retries and a notice.
2. Transcript seeks applied whole-book fractions to a section file when timing was incomplete. Destination metadata and section-relative coordinates now drive the jump.
3. Opening a transcript during generation permanently cached early text/timing; failure cached an empty document. A revision-keyed shared resource now refreshes on section/finalization state, deduplicates requests, bounds retries, and exposes retry.
4. Stream highlighting used stream_cursor, which records delivered text and advances ahead of buffered or paused audio. This draft disables that misleading highlight and labels stream text unsynchronized. Completing synchronized playback is still open (below).
5. Transcript passage actions now have keyboard controls; manual wheel/keyboard reading persistently pauses following. Chapter preparation is cached separately from playhead changes, transcript lookups are indexed, and at most 80 passages mount.
6. YouTube selection now honors URL timestamps, supports editable clocks and current video position, provides explicit selection playback, seeks on committed gestures, sizes iframe controls to the container, and recovers player-load errors.
7. Clip tracking persists ID/opaque owner context/start time, backs off polling, pauses hidden tabs, and bounds requests/waiting. Authorized status returns context/title/source/sample/quality. Owner context uses an HMAC, and responses are private/no-store.
8. Clip processing now has expiring token leases, heartbeats, conditioned writes, bounded attempts, saved-WAV recovery and recorded cost checkpoints. Paid creation is marked immediately before Fish, after quality checks. Ambiguous creation stops as provider_uncertain and never repeats automatically.
9. Risk acceptance atomically queues a failed risky_audio clip. The direct clone route rejects clip-backed uploads, closing a duplicate-paid-create bypass found in independent review.
10. Extraction now rejects unknown duration or a deviation over one second, and mastering caps to requested duration. Correct source start still needs provider spot-checking.
11. Basic sample duration/insufficient-speech checks block unusable audio. Echo/clipping/level estimates warn so the calibrated reference gate can make the risk decision. This preserves the existing fail-open behavior when the worker check is unavailable.
12. QA regeneration shares a deadline with rechecks/assembly, and each additional synthesis has one attempt. Split containers use bounded FFmpeg assembly instead of byte concatenation. Mixed books master missing sections without repeating the chain on mastered sections.
13. Splice search tries the first candidate before expanding: immediately passing boundaries use three search FFmpeg launches instead of nine. Concurrency/thresholds stay unchanged. AI chaptering respects the remaining caller budget with save headroom.
14. Browser harness dependencies/configuration and regression tests were added; technical documentation records resource and rollout implications.

## Synchronized reading: required next assessment

Synchronization is feasible. The missing piece in this draft is a trustworthy mapping from the media playback timeline to narrated text. Delivery cursor and poll time cannot supply it because buffering, pause, reconnect, and playback speed separate delivery from listening.

Review these options against the actual providers and live streams:

- Provider-native word/sentence boundary events, when available. Edge Read Aloud can expose metadata; verify what the current adapter requests/receives. Fish alignment capabilities need checking against the deployed provider API.
- A compact per-window manifest containing source text offsets, measured audio duration, session start/resume cursor, and cumulative playable time. The player maps audio.currentTime to those windows; within-window sentence estimates can provide approximate follow-along while precise alignment is unavailable.
- For accurate finished-book sentence/word highlighting, align the frozen narrated text against generated audio once per section. Reuse suitable QA transcript timestamps when supported, or run a bounded background forced-alignment pass. Validate cleaned-text offsets, normalization, punctuation, numbers, headings, and join trim/encoder delay.

The streamed audio body currently carries bytes directly, so timing metadata needs a deliberate transport: a small owner-authorized manifest/side channel or a compatible segmented playback design. Choose based on latency and browser support. Do not casually replace the stream with a heavyweight playback architecture. Persist sparse immutable timing metadata beside existing audio and avoid word-level database writes or retranscribing a whole book on every open.

The reviewer should either complete a measured-clock stream mapping in this PR or explicitly propose an actionable follow-up before merge. The unsynchronized fallback does not fulfill the user's final synchronization goal. Keep the fallback as the error state when reliable timing is unavailable.

Acceptance checks: pause leaves highlight stationary; buffering never jumps ahead; 0.8–1.5x playback follows media time; reconnect maps the resumed text origin; seeks and chapter jumps map both directions; partial-to-full handoff preserves passage; cleaned speech and original text offsets agree. Compare actual audio to visible sentences on representative stock and cloned voices. Measure alignment CPU/RAM/time, extra provider cost, first-audio latency, and metadata size.

## Independent review priorities

- DB migration: additive clip columns, legacy running rows, indexed queue/recovery queries, leases across two worker processes, expiry during storage/provider calls, and token-conditioned late writes. Two-attempt limit versus risk acceptance after an earlier recovery deserves explicit checking.
- Paid-provider safety: concurrent queue/direct requests, risk acceptance, request abort after Fish accepts, failure between remote model creation and local row insert, and operator reconciliation for provider_uncertain. No remote exactly-once guarantee is claimed.
- Ownership: session changes while responses are in flight, restored session storage, sign-out/focus handling, signed sample URLs, source/quality visibility, and direct clone rejection.
- Storage: checkpoint reuse, no duplicate permanent raw books, scratch cleanup after abort, signed URL expiry, and sample/reference retention/deletion behavior.
- Resource limits: one-book and one-clip-per-process behavior, CPU semaphore contention with extraction/reference quality, total QA deadlines, cancellation of underlying operations after races/timeouts, and VM shutdown behavior.
- Audio: decoded final duration, true peak/loudness, actual clip start/end correctness, quiet consonants at trims, join clicks/padding, mixed mastering, and clone likeness. Existing fixed EQ/bitrate defaults were retained pending listening.
- Frontend: production Next styles and real YouTube controls on phones; long transcript pagination usability; chapter and library/voice/player coherence after clone completion; pending-job recovery in background tabs.
- Code coherence: small helper boundaries and duplicate timeout/ownership logic, explicit bundler dependency lockfile churn, test harness isolation, and avoiding excessive polling or revision invalidation.

## Tradeoffs needing reviewer judgment

- 80-passage pagination bounds DOM work but changes continuous manual reading. A measured variable-height virtual list could improve continuity with more complexity.
- Conservative provider_uncertain handling avoids duplicate spend but requires a recovery procedure/operator access.
- Acoustic warnings allow more samples to reach the calibrated gate; worker unavailability still permits cloning. Verify this policy with representative poor samples and user-facing copy.
- One-second extraction tolerance may reject legitimate provider trim/codec behavior; validate real actor output before changing the tolerance.
- The strict 12 x 60-second speed benchmark timed out on this Windows host, with an observed pre-optimization copy join slower than full encode. The long benchmark is now opt-in; smaller loudness/duration/click correctness tests remain default. This is explicit benchmark separation, not evidence of a production speedup.

## Validation completed locally

- npm run lint: passed.
- npm run typecheck: passed.
- npm run build: passed.
- npm run test:run -- --maxWorkers=1 --testTimeout=30000: 154 files passed, 1,474 tests passed, two skipped (including opt-in benchmark).
- 32 desktop/mobile clip-slider and player-seek browser tests passed.
- Six desktop/mobile picker tests passed, including restored risk acceptance.
- Six player/transcript browser tests passed, including real-page unequal-section handoff, finalization refresh, retry, keyboard actions and follow suspension.
- git diff --check passed.

Reproduce browser checks with PLAYWRIGHT_CHANNEL=msedge on Windows, or an installed Chromium channel elsewhere. Run picker tests using e2e/youtube-clip-picker.config.mjs and transcript tests using e2e/transcript.config.mjs. Run TTS_JOIN_BENCHMARK=1 on an idle production-like Linux host; retain its speed assertion and report CPU/RAM/process counts.

## Rollout and access required

Use an allowlisted signed-in account for actual YouTube search/clip/quality acceptance and clone adoption. Confirm VM SSH deployment target, worker environment, Turso/R2 configuration, Vercel project access, and provider dashboard access for uncertain model reconciliation. Use protected secret injection; do not put credentials in this PR or logs.

App and worker changes share queue/status/owner-context contracts. Review deployment order and compatibility before rollout, apply additive migrations through the established path, drain/observe active work, and validate restart recovery without duplicating paid work. Existing stored audiobooks should play/download unchanged. Deployment and shared-data changes require the user's approval; the current request authorizes publishing this draft PR for review.
