# Two chapter-detection bugs: front matter and out-of-order contents rows

Status: **fixed**. Both root causes were in `playbackHeadingFlags`
(`src/lib/tts/speakable-text.ts`), not in the parsers or in `book-chapters`.

## Bug 1 — a contents row listed ahead of Chapter 1

**Symptom.** Moby-Dick's outline began `CHAPTER 40. Midnight, Forecastle.`
followed by `CHAPTER 1. Loomings.` — 137 chapters instead of 136.

**Root cause.** The detector drops a contents row when the same chapter number
appears again *with real body text*, using `item.body > REAL_BODY` (200 chars)
as "real":

```ts
if (item.body > REAL_BODY && numKey) nextRealByNumber.set(numKey, i);
```

`body` is the text between this heading and the next. Chapter 40 is a
harpooneer song:

```
CHAPTER 40. Midnight, Forecastle.
HARPOONEERS AND SAILORS.
(_Foresail rises and discovers the watch standing, lounging, leaning ..._)
Farewell and adieu to you, Spanish ladies!
```

The title is followed immediately by a scene heading, so its own `body` is **0**,
and the song's short lines never reach 200 on their own. Chapter 40 therefore
never registered as "real", `laterRealNumber` stayed `-1` for its contents row,
and the row survived.

**Fix.** A numbered title whose own body is empty because a heading that *does*
own real text follows directly is a body placement:

```ts
if (numKey && item.body === 0 &&
    items[i + 1]?.index === item.index + 1 &&
    items[i + 1].body > REAL_BODY) {
  nextRealByNumber.set(numKey, i);
}
```

This is the general shape — a chapter title immediately above its own
sub-heading — not a Moby-Dick special case. It applies to any chapter that opens
with a scene, section, or act heading.

## Bug 2 — title-page lines in the outline

**Symptom.** Pride and Prejudice began with `George Allen Publisher`,
`156 Charing Cross Road London`, `Ruskin House ]`; A Tale of Two Cities began
with its own title and contents rows; Alice began with
`The Millennium Fulcrum Edition 3.0`.

**Root cause.** Detection flags these lines because they are short and
title-cased, and nothing removed them: they are not `Chapter N` marks, and
`isMatterTitle` only knows Preface/Introduction/Epilogue-style words.

`A Tale of Two Cities` needed a second rule. Its contents rows *are* labelled
(`Book the First--Recalled to Life`), so a simple "drop unlabelled title-page
lines" pass leaves them, and the body prints the same label again later.

**Fix, part one — title-page lines.** Flagged headings that appear before the
first *labelled* heading (a chapter/part mark, a chapter/part label such as
"Chapter the Last", or a recognised book-matter title) are front matter:

```ts
let firstLabelledAt = items.findIndex(isLabelled);
for (let i = 0; i < firstLabelledAt; i++) {
  if (numbered(i) && nextLineIsSentence(i)) continue;  // "30 When"
  drop.add(items[i].index);
}
```

A numbered line is kept when a prose sentence follows it. That separates
`30 When` (a section title, followed by a sentence) from
`156 Charing Cross Road London` (an address, followed by another short line) —
they have identical shape, so shape alone cannot decide.

**Fix, part two — labelled contents rows.** For part/book/volume labels only,
keep the *last* front-matter copy and drop any copy the body repeats:

```ts
if (seenInBody.has(partKey) || lastInFront.get(partKey) !== i) drop.add(...);
```

Restricted to part/book/volume labels on purpose. Chapter numbers restart inside
a later book ("Book Two: Chapter I"), so deduplicating chapters by title would
delete real chapters — eight existing tests in `chapter-order-repro.test.ts`
caught exactly that when the rule was first written too broadly.

## Before / after on real books

Six Project Gutenberg texts, `toSpeakableText` + `safeResolveChapters`:

| Book | Before | After | First entries after |
|---|---|---|---|
| Pride and Prejudice | 65 | **62** | `Preface.`, `Chapter I.]` |
| Moby-Dick | 137 | **136** | `CHAPTER 1. Loomings.`, `CHAPTER 2.` |
| Sherlock Holmes | 12 | 12 | `I. A Scandal In Bohemia` |
| Frankenstein | 24 | 24 | `Chapter 1` |
| A Tale of Two Cities | 52 | **48** | `Book the First--Recalled to Life`, `CHAPTER I. The Period` |
| Alice | 13 | **12** | `CHAPTER I. Down the Rabbit-Hole` |

Removed in every case:

- **Pride and Prejudice** — 3 publisher/address lines. `Preface.` and all 61
  chapters kept.
- **Moby-Dick** — the duplicate `CHAPTER 40` contents row. All 135 chapters plus
  the `Epilogue` kept.
- **A Tale of Two Cities** — the book title, subtitle, and three duplicate
  contents rows. All three `Book` headings kept once each, in body order, plus
  all 45 chapters.
- **Alice** — the edition line.
- **Sherlock Holmes, Frankenstein** — unchanged, which is the point: the rules
  do not touch books that were already right.

Every list is ordered by `charStart`, verified in the measurement script.

## Known remaining imperfection

Moby-Dick's first body chapter is preceded by `ETYMOLOGY.` and `EXTRACTS
(Supplied by a Sub-Sub-Librarian).`, which are real parts of the book and are
correctly kept as chapters — so "Chapter 1" is not the first entry in the full
list. That is accurate, not a bug.

## Tests

New in `src/lib/tts/speakable-text.test.ts` (30 total, was 24):

- title page drops publisher lines, keeps `PREFACE.` and both chapters
- a part label that opens the body is kept once, in body order
- a contents list of part labels collapses to one copy per label
- a chapter title directly above a scene heading is body, not a contents row
- a numbered heading followed by prose is kept; a numbered address followed by
  a short line is dropped
- a book with no numbered chapters is untouched

Five of these fail against the previous implementation and pass after it, so
they pin the actual regressions rather than restating current output.
