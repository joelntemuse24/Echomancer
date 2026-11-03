# Task 3: chapter-structure gate and the double resolve

> **Historical.** Written before the block model landed. `resolveChaptersForBook`
> no longer calls a model at all (`src/lib/tts/chapter-ai.ts` is gone), so the
> claim-1 fix is now structural rather than a whitelist. Kept for the record.

Status: **implemented**. Both claims were verified; one changed behaviour, the
other turned out to be a much larger latency bug than the claim suggested.

## Claim 1 — `hasValidChapterStructure` excludes `heading-lines`

**Confirmed in code.** The whitelist was:

```
["epub-spine", "pdf-outline", "printed-toc", "ai", "docx-heading"]
```

`heading-lines` was absent, so `resolveChaptersForBook` fell through to the AI
path for **every** book whose chapters came from the deterministic detector.

**Confirmed that it can replace a correct outline.** A stub model that answers
with a plausible but wrong one-chapter outline:

| Book | Detected chapters | After `resolveChaptersForBook` (before fix) | Replaced? |
|---|---|---|---|
| Pride and Prejudice | 65 | 1 (`source: "ai"`) | **yes** |
| Frankenstein | 24 | 24 | no |
| Sherlock Holmes | 12 | 12 | no |

P&P is the case that matters: 65 correct chapters replaced by 1.

**Honest limits of the evidence.** No live model key was available in this
environment, so the replacement was demonstrated with a stub, not with
`xiaomi/mimo-v2.6-flash`. What is proven:

- the code path always ran the model for heuristic books (measured: the fetch
  was called),
- the return value of the AI call is used **unconditionally** when it is
  non-empty (`if (ai && ai.chapters.length > 0) return ai;`), with no
  comparison against the offline outline,
- a plausible model answer therefore does replace the detected one.

What is *not* proven: how often the production model actually degrades a good
outline rather than improving it. The fix does not depend on that frequency —
it removes a call that cannot be justified when a valid outline already
exists. A future measurement with a real key could refine the junk-detector
thresholds; it is not needed for the safety property.

**Fix.** `heading-lines` is now in the whitelist. `hasValidChapterStructure`
still enforces the real invariants (ordered, in-range, non-empty, bounded
`charStart`/`charEnd`, valid nesting), so a garbage heuristic outline is still
rejected. `forceAi` was added for the one caller that genuinely wants the model
regardless (the rechapter script).

After the fix, all three books keep their detected outline and make **zero**
model calls. A book with no headings at all (`sync.chapters.length === 0`) is
still invalid, so the model still runs for the category it exists for —
verified with an unmarked-prose fixture.

**Modest caution.** The heuristic detector is not perfect: P&P leaks a
publisher line (`George Allen Publisher`), and Moby-Dick misorders
(`CHAPTER 40` first). Those books now keep those defects instead of being
"fixed" by the model. That is the right trade — a deterministic, debuggable
outline beats an unpredictable replacement — but it makes the detector bugs
visible, and they are worth fixing on their own (tracked in the canonical-format
write-up).

## Claim 2 — `resolveChapters` is computed more than once

**Confirmed, and understated.** Measured on real books, `performance.now()`:

| Book | Chars | `resolveChapters` before | after |
|---|---|---|---|
| Pride and Prejudice | 721,404 | 58.2 ms | 72.9 ms |
| **Moby-Dick** | 1,218,613 | **3,549.6 ms** | **179.3 ms** |

Breaking down the 3.5s:

| Stage | Before | After |
|---|---|---|
| `chaptersFromHeadingLines` | 41.4 ms | 43.6 ms |
| **`chaptersFromPrintedToc`** | **3,367.6 ms** | **115.1 ms** |
| `chapterCandidates` (called twice) | 2 × ~20 ms | 1 × ~22 ms |

**Root cause.** `findBodySpan` did two pure per-paragraph computations *inside*
its scan:

```ts
const texts = spans.map((span) => clean(span.text));   // whole book, per call
...
headingLineMatches(para, entry.match)                  // re-normalises para
headingLineMatches(para, entry.label)                  // and again
```

`findBodySpan` is called once per printed-contents entry, so the work was
**entries × paragraphs** over the whole book, with `normAnchor` regex work
repeated for every pair. Moby-Dick has ~135 entries.

**Fix.** Clean and heading-normalise each paragraph once per
`chaptersFromPrintedToc` call and reuse both arrays. `findBodySpan` then
compares pre-normalised strings. Behaviour is identical — the same
`headingPrefix`/`headingContained`/`isBodyHeadingBlock` rules are applied to
the same values — and all printed-TOC tests pass unchanged.

**Also fixed:** `chapterCandidates(spoken)` ran twice per
`resolveChaptersForBook` (once inside `needsChapterChoice`, once immediately
after). It now runs once and the list is passed in.

## What this does not fix

- `toSpeakableText` still runs at extract and again at freeze. It is
  idempotent, and the measured cost is tens of ms against multi-minute jobs, so
  there is nothing worthwhile to reclaim.
- The detector defects above (Moby-Dick ordering, P&P front matter).
- `chapter-ai` running at both extract and freeze for unmarked books. Now that
  heuristic books skip the model entirely, the remaining double run is
  confined to the unmarked category and needs its own measurement.

## Cost and latency saved

| | Per book |
|---|---|
| Model calls | 1 fewer (whole-book, 17 windows on a large book) for every heuristic-chaptered upload |
| Latency | **~3.4s → ~0.1s** on chapter resolution for a 1.2M-character book |
| Cost | The model call was ~$0.02/book; on Edge stock that is now zero for this category |

The latency figure is the larger win: it sat on the extract path, before any
audio could start.
