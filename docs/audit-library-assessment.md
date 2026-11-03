# Audit follow-up: libraries vs LLM calls for text structuring

> **Historical.** Written before the block model. The `chapter-ai.ts` and
> `topic-embed.ts` rows below describe code that has since been deleted; the
> chapter path no longer calls a model. Kept for the record.

Status: **assessment only**. No dependency or prompt changes here.

Scope: the model calls in `src/lib/tts/` that shape text, and whether a
well-maintained library could replace each one.

## The calls we make

| Use case | Where | Model | Shape of one call |
|---|---|---|---|
| Listen-prep cleanup + per-chunk notes | `listen-prep.ts` | `xiaomi/mimo-v2.6-flash`, fallback `deepseek/deepseek-v4.1-flash` | ~8k in / ≤10k out per ~32k-char chunk (`LISTEN_PREP_TARGET_CHARS`) |
| Chapter detection | `chapter-ai.ts` | same family, `CHAPTER_AI_MODEL` override | 150k-char windows, 5k overlap, strict JSON schema |
| Chapter choice (low-confidence) | `chapter-choice.ts` | cleanup model | numbered candidates → indexes |
| Narrator suggestion | *derived*, `narrator-suggestion.ts` | **no model call** — majority vote over chunk notes | — |
| Printed-TOC topic placement | `topic-embed.ts` | `qwen/qwen3-embedding-8b` ($0.01/1M) | ~1 embedding per topic + per candidate paragraph |
| Section transcript QA | `transcript-qa.ts` | **self-hosted Whisper** (default); `deepgram/nova-3` opt-in | one STT per section, budget scales with audio |

Correction worth recording: the narrator suggestion looks like an LLM call in
the docs, but `narratorFromChunkNotes` is a deterministic majority vote over
notes the cleanup pass already produced. There is no second call to remove.

## Assessment per use case

### (a) Chapter / heading detection — **keep the model, keep the heuristic**

No library does this well. It is not "find Markdown headings"; it is "given
mangled PDF/OCR prose with no markup, decide which lines are chapter titles,
including sub-chapters the source never marked". `compromise` / `wink-nlp` can
find noun phrases; they cannot tell `Chapter VIII Closing Out` from a sentence
beginning `Chapter 8 shows…`. The heuristic in `chaptersFromHeadingLines`
already handles the mechanical cases, and the model only runs on the residue.

The library that would actually help here is not a JS NLP package — it is the
source document's own outline, which we already read (PDF outline, EPUB
NCX/nav, DOCX heading styles). The gap is HTML: `html-article.ts` discards
`<h1>`–`<h3>` and we fall back to heuristics. Fixing that is worth more than
any npm swap. See `audit-canonical-format.md` step 2.

`franc` (language detection) and `sbd` (sentence boundary) are genuine
candidates for *adjacent* work, not for chaptering.

### (b) Cleanup for narration — **keep the model**

This is the one place a library is clearly worse. The model is doing OCR
repair and prose rewriting ("[link](url)" → the label read aloud, a mangled
entity expanded, a list read as a sentence). Deterministic libraries can strip
markup (`unified`/`remark`, `cheerio`) and we already do that, cheaper, in
`html-article.ts` and `stripUnspeakableTokens`. They cannot rewrite a broken
sentence. The existing guards are the right shape: a replacement that deletes
more than a tenth of a paragraph's letters is discarded, and chapter headings
are protected.

The real win is not a library — it is not doing the pass at all when it is not
needed. `listen-prep-cache.ts` already caches by source hash; the remaining
question is whether the *narrator* route and the *freeze* path can ever both
trigger a fresh pass for one upload. They share `ensureListenPrep` and an
in-flight map, so they should not. Worth a metric rather than a rewrite.

### (c) Section splitting — **already deterministic; keep it**

`split-text.ts` is a pure packer with no model call. `sbd`'s boundary rules
are strictly weaker than what is already there (`isAbbreviationBoundary`,
sentence-prefix fitting, Google SSML byte measurement). No change.

### (d) Narrator suggestion — **no model call exists**

Nothing to swap. (See correction above.)

### (e) Section transcript QA — **done: swapped to self-hosted Whisper**

Status: **implemented**. This was the only line item above ~$0.10, so it is
the only place a swap was worth engineering. See
[`audit-transcript-qa.md`](audit-transcript-qa.md) for the full measurements.

| | Nova-3 (was) | Whisper `base` int8 (now) |
|---|---|---|
| Cost | ~$0.26/audio-hour → **~$2.58 per 10-hour book** | **$0** (CPU on the worker) |
| WER on neural TTS | ~5% | **2.4–5.4%**, measured on Edge Andrew/Ava output |
| Speed | ~realtime+ network | **RTF 0.02** wall, 0.07 CPU-min per audio-min |
| Wall cap | flat 5s (too short for a 227s section) | `audioSec × 0.4`, 10s–180s |
| Default | on, whenever `OPENROUTER_API_KEY` existed | `TTS_QA_PROVIDER=local`; Deepgram is opt-in |

The 15% WER gate needs no recalibration: Whisper leaves 10–12 points of
headroom, the same as Nova-3 did.

**On sampling.** I recommended it here and the measurement now says not to.
Nothing consumes the transcript or its timings (read-along timing is MP3 frame
counts), so sampling was on the table; but Whisper runs ~10x faster than Edge
generation (3.8 audio-sec per wall-sec) at 7% of one core, so every section can
still be checked. Sampling would trade real per-section coverage for a saving
that is small against the synthesis already happening on the same box. **Check
every section.** If the worker later becomes CPU-bound, add a cheap pre-gate
(duration drift from `audioDurationSeconds` and `spokenCharCount`, no
transcript needed) before spending CPU on WER — strictly better than blind
1-in-N sampling.

Earlier text in this section described replacing a *library*; the correct
framing was replacing a **provider**. `faster-whisper` is that library, and it
is Python, so it runs as a sidecar (`scripts/whisper-qa.py`) rather than in
Node.

### (f) Printed-TOC topic placement — **already the cheap option**

One embedding call per topic. It is behind `CHAPTER_TOPIC_EMBED` and off by
default. Fine as-is.

## Candidate libraries, concretely

| Package | Verdict |
|---|---|
| `unified` + `remark` / `rehype` | Useful if a Markdown canonical form ever lands. Not needed today. |
| `cheerio` | Would replace the hand-rolled tag walker in `html-article.ts`. Current walker is ~80 lines and dependency-free; `cheerio` pulls a DOM parser into a Vercel function. Not worth it. |
| `compromise`, `wink-nlp`, `natural` | Cannot distinguish headings from prose in unmarked text. No. |
| `sbd`, `franc` | Adjacent value (sentence splits, language), not a replacement for any current call. |
| `epub-gen` | Would be needed only for an EPUB canonical format; see the other doc for why that is the wrong shape. |
| `tiktoken` | Would make `LISTEN_PREP_CHARS_PER_TOKEN = 4` exact instead of approximate. Small, real, low-risk win if chunk sizes ever need tightening. |
| `pandoc` (CLI) | Would replace DOCX/RTF/EPUB parsing wholesale, but adds a binary to the VM image and the Cloudflare extract fallback cannot run it. Not now. |

## Bottom line

The model calls that remain are the two that genuinely need a model (cleanup
and chapter detection), plus one embedding call and one STT call. There is no
library swap that clearly improves cost, accuracy, or speed. The highest-value
change in this area is feeding the models better structure (HTML headings)
rather than replacing them.
