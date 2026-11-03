# Chapter-detection corpus results

Run with `scripts/fetch-corpus.sh` then
`npx tsx --tsconfig tsconfig.json scripts/chapter-corpus.ts`.

Every source is public domain or freely licensed; nothing is committed. The
script and manifest are. Add `--json` for machine-readable output and
`--classifier` to run the optional local model (see "The classifier" below).

## Columns

- **chapters** — the top-level list the player shows as chapters. This is the
  number that matters for a listener.
- **all** — every marker, sub-sections included. A book whose parts nest its
  chapters reports a small `chapters` and a large `all`; that is the outline
  working as intended, not a smaller book.
- **source** — which detector won.

The top level is decided per book by `src/lib/chapter-levels.ts`: the source's
own nesting, else sub-section numbering (`2.1` under `2`), else heading depth
(`h1`/`h2` chapters, `h3`+ children), else Book/Part/Article containers.

## Results

| id | fmt | chars | chapters | all | source |
|---|---|---|---|---|---|
| `pg-pride-prejudice` | txt | 721,216 | 65 | 65 | `heading-lines` |
| `pg-moby-dick` | txt | 1,218,064 | 144 | 144 | `heading-lines` |
| `pg-sherlock` | txt | 562,246 | 13 | 13 | `heading-lines` |
| `pg-frankenstein` | txt | 419,587 | 24 | 24 | `printed-toc` |
| `pg-tale-two-cities` | txt | 757,218 | 11 | 95 | `heading-lines` |
| `pg-alice` | txt | 143,848 | 13 | 13 | `heading-lines` |
| `pg-war-peace` | txt | 3,205,686 | 15 | 383 | `heading-lines` |
| `pg-dracula` | txt | 839,981 | 67 | 67 | `heading-lines` |
| `pg-dorian-gray` | txt | 429,456 | 20 | 20 | `heading-lines` |
| `pg-metamorphosis` | txt | 118,595 | 3 | 3 | `heading-lines` |
| `pg-ulysses` | txt | 1,516,383 | 19 | 19 | `sections` |
| `pg-heart-darkness` | txt | 210,375 | 4 | 4 | `heading-lines` |
| `pg-epub-pride-prejudice` | epub | 704,022 | 60 | 60 | `epub-spine` |
| `pg-epub-moby-dick` | epub | 1,209,550 | 137 | 140 | `epub-spine` |
| `pg-epub-sherlock` | epub | 579,536 | 12 | 12 | `epub-spine` |
| `se-pride-prejudice` | epub | 684,758 | 61 | 61 | `epub-spine` |
| `se-moby-dick` | epub | 1,212,865 | 5 | 141 | `epub-spine` |
| `se-frankenstein` | epub | 436,560 | 6 | 35 | `epub-spine` |
| `se-tale-two-cities` | epub | 755,831 | 2 | 50 | `epub-spine` |
| `se-alice` | epub | 144,311 | 2 | 14 | `epub-spine` |
| `se-art-of-war` | epub | 416,168 | 11 | 23 | `epub-spine` |
| `se-crime-punishment` | epub | 1,133,223 | 3 | 49 | `epub-spine` |
| `se-time-machine` | epub | 179,131 | 14 | 14 | `epub-spine` |
| `pdf-attention` | pdf | 37,212 | 7 | 22 | `pdf-outline` |
| `pdf-resnet` | pdf | 57,889 | 9 | 9 | `heading-lines` |
| `pdf-gpt3` | pdf | 234,311 | 16 | 32 | `pdf-outline` |
| `pdf-word2vec` | pdf | 37,767 | 7 | 19 | `pdf-outline` |
| `pdf-constitution` | pdf | 11,627,525 | 319 | 321 | `heading-lines` |
| `pdf-nist` | pdf | 1,396,286 | 9 | 323 | `pdf-outline` |
| `pdf-plos` | pdf | 37,776 | 4 | 4 | `heading-lines` |
| `web-wikipedia-whale` | html | 97,440 | 10 | 13 | `html-heading` |
| `web-gutenberg-html` | html | 718,268 | 61 | 61 | `html-heading` |
| `web-essay` | html | 66,887 | 2 | 2 | `heading-lines` |
| `web-sep-kant` | html | 129,099 | 7 | 22 | `html-heading` |

## Against the expected chapter count

| book | chapters | expected | note |
|---|---|---|---|
| `pg-sherlock` | 13 | 12 | twelve stories, plus one bare `I.` line the source prints beside the first story's title |
| `pg-epub-sherlock` | 12 | 12 | exactly the twelve |
| `pg-moby-dick` | 144 | 135 + 4 | 135 chapters plus Etymology, Extracts, Preface, Epilogue |
| `pg-epub-moby-dick` | 137 | 140 | Etymology, Extracts, 135 chapters, Epilogue; the front-matter markers are filtered |
| `se-moby-dick` | 5 | 5 | Dedication, Etymology, Extracts, the 135 chapters nested under "Moby Dick", Endnotes |
| `pg-war-peace` | 15 | 15 Books + 2 epilogues | the Books are the chapters; their chapters are children |
| `pg-tale-two-cities` | 11 | 3 Books + front matter | same shape |
| `pg-ulysses` | 19 | none (no marks) | labelled length parts, never invented titles |
| `pg-dracula` | 67 | 27 chapters + diary heads | the diary heads are real sections in this book's layout |
| `pg-metamorphosis` | 3 | 3 | the three parts |
| `pg-alice` | 13 | 12 + 1 | twelve chapters plus the prefatory poem |
| `pg-pride-prejudice` | 65 | 61 + 4 | 61 chapters, Preface, two volume half-titles, one publisher line that still leaks |
| `pdf-gpt3` | 16 | 7 + appendices | the appendices are lettered top-level sections |
| `pdf-attention` | 7 | 6 + Abstract | |
| `pdf-word2vec` | 7 | 7 | |
| `pdf-nist` | 9 | 6 + front matter | Introduction, The Fundamentals, The Controls, plus front matter |
| `web-wikipedia-whale` | 10 | 10 | the article's `h2` sections |
| `web-sep-kant` | 7 | 7 | the entry's `h2` sections |

`pdf-constitution` is the outlier at 319. Its `getOutline()` returns four
"Blank Page" entries, so it falls to heading lines on a 2,780-page volume whose
sections are printed as `SECTION 1.` under each Article, and those lines really
do look like chapter labels. Grouping them would need the Article headings
detected too, which the volume prints in a style the plain-text rules do not
separate from the body.

## What changed and why

One idea, applied per format: **trust the source's own structure first**.
Structured sources return an ordered block list plus chapter markers that point
at block indexes (`src/lib/blocks.ts`, `src/lib/block-chapters.ts`). Character
offsets are derived once (`src/lib/block-projection.ts`), so nothing searches the
prose for a title. Plain text keeps the regexes, gets a Gutenberg peel, and falls
back to labelled length parts.

### EPUB: the nav/NCX TOC is the outline

`pg-epub-sherlock` gives the twelve stories by their printed titles. A TOC
`#fragment` resolves to the block carrying that id, so chapters sharing one
spine file no longer land on the same place. `se-moby-dick` gives Etymology,
Extracts, the 135 chapters and the Epilogue.

When a TOC resolves to *fewer* markers than the book's own heading blocks it
loses: Project Gutenberg ships a per-paragraph NCX for Pride and Prejudice (516
`navPoint`s for 61 chapters), so the heading outline wins there.

### HTML: the page's own `h1`-`h6`

Region selection is `@mozilla/readability` (Apache-2.0) and the region is walked
into blocks, so a Wikipedia article or a Gutenberg HTML book gets chapters.
`web-gutenberg-html` drops the contents table Gutenberg prints as `<h2>` rows and
keeps the 61 real chapters.

### PDF: the embedded outline, resolved to blocks

Each outline destination resolves to the block on its page whose heading text
matches, so three entries sharing one page (arXiv does this) stay distinct.
Heading detection from layout stays conservative on purpose: a bare-title rule
was tried and turned a 5-entry outline into 27 on an arXiv paper, because table
cells and figure labels look like titles.

### Running heads and side-margin text

`measureBody` skipped drawing rules, so a rule can no longer join a header into
the body block; `markFurniture` marks a group that is always a page's own first
or last line on five or more pages and is set apart from the text; and a rotated
run that repeats across pages is furniture. On `pdf-nist`: the header went from
490 occurrences in the body to **0**, and the rotated DOI banner from 222 to
**0**. Prose is untouched — zero lost 10-word shingles in attention, gpt3,
word2vec, plos and resnet. The constitution loses only running heads, which were
being spliced into the middle of its sentences.

### Plain text

`pg-sherlock` reports the twelve stories. The extract used to keep the contents
page running on into the first body heading ("... XII. The Adventure of the
Copper Beeches" + "I. A SCANDAL IN BOHEMIA" became one paragraph); a change of
shape now ends the paragraph, and a block that names a chapter and has prose
under it is protected from the front-matter and contents-row passes.

The Gutenberg header and footer are stripped, including the banner that wraps
across two lines.

A printed contents page may only **confirm** the headings found in the body: it
is used when it names at least as many distinct chapters as the body does, so
`pg-moby-dick` reads its 135 body chapters instead of its 71-row contents page.
A leading contents page whose rows carry titles (`CHAPTER 1. Loomings.`) is
caught by its numbering: a contiguous 1..N run of stub rows that the body then
restarts is that table.

`pg-ulysses` gets 19 labelled length parts. The book prints no chapter marks;
its only capitalised headings are the newspaper headlines inside one episode.

### Chapter levels

The player shows the top level as "Chapters". A paper with numbered
sub-sections used to read as 32 chapters and a government report as 340.
Sub-sections are still there, one level down.

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
