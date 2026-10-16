# Playback and clipping reliability

This change preserves the existing storage ownership model, stock voices, and VM concurrency limits.

## Playback and transcript

The player keeps section-local position until finalized measured section starts are available. A shared transcript resource deduplicates requests by generation revision. Opening text during generation refreshes it when section state or finalization changes; failed requests have bounded retries and an explicit retry action. There is no independent recurring transcript poll.

Chapter rows are prepared when chapters or duration change, and the playhead selects from that structure. Transcript lookup uses indexed section/block clocks. The transcript mounts at most 80 passages and offers previous/next passage navigation. This bounds DOM cost at the price of paginated manual reading. Keyboard-operable passage controls preserve heading semantics. Wheel and keyboard navigation suspend follow mode until explicitly resumed.

Live streams currently expose a delivery cursor without a timed audio-to-text map. Their text is explicitly unsynchronized, with no moving highlight or passage seeking. This is an interim accuracy safeguard; synchronized reading remains a product requirement. Within generated sections, sentence timing remains estimated. The implementation does not yet supply reliable stream alignment. See [the reviewer handoff](review-handoff-playback-clipping.md) for candidate timing sources, resource constraints, and acceptance checks before treating synchronized reading as complete.

## YouTube selection and recovery

The picker honors timestamp links, accepts editable clocks, can use the player's current position, and provides explicit selection playback. Dragging changes the range immediately and seeks only when committed. Native player controls render at container size. Script/player load failures expose retry and a source link.

Pending clip recovery stores only the clip ID, opaque owner context, and start time in session storage. Status polling backs off to ten seconds and pauses while hidden; requests and total waiting have deadlines. Owner context comes from an HMAC of the session owner. Status routes are owner-authorized, private, and non-cacheable. They return the owner context, title/source, prepared audio URL and actual quality details, avoiding a second access request per poll. Access is refreshed on focus/visibility return.

Clip leases use random tokens, 90-second expiry and conditional writes. Processing renews the lease every 20 seconds. Recovery reuses the existing prepared WAV and recorded download cost. The two-attempt limit bounds retries. The worker marks the paid-create boundary after quality checks immediately before the provider call. A stored clone is reconciled first. An uncertain provider outcome becomes `provider_uncertain`; operators must reconcile it before a new paid request. Automatic repetition could duplicate models and charges.

Risk acceptance returns to the durable worker queue and reuses the prepared sample. It does not start a long Fish request inside a browser-facing route. Clip-backed direct clone requests retain the same protection.

## Audio and VM resources

Duration and insufficient speech remain hard sample usability failures. Echo, clipping and level estimates are acoustic warnings; the calibrated worker reference gate handles clone risk. Compressed uploads continue to use the worker reference decoder, keeping FFmpeg out of Vercel's clone request. A worker outage retains the existing fail-open quality-check policy.

Downloaded clip duration must be known and within one second of the requested duration. Preparation caps output to the requested length. Duration cannot prove the source start time; representative provider spot-checks remain necessary.

Quality assurance shares a total deadline and limits regeneration calls to one provider attempt each. Split recovery decodes and joins complete containers using FFmpeg under the existing CPU semaphore. It retains the best judged take on failures. Mixed books master missing sections before assembly; already-mastered sections avoid another EQ/de-ess/loudness pass. Temporary audio stays in job scratch storage and is removed.

Splice search first tests one candidate per boundary, then widens only where needed. Immediate-pass join search uses three FFmpeg launches per boundary rather than nine. This reduces process startup work without changing splice thresholds or fallback range. Linux VM wall-clock speed remains to be measured.

Book and clip concurrency are unchanged. Recovery adds small clip-row lease updates and additive metadata columns. It avoids additional permanent raw-book copies. AI chaptering receives the remaining caller budget with 30 seconds reserved for saving and continuation.

## Verification and rollout

The normal suite retains a smaller duration/loudness/click correctness fixture. The twelve-minute wall-clock comparison remains available with `TTS_JOIN_BENCHMARK=1` on an idle production-like Linux host; it is explicitly skipped by default because process startup and host load make it unreliable as a portable unit-test gate.

`esbuild` is an explicit development dependency for browser harnesses. Set `PLAYWRIGHT_CHANNEL=msedge` to use installed Edge. The dedicated transcript suite runs with `npx playwright test --config e2e/transcript.config.mjs`.

Deploy worker and app code together so queue, status and owner-context contracts agree. Runtime schema migration is additive. Existing audio files are not rewritten. Production verification needs a signed-in allowlisted account, worker/database/storage access, and representative sample audio. Compare decoded output loudness and listen at matched volume before changing mastering defaults.
