# Audit follow-up: canonical intermediate format

Status: **Phase 0 implemented** (PR #227). The block model in Phases 1–3
remains a proposal.

Companion to PR #225 (the safe dedupe fixes). This covers the owner's idea:
convert every input into one canonical intermediate format so everything
downstream has a single path.

## Recommendation

**Against a canonical document format as the next step. For a narrower version
of the idea: make `ChapterHint` the one structured contract every parser
produces, and add source offsets to it.**

Reasons, in order of weight:

1. **The flattening already happened, and it is load-bearing.** Every job is
   keyed to a flat `content.txt` plus `chapters.json` whose offsets are
   JavaScript string indexes into that exact file (`book-chapters.ts:4–5`,
   `ChaptersDocument` in the same file). `segments_json`, `frozen-script.ts`
   (`speakable.txt` + `sections.json`), `playback-chapters.json`,
   `section-starts.json`, and the ID3 chapter mux all index into the same flat
   string. A richer intermediate format does not remove that string; it adds a
   second representation that has to be kept in sync with it. That is more
   paths, not fewer.

2. **Nothing downstream consumes the structure that is being lost.** The
   consumers are: chapter boundaries (`chapter-choice.ts`,
   `book-chapters.ts`), playback timing (`player/playback-chapters.ts`),
   section packing (`split-text.ts`), and read-along spans. All of them want
   *character offsets into the speakable text*. Emphasis, images, captions,
   fonts, and TOC nesting are already deliberately dropped before narration
   (`html-article.ts` drops `figure`/`sup`; `pdf-furniture.ts` drops edge
   lines). Preserving them would produce data no consumer reads.

3. **EPUB specifically is the wrong choice.** EPUB would mean building an
   EPUB *writer* for PDF/DOCX/TXT/HTML input (XHTML serialization, OPF, NCX —
   `epub-gen`-shaped work), then immediately re-parsing it with the reader in
   `text-extraction.ts:596+`. That is a serialize/deserialize round trip inside
   the hot upload path, and the round trip is not lossless for the thing we
   actually care about: exact offsets into the final speakable string. It also
   adds a failure mode (epub-gen emits invalid XHTML for some inputs) to a path
   that currently has none. If a canonical format is ever wanted, a plain
   block-array JSON is better, because offsets survive it.

4. **The real cost is per-format parsing, not the shape of the middle.** PDF
   needs `unpdf` + furniture detection; EPUB needs JSZip + NCX/nav; DOCX needs
   mammoth; HTML needs readability heuristics. No intermediate format removes
   any of those. The duplication that actually exists today was the *cleanup*
   stage, and #224 already collapsed it into `normalizeSourceText`.

## What the narrow version looks like

One thing is already true and worth recording: every parser funnels through
`normalizeExtractedText` → `normalizeSourceText` (`text-extraction.ts:69`), so
PDF, EPUB, DOCX, RTF, MOBI, and TXT all share the per-format parse followed by
the one cleanup pass. `fetch-public-page.ts:300` and the paste route do the
same for HTML and pasted text. The cleanup half of the owner's idea shipped in
#224; what is left is the *structure* half.

`ChapterHint` (`book-chapters.ts`) is already the shared contract: every
extractor returns `ExtractedDocument { text, hint }`, and `resolveChapters`
consumes it. The gap is that the field set is inconsistent between producers:

| Producer | `source` | Gives |
|---|---|---|
| PDF | `pdf-outline` / `heading-lines` | `titles` (level + pageIndex), `pageProbes`, `pageStarts`, `tocLines` |
| EPUB | `epub-spine` | `titles` with `anchors` |
| DOCX | `docx-heading` | `titles` with level |
| TXT / paste | `heading-lines` | empty |
| HTML (URL) | `heading-lines` | empty, plus `chapterHint` passthrough for documents |

Phased work if the owner wants to pursue it:

1. Type the hint as a discriminated union per source, so a missing field is a
   compile error rather than a silent heuristic fallback. Touches
   `book-chapters.ts`, `text-extraction.ts`, `fetch-public-page.ts`,
   `app/api/text/upload/route.ts`. Low risk, no storage change.
2. Have HTML extraction emit a real outline from `<h1>`–`<h3>` (the EPUB
   extractor already does exactly this in `htmlHeadings`) and set
   `source: "html-heading"`. Today a web page falls back to
   `heading-lines` heuristic detection, which is the weakest path in the
   system. This is the single highest-value piece of the owner's idea.
3. Only if 1–2 prove insufficient, consider a block model. It would be a
   **derived** artifact written beside `content.txt` for future readers, never
   a replacement for it.

## Phase 0 — implemented, and what it actually found

Phase 0 was "persist the hint, use the exact page offsets, stop dropping blank
pages". Doing it surfaced three concrete bugs, all confirmed by measurement
rather than by reading:

1. **`hint.pageStarts` was never assigned.** `extractPDF` declared the variable
   and the `else if (pageStarts)` branch was dead. Placement fell back to
   `locatePageStarts`, which searches for the first 48 characters of each page.
   The probe keeps the *unwrapped* spacing (`Chapter One The lamps…`) while the
   normalized text has paragraph breaks there (`Chapter One\n\nThe lamps…`), so
   `indexOf` failed and every later page collapsed onto one cursor. On a
   three-chapter PDF with real outline destinations, all three chapters
   resolved to **offset 0**. The fix relays the exact offsets through
   `relocatePageStarts` (whitespace-insensitive, searches outward from the
   measured offset): same PDF → offsets 0 / 164 / 328, each on its own page.

2. **A blank page shifted every later page index.** `bodyTextByPage` filtered
   blank pages out, so an outline destination after a blank page pointed one
   page early. Blank pages now keep their slot as `""`. Verified on a PDF with
   title page, blank page, then three chapters.

3. **The hint was thrown away** at the end of `runUploadExtract`. It is now
   written to `pdfs/<id>/outline.json` (advisory; `chapters.json` remains what
   the player reads).

**Honest scope note.** On six Project Gutenberg `.txt` books the chapter counts
and titles are **byte-identical** before and after (65 / 137 / 12 / 24 / 52 /
13). That is expected and not a disappointment: those inputs have no outline
and no page map, so the defect cannot appear. The evidence for the fix is the
synthetic PDFs. Anyone quoting "Phase 0 improved chapter detection" on real
books would be overstating it — what it fixed is PDF page placement and
printed-TOC page mapping.

Two unrelated bugs surfaced in that same measurement and are **still open**:
Moby-Dick lists `CHAPTER 40` as its first chapter (ordering in the heading
path), and P&P / A Tale of Two Cities leak front-matter lines
(`George Allen Publisher`, `A Tale Of Two Cities`) into the outline. Both live
in the heuristic detector, not in page offsets.

## Task 3 — the structure gate and the double resolve

Two claims from the audit were checked against real books. See
[`audit-chapter-structure.md`](audit-chapter-structure.md).

**The gate was real.** `hasValidChapterStructure` omitted `heading-lines`, so
every heuristic-chaptered book went to the model, and a model answer replaced
the detected outline unconditionally. With a stub that answers plausibly,
Pride and Prejudice's 65 correct chapters became **1**. Fixed: `heading-lines`
is accepted, and `forceAi` exists for callers that really want the model.

**The double resolve was much bigger than "twice".** `findBodySpan` cleaned and
heading-normalised every paragraph of the book once per printed-contents entry,
making `chaptersFromPrintedToc` quadratic. On Moby-Dick this was **3,367ms** of
a 3,550ms `resolveChapters`. Normalising once per paragraph took it to
**115ms**, and `resolveChapters` to **179ms**.

This sharpens the §4 argument above. The cost of the current design is not
only "offsets live in a mutable string"; it is that structure is re-derived by
scanning, and scans that look linear become quadratic per entry. A canonical
block model would collapse most of `printed-toc.ts` and `book-chapters.ts`
alignment into index arithmetic — which is now the strongest argument *for*
Phases 1–3, even though Phase 0 already removed the worst instantiation.

## Why not replace the flat text

A stored book today is `pdfs/<id>/content.txt` + `chapters.json`, and a
finished job adds `audiobooks/<id>/{speakable.txt,sections.json,playback-chapters.json,section-starts.json}`.
Every one of those stores character offsets. Migrating to a block model means
either (a) keeping the flat string anyway and adding a block index, or
(b) rewriting all offsets for every existing job. (b) is a destructive
migration across production R2 with no user-visible benefit.
