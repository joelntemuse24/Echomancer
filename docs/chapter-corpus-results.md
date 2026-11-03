# Chapter-detection corpus results

Run with `scripts/fetch-corpus.sh` then
`npx tsx --tsconfig tsconfig.json scripts/chapter-corpus.ts`.

Every source is public domain or freely licensed; nothing is committed. The
script and manifest are.

## Results

| id | fmt | chars | first-choice source | chapters (main) | chapters (now) | warnings |
|---|---|---|---|---|---|---|
| `pg-pride-prejudice` | txt | 721,296 | heading-lines | 71 | 66 | — |
| `pg-moby-dick` | txt | 1,218,148 | printed-toc | 71 | 71 | — |
| `pg-sherlock` | txt | 581,105 | heading-lines | 21 | 5 | — |
| `pg-frankenstein` | txt | 419,667 | heading-lines | 25 | 25 | CONTENTS_ROWS:25 |
| `pg-tale-two-cities` | txt | 757,298 | heading-lines | 100 | 96 | DUPLICATE:book the second--the golden th |
| `pg-alice` | txt | 143,928 | heading-lines | 14 | 14 | — |
| `pg-war-peace` | txt | 3,224,636 | heading-lines | 395 | 390 | DUPLICATE:book twelve · chapter i |
| `pg-dracula` | txt | 840,029 | heading-lines | 73 | 51 | DUPLICATE:mina murray’s journal |
| `pg-dorian-gray` | txt | 429,538 | heading-lines | 21 | 21 | — |
| `pg-metamorphosis` | txt | 118,679 | heading-lines | 3 | 3 | — |
| `pg-ulysses` | txt | 1,516,439 | heading-lines | 9 | 2 | — |
| `pg-heart-darkness` | txt | 210,457 | heading-lines | 7 | 6 | DUPLICATE:chapter ii |
| `pg-epub-pride-prejudice` | epub | 735,050 | heading-lines | 93 | 88 | DUPLICATE:preface. FRONT_MATTER:TOOKS COURT, CHANCERY LANE, LO |
| `pg-epub-moby-dick` | epub | 1,236,500 | epub-spine | 139 | 139 | — |
| `pg-epub-sherlock` | epub | 580,046 | epub-spine | 12 | 12 | — |
| `se-pride-prejudice` | epub | 685,851 | heading-lines | 57 | 57 | — |
| `se-moby-dick` | epub | 1,217,462 | epub-spine | 7 | 7 | DUPLICATE:moby dick |
| `se-frankenstein` | epub | 437,817 | epub-spine | 7 | 7 | — |
| `se-tale-two-cities` | epub | 757,319 | epub-spine | 5 | 5 | — |
| `se-alice` | epub | 144,837 | epub-spine | 4 | 4 | — |
| `se-art-of-war` | epub | 416,806 | heading-lines | 16 | 16 | DUPLICATE:preface |
| `se-crime-punishment` | epub | 1,133,822 | heading-lines | 44 | 44 | DUPLICATE:part ii · chapter ii MERGED:Part I · Chapter II |
| `se-time-machine` | epub | 179,303 | heading-lines | 10 | 10 | — |
| `pdf-attention` | pdf | 37,210 | pdf-outline | 5 | 5 | — |
| `pdf-resnet` | pdf | 57,886 | heading-lines | 9 | 8 | — |
| `pdf-gpt3` | pdf | 234,317 | pdf-outline | 13 | 13 | — |
| `pdf-word2vec` | pdf | 37,814 | pdf-outline | 7 | 7 | — |
| `pdf-constitution` | pdf | 11,716,282 | printed-toc | 31 | 31 | DUPLICATE:section 2—enforcement |
| `pdf-nist` | pdf | 1,501,574 | pdf-outline | 3 | 3 | — |
| `pdf-plos` | pdf | 37,776 | heading-lines | 4 | 4 | — |
| `web-wikipedia-whale` | html | 95,755 | none | 0 | 0 | NO_CHAPTERS |
| `web-gutenberg-html` | html | 718,103 | heading-lines | 74 | 69 | DUPLICATE:chiswick press:—charles whitti FRONT_MATTER:TOOKS COURT, CHANCERY LANE, LO |
| `web-essay` | html | 66,699 | heading-lines | 3 | 2 | — |
| `web-sep-kant` | html | 146,092 | heading-lines | 3 | 2 | — |

`—` means the measurement did not run on that revision. Warnings are the
runner's own heuristics (`scripts/chapter-corpus.ts`), not failures.

## What the corpus found

### Fixed here

**Prose mistaken for a heading.** `isSpeakableHeading` accepted any line
beginning with "chapter", "part" or "section", so running prose such as
"part of the foot-board of the bed and a line of the wall, but no" and
"chapter of sounds. Yet, for all his hardy sobriety and fortitude" became
chapters. Moby-Dick gained 12 such junk entries. A label followed by a
lowercase continuation of four or more words is now prose, not a heading.
Fixed in `src/lib/tts/speakable-text.ts` (`labelRunsOnAsProse`), with a
regression test.

### Found, not fixed — reported for triage

**A body chapter heading can be dropped before detection.** Sherlock Holmes'
extract contains `I. A SCANDAL IN BOHEMIA` at character 1381, but the speakable
text contains only the contents row `I. A Scandal in Bohemia` at block 7 — the
body heading is gone. That is why the book reports 5 "chapters" (all from the
Project Gutenberg licence) instead of 12. Confirmed present on `main` too; the
earlier count of 21 on main was an accident of sentence fragments plus uppercase
lines, not real detection. This is a `toSpeakableText` retention bug, not a
detection bug, and deserves its own fix.

**Moby-Dick's printed contents replaces a fuller heading list.** The `.txt`
path resolves to `printed-toc` with 71 entries where `chaptersFromHeadingLines`
finds 135 real chapters. The selection prefers the printed tree on `rich` even
when it covers far less of the book. A guarded comparison was written and
reverted because it regressed eight existing tests; it needs its own analysis.

**Ulysses has no chapter markings** and previously produced 9 junk "chapters"
("Part. The moment is now…", the Gutenberg trailer). It now produces 2 pieces of
junk. The honest answer is `none`; the Gutenberg trailer should be stripped
before detection.

**`web-wikipedia-whale` yields no chapters.** A Wikipedia article has `h2`/`h3`
headings, but `htmlToArticle` drops every heading level, so the URL path falls
back to prose heuristics and finds nothing. This is the HTML-heading gap already
noted in `docs/audit-canonical-format.md`.

**Contents rows still leak on some paths** — `pg-frankenstein` flags
`CONTENTS_ROWS`, `pdf-constitution` flags a duplicate `section. 1.`,
`web-gutenberg-html` keeps the printer's imprint line.

## Corpus coverage

34 sources across: Gutenberg plain text (12), Gutenberg EPUB (3), Standard
Ebooks EPUB (8), arXiv/government/open-access PDF (7), and web pages (4).
Structural variety: parts and volumes (War and Peace, Tale of Two Cities, Crime
and Punishment), roman-numeral chapters (Sherlock Holmes, Moby-Dick extracts),
unnumbered chapters (Time Machine, Heart of Darkness, Ulysses), prefaces and
appendices (Frankenstein letters, Crime and Punishment epilogue, arXiv
appendices), and drop caps (Alice, Frankenstein).
