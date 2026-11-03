# Canonical block model: plan

Status: **plan only, not implemented.** Replaces the flat `content.txt` +
char-offset `chapters.json` pairing with an ordered block list plus chapter
markers.

Companion to `docs/audit-canonical-format.md` (the assessment) and
`docs/audit-chapter-frontmatter-order.md` (recent bug fixes). This document is
the implementation plan.

## Why

Every chapter operation today is a regex over a flat string:

- `chaptersFromHeadingLines` scans paragraphs looking for heading shapes.
- `chaptersFromPrintedToc` searches body text for each contents label.
- `alignTitles` / `pageCandidates` / `locatePageStarts` re-find positions that
  the parser already knew.
- `anchorChapterTree` re-finds headings after listen-prep rewrites the text.
- `forcedHeadingPlan` re-matches an outline against packed sections.

The corpus run in this PR (`scripts/chapter-corpus.ts`) shows the cost. Every
structural fact is re-derived from prose, so:

| Failure class | Example from the corpus |
|---|---|
| Prose mistaken for a heading | "part of the foot-board of the bed…" (Moby-Dick) |
| Contents row kept as a chapter | `CHAPTER 40` ahead of `CHAPTER 1` (fixed in #230) |
| A chapter heading lost before detection | Sherlock Holmes' body headings — present in the extract, absent from the speakable text |
| Wrong list chosen | Moby-Dick's 71-entry contents replacing 135 real chapters |
| Chapter numbering restarts | War and Peace, Crime and Punishment |

Each was a different rule patched into the same regex pipeline. A block model
makes most of these *structural* rather than heuristic: a heading is a block
with `kind: "heading"`, not a line that happens to match a shape.

## Shape

```ts
type BookBlock = {
  id: number;
  kind: "heading" | "para" | "list-item" | "quote" | "verse" | "table" | "caption" | "footnote" | "scene-break";
  /** Heading depth, 1–6, only for kind === "heading". */
  level?: number;
  text: string;
  /** Where this came from: PDF page, EPUB spine index, HTML element, ... */
  source?: { page?: number; spineIndex?: number; printedPage?: number };
};

type BookDocument = {
  version: 1;
  meta: { title: string | null; language: string | null; sourceFormat: string };
  blocks: BookBlock[];
  /** Chapter markers as block ids — no char offsets. */
  outline: Array<{ title: string; level: number; blockId: number }>;
};
```

Chapter markers point at **block ids**, not character offsets. Offsets become a
derived quantity (`blockId → charStart` via a projection function), computed
once when the speakable text is produced.

### The projection

```ts
blocksToSpeakable(doc): { text: string; blockStart: number[] }
```

Concatenates block text with paragraph separators and records each block's
starting character in the output. This is the only place offsets are decided,
and it is testable in isolation: feed a block list, assert the text and the
starts.

`chapters.json` continues to exist for the player, but it is *generated* from
`outline` + `blockStart` instead of being detected separately.

## Phases

### Phase 1 — block model for new uploads, additive (medium effort)

New `src/lib/blocks.ts` (types + `blocksToSpeakable`) and `src/lib/pdf-blocks.ts`
(PDF → blocks, reusing `pdf-furniture` line grouping). `extractDocument` returns
`{ text, hint, blocks }`; `runUploadExtract` writes `blocks.json` beside
`content.txt`.

`content.txt` is unchanged, so **nothing downstream changes**. The block file is
inert data until something reads it.

*Risk: low.* Rollback is "stop writing `blocks.json`".

*Effort:* ~6 source files, ~3 test files. The PDF line→block mapping is the only
real work.

### Phase 2 — HTML sources → blocks (low effort, high payoff)

One `src/lib/html-blocks.ts` shared by EPUB, DOCX and web pages. `<h1>`–`<h6>`
become `heading` with the right level; `<ol>/<li>` becomes ordered `list-item`;
`<table>` becomes rows; `<blockquote>` becomes `quote`; mammoth's trailing note
`<ol>` becomes `footnote`.

This is where the visible wins are, because HTML already carries the structure
and the current regex stripper throws it away.

*Risk: low.* Format-specific; each can land independently.

### Phase 3 — outline from blocks (medium effort, medium risk)

`resolveChapters` reads `doc.outline` when present and falls back to today's
detection otherwise. `alignTitles` becomes a fallback rather than the path.

*Risk: medium.* This is where output can change for existing books. Gate it
behind a per-upload flag and compare against the current outline in tests before
enabling.

### Phase 4 — retire the re-search layer, lazily (medium effort)

`anchorChapterTree`, `locatePageStarts`, `restoreProtectedHeadingBreaks` and the
`pageProbes` machinery shrink to fallbacks for legacy uploads.

Backfill `blocks.json` for existing uploads only where `source.<ext>` is still
in R2 — that is, while the upload row lives. **Never rewrite `content.txt` for a
finished job**: `stream_cursor`, read-along timing and listen-prep's
`sourceHash` all depend on it.

*Risk: medium.* Read-only backfill; the audio is never re-synthesized.

## Effort and risk summary

| Phase | Files | Risk | Reversible |
|---|---|---|---|
| 1. Blocks for new PDFs | ~6 | Low | Yes — stop writing the file |
| 2. HTML → blocks | ~6 | Low | Yes per format |
| 3. Outline from blocks | ~8 | **Medium** | Yes — flag per upload |
| 4. Retire re-search | ~10 | Medium | Yes — keep fallbacks |

Total: roughly 20–24 source files and 15–20 test files across four independently
mergeable steps. No phase touches synthesis, mastering, or storage layout.

## What this does NOT fix

- **Detection inside a prose block.** A chapter heading glued into a paragraph
  (no line break in the extract) is invisible to a block model too. That needs a
  parser fix, not a format change.
- **Two-column PDFs and scanned pages** without a text layer.
- **The LLM cleanup rewrite.** It still mutates text; block ids survive but text
  inside a block may be replaced, so `blockId + offsetInBlock` still needs a
  re-anchor pass, just a much narrower one.

## Recommendation

Do Phase 1 and 2. They are additive, low risk, and remove the largest class of
bug — structure that the parser already knew being thrown away and re-derived by
regex. Hold Phase 3 behind a flag until the corpus shows the block outline
matching or beating detection on the same books; the corpus script in this PR is
the harness for that comparison.
