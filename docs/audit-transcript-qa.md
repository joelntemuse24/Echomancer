# Section QA: Nova-3 vs self-hosted Whisper

Status: **implemented** (PR: replace Nova-3 with local Whisper). This is the
evidence behind the default and behind the decision *not* to sample sections.

## (a) What enabled Nova-3, and was it on by default?

**Yes — on by default, and there was no Nova-3-specific flag.**

`deepgram/nova-3` was named by a module constant, not an env var:

- `src/lib/tts/transcript-qa.ts:37` — `const OPENROUTER_MODEL = "deepgram/nova-3";`
- `src/lib/tts/transcript-qa.ts:436` — `transcribeWithOpenRouter(...)` posts to
  `${OPENROUTER_BASE_URL}/audio/transcriptions` with that model.

The gate was `resolveQaProvider` (`transcript-qa.ts:161` before this change):

```
if (qaExplicitlyDisabled(env)) return null;    // TTS_SECTION_QA_ENABLED=0
if (!openRouterKey(env)) return null;          // OPENROUTER_API_KEY
if (vitest && !optedIn) return null;           // TTS_SECTION_QA=1 (tests only)
return "openrouter";
```

So the enabling variable was simply **`OPENROUTER_API_KEY`**, which the worker
already sets for listen-prep. Any worker with that key ran Nova-3 on every
section. There was no `TTS_QA_PROVIDER`, no model switch, and no separate
Nova-3 credential — it billed through the OpenRouter account behind that key.

This is the most likely reason no separate Deepgram bill appeared: the charge
lands on the **OpenRouter** invoice as an `audio/transcriptions` line item
listed under model `deepgram/nova-3`, not on a Deepgram account.

Check the live worker with:

```bash
pm2 env <worker-id> | grep -E 'OPENROUTER_API_KEY|TTS_SECTION_QA_ENABLED|TTS_QA_PROVIDER'
```

Then look for `audio/transcriptions` in OpenRouter usage, filtered to that key.

## (b) Why swap

Two problems, not one.

1. **Cost.** Nova-3 is ~$0.26/audio-hour. A 10-hour book is ~$2.58, against a
   €4.50 (~$4.14) target — roughly 62% of the retail price on a voice with
   zero synthesis COGS.
2. **A 5-second cap that a real section exceeds.** `QA_WALL_BUDGET_MS` was a
   flat 5s. A 227-second section took ~6.3s on local Whisper, i.e. the old cap
   would have silently skipped or truncated the check on long sections.

## Does anything else consume the transcript or its timings?

No. Checked before changing anything:

| Candidate consumer | Verdict |
|---|---|
| Read-along word highlighting | Timing comes from **MP3 frame counts** (`section-clock.ts`, `stream-finalize.ts` → `section-starts.json`), not from ASR. `read-along.ts` builds its clock from `frozenSections` durations + measured starts. |
| Chapter timestamps | `playback-chapters.ts` uses section starts and MP3 frame durations. `asr-snap.ts` is a *separate, opt-in* `--asr-snap` path using local `faster-whisper` on the rechapter script; it does not touch QA. |
| Transcript panel | `src/lib/player/read-along.ts` builds the transcript from `content.txt` / frozen sections — the **source text**, not ASR output. `/api/jobs/[id]/transcript` reads stored section text. |
| QA itself | `fetchTranscript` resolves a **plain string**. No word timings, no segments, no timestamps are requested or returned (the request body is just model + language + base64 audio). |

So QA's transcript feeds exactly one thing: the WER/repeat/skip comparison in
`checkTranscriptAlignment`. Nothing downstream needs every section, which is
what makes local transcription — rather than sampling — the right answer.

Word timings *would* have been available from Whisper
(`word_timestamps=True` returns start/end per word, verified), so they remain
available if a future read-along upgrade wants them. They are not needed today.

## Measurements

All on the 4-vCPU worker class, `faster-whisper` 1.2.1, `int8`, `beam_size=1`,
`vad_filter=True`, ffmpeg decode to 16 kHz mono.

### Accuracy on real neural TTS

Microsoft Edge Read Aloud output (the product's own stock voices), compared
against the exact text that was synthesized. WER is word-level edit distance.

| Sample | Voice | Audio | Words | Model | WER | RTF |
|---|---|---|---|---|---|---|
| P&P opening, 2,000 chars | Andrew | 117.7s | 388 | base | **5.4%** | 0.020 |
| Sherlock passage, 2,113 chars | Ava | 132.3s | 413 | base | **2.4%** | 0.020 |
| P&P opening | Andrew | 117.7s | 388 | small | 6.4% | 0.048 |
| Sherlock passage | Ava | 132.3s | 413 | small | 2.9% | 0.076 |
| P&P opening (flite, *not* neural) | flite slt | 117.7s | 806 | base | 20.5% | 0.052 |

`base` is the default: it matches `small` on real product audio and is ~2.5x
faster. The flite row is included to show *why* it is not the benchmark —
formant synthesis is far harder for Whisper than the neural voices the app
actually produces, and measuring on it would have overstated the error rate
4x.

For reference, the QA gate is `QA_WER_MAX = 0.15`. At 2.4–5.4% WER on real
audio there is 10–12 points of headroom before a false alarm, which is the
same headroom Nova-3 (~5%) provided. **No threshold recalibration is needed.**

### CPU cost

`resource.getrusage(RUSAGE_CHILDREN)` around the sidecar process:

| Audio | Wall | CPU (user+sys) | **CPU-min per audio-min** | RTF |
|---|---|---|---|---|
| 117.7s | 4.18s | 9.03s | **0.077** | 0.036 |
| 132.3s | 4.03s | 8.88s | **0.067** | 0.031 |

Call it **~0.07 CPU-minutes per audio-minute**, i.e. QA costs about 7% of one
core for the duration of the audio it checks.

### Does it keep up with generation?

Measured Edge synthesis on the same class of machine: 4,000 characters →
**75.0s wall** for ~286s of audio ≈ **3.8 audio-seconds produced per
wall-second**.

| Stage | Audio-sec per wall-sec |
|---|---|
| Edge synthesis | 3.8 |
| Whisper `base` QA | ~30–50 |
| Ratio | **QA is ~10x faster than generation** |

So CPU Whisper is **not** a throughput bottleneck. It keeps up with full-book
generation with about an order of magnitude of headroom, and QA runs
concurrently with synthesis anyway (the check happens on a finished section
while the rest of the wave continues).

## Sampling: recommended against

Sampling was conditional on one thing: whether anything needs every
transcript. Nothing does (table above). And the throughput numbers remove the
other reason to sample — Whisper is ~10x faster than the generator feeding it,
at 7% of one core.

The trade-off if it *were* sampled:

- Cheaper in CPU, but **defects between sampled sections are never seen**.
  The failure modes QA exists for (truncated section, repeated run, silent
  take) are per-section, not per-book.
- A missed section still ships to the listener and still costs a re-listen.
- The saving is small: QA is 0.07 CPU-min per audio-min. On a 10-hour book
  that is 42 CPU-minutes, against hours of synthesis and mastering on the
  same box.

**Recommendation: check every section.** If the worker later becomes CPU-bound
(a second book in flight, or `small` promoted), revisit with a cheap-signal
gate first: `audioDurationSeconds` and `spokenCharCount` already give a
duration-drift test that needs no transcription at all, so an obvious defect
can be caught for free before deciding whether to spend CPU on WER. That is
strictly better than blind 1-in-N sampling.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TTS_QA_PROVIDER` | `local` | `local` = Whisper sidecar. `deepgram` = Nova-3. `off` = skip QA. Unrecognised → `local`. |
| `TTS_QA_WHISPER_MODEL` | `base` | `base` or `small`. int8 CPU. |
| `TTS_QA_WHISPER_COMPUTE` | `int8` | `faster-whisper` compute type. |
| `TTS_QA_WHISPER_BEAM` | `1` | Beam size. 1 is fastest; 5 is more accurate. |
| `TTS_QA_WHISPER_PYTHON` | `python3` | Interpreter for the sidecar. |
| `TTS_QA_WHISPER_SCRIPT` | `scripts/whisper-qa.py` | Sidecar path. |
| `TTS_QA_WHISPER_BUDGET_MS` | `audioSec × 400`, 10s–180s | Per-transcription wall cap. |
| `TTS_SECTION_QA_ENABLED` | unset (on) | `0`/`false`/`off`/`no` skips QA. |
| `OPENROUTER_API_KEY` | — | Only read when `TTS_QA_PROVIDER=deepgram`. |
| `TTS_QA_BUDGET_MS` | 5,000 | Network timeout, deepgram path only. |

Worker prerequisite: `pip install faster-whisper` and `ffmpeg` on `PATH`.
`install-oracle.sh` should install both; the sidecar reports a clear error and
QA keeps the audio if either is missing, so a book never fails because of it.
