# Chapter-detection corpus results

Run with `scripts/fetch-corpus.sh` then
`npx tsx --tsconfig tsconfig.json scripts/chapter-corpus.ts`.

Every source is public domain or freely licensed; nothing is committed. The
script and manifest are. Add `--json` for machine-readable output and
`--classifier` to run the optional local model (see "The classifier" below).

Columns: **before** is the top-level marker count on `main` at the start of this
work; **after** is the total marker count (children included) now. The before
column counted roots only, which is why a number can *fall* for a book whose
outline got richer — 135 Moby-Dick chapters nested under a "Part" is one root
and 136 markers.

## Results

| id | fmt | chars | before | after | delta | source |
|---|---|---|---|---|---|---|
| `pg-pride-prejudice` | txt | 721,216 | 66 | 65 | -1 | `heading-lines` |
| `pg-moby-dick` | txt | 1,218,064 | 71 | 245 | +174 | `heading-lines` |
| `pg-sherlock` | txt | 562,246 | 5 | 13 | +8 | `heading-lines` |
| `pg-frankenstein` | txt | 419,587 | 25 | 24 | -1 | `printed-toc` |
| `pg-tale-two-cities` | txt | 757,218 | 96 | 95 | -1 | `heading-lines` |
| `pg-alice` | txt | 143,848 | 14 | 13 | -1 | `heading-lines` |
| `pg-war-peace` | txt | 3,205,686 | 390 | 383 | -7 | `heading-lines` |
| `pg-dracula` | txt | 839,981 | 51 | 67 | +16 | `heading-lines` |
| `pg-dorian-gray` | txt | 429,456 | 21 | 20 | -1 | `heading-lines` |
| `pg-metamorphosis` | txt | 118,595 | 3 | 3 | — | `heading-lines` |
| `pg-ulysses` | txt | 1,516,383 | 2 | 19 | +17 | `sections` |
| `pg-heart-darkness` | txt | 210,375 | 6 | 4 | -2 | `heading-lines` |
| `pg-epub-pride-prejudice` | epub | 704,022 | 88 | 60 | -28 | `epub-spine` |
| `pg-epub-moby-dick` | epub | 1,209,550 | 139 | 140 | +1 | `epub-spine` |
| `pg-epub-sherlock` | epub | 579,536 | 12 | 12 | — | `epub-spine` |
| `se-pride-prejudice` | epub | 684,758 | 57 | 61 | +4 | `epub-spine` |
| `se-moby-dick` | epub | 1,212,865 | 7 | 141 | +134 | `epub-spine` |
| `se-frankenstein` | epub | 436,560 | 7 | 35 | +28 | `epub-spine` |
| `se-tale-two-cities` | epub | 755,831 | 5 | 50 | +45 | `epub-spine` |
| `se-alice` | epub | 144,311 | 4 | 14 | +10 | `epub-spine` |
| `se-art-of-war` | epub | 416,168 | 16 | 23 | +7 | `epub-spine` |
| `se-crime-punishment` | epub | 1,133,223 | 44 | 49 | +5 | `epub-spine` |
| `se-time-machine` | epub | 179,131 | 10 | 14 | +4 | `epub-spine` |
| `pdf-attention` | pdf | 37,212 | 5 | 22 | +17 | `pdf-outline` |
| `pdf-resnet` | pdf | 57,889 | 8 | 9 | +1 | `heading-lines` |
| `pdf-gpt3` | pdf | 234,317 | 13 | 32 | +19 | `pdf-outline` |
| `pdf-word2vec` | pdf | 37,767 | 7 | 19 | +12 | `pdf-outline` |
| `pdf-constitution` | pdf | 11,717,282 | 31 | 363 | +332 | `heading-lines` |
| `pdf-nist` | pdf | 1,502,341 | 3 | 340 | +337 | `pdf-outline` |
| `pdf-plos` | pdf | 37,776 | 4 | 4 | — | `heading-lines` |
| `web-wikipedia-whale` | html | 97,440 | 0 | 13 | +13 | `html-heading` |
| `web-gutenberg-html` | html | 718,268 | 69 | 61 | -8 | `html-heading` |
| `web-essay` | html | 66,887 | 2 | 2 | — | `heading-lines` |
| `web-sep-kant` | html | 129,099 | 2 | 22 | +20 | `html-heading` |

## What changed and why

One idea, applied per format: **trust the source's own structure first**.
Structured sources now return an ordered block list plus chapter markers that
point at block indexes (`src/lib/blocks.ts`, `src/lib/block-chapters.ts`).
Character offsets are derived once (`src/lib/block-projection.ts`), so nothing
searches the prose for a title any more. Plain text keeps the regexes, gets a
Gutenberg peel, and falls back to labelled length parts.

### EPUB: the nav/NCX TOC is the outline

`pg-epub-sherlock` **5 -> 12**: the twelve stories, by their printed titles. The
old path flattened each spine file to text and re-found headings with regexes,
so a contents row and the first body heading merged into one paragraph and the
book reported five licence-boilerplate "chapters". A TOC `#fragment` also
resolved to the *file's* first paragraph, so chapters sharing a file all landed
on the same place; it now resolves to the block carrying that id.

`se-moby-dick` **7 -> 141** (Etymology, Extracts, 135 chapters, Epilogue),
`se-tale-two-cities` **5 -> 50**, `se-pride-prejudice` **57 -> 61**,
`se-time-machine` **10 -> 14**. The TOC beats a printed contents page because it
is the only list that knows the book has 135 chapters when the prose spells out
71.

`pg-epub-pride-prejudice` **88 -> 60**. Project Gutenberg ships a per-paragraph
NCX for this book (516 `navPoint`s for 61 chapters, most pointing at anchors
that are not in the body). The outline is now gated on *distinct* positions, and
that list loses to the book's own 60 heading blocks.

### HTML: the page's own `h1`-`h6`

`web-wikipedia-whale` **0 -> 13**. `htmlToArticle` flattened the document and
dropped every heading, so a Wikipedia article reached detection as unmarked
prose. Region selection is now `@mozilla/readability` (Apache-2.0) and the
region is walked into blocks. `web-sep-kant` **2 -> 22**,
`web-gutenberg-html` **69 -> 61** (the contents table Gutenberg prints as `<h2>`
rows is dropped; the 61 real chapters stay).

### PDF: the embedded outline, resolved to blocks

`pdf-nist` **3 -> 340**, `pdf-gpt3` **13 -> 32**, `pdf-attention` **5 -> 22**,
`pdf-word2vec` **7 -> 19**. Each outline destination now resolves to the block
on its page whose heading text matches, so three entries sharing one page (arXiv
does this) stay distinct. The contents page is no longer a candidate.

Heading detection from layout stays conservative on purpose: a bare-title rule
was tried and turned a 5-entry outline into 27 on an arXiv paper, because table
cells and figure labels look like titles. A PDF with no embedded outline keeps
its heading-line and printed-contents paths.

### Plain text: heuristics, plus a Gutenberg peel

`pg-moby-dick` **71 -> 245** is the headline: the `.txt` now reads the 135 body
chapters (plus Extracts, Etymology, the Epilogue and the whale-taxonomy
sections) instead of the 71-row contents page. A printed contents page can only
*confirm* headings found in the body, so it is kept only when it names at least
as many distinct chapters as the body does.

`pg-sherlock` **5 -> 13** is the other one. The extract kept the contents page
running on into the first body heading — "... XII. The Adventure of the Copper
Beeches" + "I. A SCANDAL IN BOHEMIA" became one paragraph. A change of shape (a
roman-numeral contents row into an all-caps title) now ends the paragraph, and a
block that names a chapter and has prose under it is protected from the
front-matter and contents-row passes.

The Gutenberg header and footer are stripped from `.txt`, including the banner
that wraps across two lines. That removes the five licence "chapters" every
Gutenberg book used to report, and the publisher's imprint lines on the title
page.

`pg-ulysses` **2 -> 19 labelled parts**. The book prints no chapter marks; its
only capitalised headings are the newspaper headlines inside one episode (58 of
them). A book with no chapter labels *and* only shouted headings gets
length-based parts labelled "Part 1"..."Part 19" — never an invented title.

`pg-dracula` **51 -> 67**: the diary heads ("MINA MURRAY'S JOURNAL") are now
kept alongside the numbered chapters.

## Books that got smaller, and why

Each is a case where the old number was inflated, not a silent regression.

| Book | Before | After | Why |
|---|---|---|---|
| `pg-epub-pride-prejudice` | 88 | 60 | 88 was one row per NCX entry, contents rows included; 60 is the chapter count. |
| `pg-heart-darkness` | 6 | 4 | 4 is chapters I, II, III plus one in-page head ("Approach"). The 6 was three chapters each counted twice by their contents rows. |
| `web-gutenberg-html` | 69 | 61 | 69 included the 61-row contents table plus publisher imprint lines; 61 is the chapters. |
| `pg-war-peace` | 390 | 383 | Seven were the Gutenberg licence "chapters" and a stray `part.` line. |
| `pg-alice` | 14 | 13 | 13 is 12 chapters plus the prefatory poem "All in the Golden Afternoon". |
| `pg-tale-two-cities` | 96 | 95 | One duplicate contents row. |
| `pg-pride-prejudice` | 66 | 65 | 65 is 61 chapters plus Preface and the two volume half-titles; the 66th was a publisher address. |
| `pg-frankenstein` | 25 | 24 | 24 is the four letters and twenty chapters; the 25th was the licence heading. |
| `pg-dorian-gray` | 21 | 20 | 20 chapters; the 21st was the licence heading. |

## What the corpus still shows

- **`pdf-constitution` has no usable embedded outline** — `getOutline()`
  returns four "Blank Page" entries — so it falls to heading lines, which read
  363 markers from a 2,780-page legal volume. Many are section headings rather
  than chapters; the number is honest about what the page prints, and a
  human still has to judge whether that is the outline they want.
- **`pg-sherlock` (txt) keeps 13 markers for 12 stories**: the twelve stories
  plus one bare "I." line the book prints beside the first story's title. The
  duplicate is a line-break artifact in the source file, not a phantom chapter.
- **`pg-war-peace` nests Books and chapters**, so 383 markers are 15 Books plus
  their chapters, not 383 chapters.
- **Contents rows still leak on some paths** — `pg-frankenstein` flags
  `CONTENTS_ROWS`, `pdf-constitution` a duplicate `section. 1.`.
- **`pg-pride-prejudice` (txt)** keeps `Chapter I.]` as a title and a `part.`
  line; both are line-break artifacts in the source file.

## The classifier

`src/lib/chapter-classifier.ts` is an optional local zero-shot classifier for
borderline heading lines, off unless `CHAPTER_CLASSIFIER=1`. Measured, not
assumed:

| | |
|---|---|
| Model | `MoritzLaurer/deberta-v3-xsmall-zeroshot-v1.1-all-33` (MIT, 8 MB int8 ONNX) |
| Licence check | the plan named `Xenova/nli-deberta-v3-xsmall`; its model card has **no licence field** (the base `microsoft/deberta-v3-xsmall` is MIT). This export states MIT outright. |
| Load | ~1.2 s once per process, then cached under `${ECHOMANCER_SCRATCH_DIR:-/tmp}/hf-cache` |
| Latency | **~13 ms per line** on one CPU core; 2.3 s for 172 scored lines across the whole 34-book corpus |
| Gate | only short, title-shaped, unpunctuated lines between blank lines |
| Caps | 400 ms per line, 20 s per book, 200 lines per run |

Task formulation, measured on 45 real printed headings and 20 lines of real
prose (AUC of heading-vs-prose separation):

| Formulation | AUC |
|---|---|
| `This text is {a chapter or section heading / a sentence of prose}.` | **0.87** |
| `"This is a complete sentence."` as an entailment hypothesis | 0.74 |
| `This text is {a heading / a sentence}.` | 0.74 |
| `This text is {the title of a section / a line of narrative}.` | 0.31 |

At the shipped thresholds (veto below 0.22, promote above 0.72) on that set: 44
of 45 headings kept, 3 of 20 prose lines wrongly kept — and the prose it does
catch is the failure the corpus shows (`chapter of sounds. Yet, for all his
hardy sobriety...` scores 0.95).

**Promotion is a separate opt-in** (`CHAPTER_CLASSIFIER_PROMOTE=1`). Measured
on the corpus, promotion is destructive: War and Peace has 805 borderline lines
and the model promotes 379 of them, because a book heading and a book's short
sentence look alike to a model this size. Veto-only changes one book
(`pg-heart-darkness` 4 -> 3). That is the honest result: the classifier is
useful enough to ship behind a flag as a *veto*, and not useful enough to be on
by default.
