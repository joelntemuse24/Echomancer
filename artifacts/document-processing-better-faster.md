# Document processing: better text, less wait, plus a chapter outline and professional cues

Investigation only. No product change in this pass.

**Verdict on the extract hypothesis.** Confirmed. Time-to-voice and time-to-`content.txt` are dominated by PDF text extraction, not Fish or remaster. `extractPDF` asks unpdf for `mergePages: true`, then `normalizeExtractedText` space-joins every remaining single newline. Speakable heading regexes are repairing damage that extract already threw away. Worker cold start is second-order next to that, and next to a silent failure / double-extract race.

**Verdict on the two new goals.** A navigable outline is not a new parser. Chapter boundaries already exist inside `packSpeakableSections`, but only after a Whole-book freeze, only on the first audio window of each chapter, and the player never shows them. Reliable titles have to be emitted while extract still knows the EPUB spine or DOCX heading style — PDF/TXT stay heuristic until line unwrap lands. Fish already pauses after a heading (`[long-break]`) and still **speaks the heading words**. There is no allowlisted tag for “skip”, “year”, or “currency”. Scene-break asterisks are not treated as layout. Spoken forms for `$12.50` / `1998` must be a deterministic synth pass: the cue tagger fail-opens if any word changes.

---

## Current architecture

### What the user waits on

Voice **preview** does not wait. `src/app/dashboard/voice/page.tsx` starts `waitForUploadExtract` in the background and shows “Preparing text…”. Sample playback hits `/api/tts/preview` with no book text.

**Whole book / Live Stream job create does wait.** `POST /api/jobs` returns `TEXT_NOT_READY` (409) until `uploads.status = ready`. Continue on the voice page calls `waitForUploadExtract` again if the poll has not finished.

Cue tagging is **not** on this path. It runs once, later, on the VM, inside the first take-home claim (`buildAndPersistFrozenScript` → `tagFishCuesForSpeakable`). It gates freeze-to-synth, not voice pick.

### Stages (sync vs background)

| Step | Where | Blocks the HTTP response? | Typical role |
|---|---|---|---|
| `POST /api/pdf/upload` | Vercel | Yes, tiny | Session, rate limit, `uploads` row `pending`, R2 presign. No bytes, no parse. |
| Browser `PUT` | R2 (or `/api/pdf/upload/[id]/object` in dev) | User’s network | Full file. Ceiling 512 MB. |
| `POST /api/pdf/upload/[id]` complete | Vercel | Yes, until dispatch returns | HEAD the object (up to 3 × 80 ms). `markUploadUploaded`. `dispatchUploadExtract`. Does **not** download the file. |
| Worker `POST` | `workers/extract` | Vercel waits only for **202** | Auth + JSON, then `waitUntil(runExtract)`. Cold start sits in this 202. |
| `runExtract` | Worker `waitUntil` | No | Turso read, set `extracting`, **full R2 GET**, `extractTextFromDocument`, `toSpeakableText`, R2 PUT `content.txt`, Turso `ready`. |
| `GET /api/pdf/upload/[id]` | Vercel | Poll only | Every **1 s** (`EXTRACT_POLL_MS`). Re-nudge if `uploaded` ≥ 20 s or `extracting` ≥ 180 s (`claimUploadExtractNudge`). |
| First take-home claim | Oracle VM | Job, not upload | Download `content.txt` once, `toSpeakableText` again, optional cue-tag (40 s ceiling, 4-wide, ~3k-char chunks), `packSpeakableSections`, write `speakable.txt` + `sections.json`. Later ticks do not re-read the book. |

Fallback when `EXTRACT_WORKER_URL` is unset:

- Tests / local: `extractUploadedDocument` inline (`dispatchUploadExtract` → `"inline"`).
- Production, file ≤ 8 MB (`VERCEL_INLINE_EXTRACT_MAX_BYTES`): same function, **inside** the complete request (user waits on parse).
- Production, larger file: `after(() => extractUploadedDocument)` (`"vercel"`). `GET` re-nudges. Trigger `upload.extract` / `upload.drain` are no-ops (`src/trigger/extract-upload.ts`).

Both hosts call the same library path: `extractTextFromDocument` → `toSpeakableText({ normalizeTitles: false })` → `pdfs/<id>/content.txt`.

Paste (`POST /api/text/upload`) skips parsers and runs `toSpeakableText` only.

### Shared code vs host skew

| Concern | Shared? | Notes |
|---|---|---|
| Parsers | Yes | `src/lib/text-extraction.ts` |
| Speakable | Yes | `src/lib/tts/speakable-text.ts`, `normalize-speakable.ts` |
| unpdf version | **No** | App `package-lock.json` pins **1.4.0**. Worker lock resolves `^1.4.0` to **1.8.1**. |
| Failure handling | **No** | Vercel `extractUploadedDocument` writes `failed` on parse errors and **rethrows** storage misses. Worker `waitUntil` **only logs** thrown errors. Status stays `extracting`. |

`wrangler.toml`: `cpu_ms = 300000` (5 min CPU), `nodejs_compat`, R2 binding `BOOKS`. No Smart Placement, no cron, no memory override. Handler is POST-only (a keep-warm GET is a 405).

Doc drift: `TECHNICAL_DESIGN.md` still says EPUB goes through `epub2` and a temp file. Code uses JSZip in memory (`extractEPUB`). Trust the code.

### Where wall-clock actually goes

No stage timings are logged. From the code, the order for a normal PDF on the Worker is:

1. **Full-object R2 read** (`getObject` → `arrayBuffer()`). pdf.js then parses that buffer. Range GETs do not skip this for a typical non-linearized PDF (xref is at the end).
2. **pdf.js `getTextContent` on every page.** unpdf 1.4 and 1.8 both `Promise.all` **all pages at once**. That is one JS thread, so it does not speed CPU; it does hold every page’s text items at once.
3. `toSpeakableText` on the resulting string. Regexes, not a second download. Cheap next to pdf.js unless the string is pathologically glued (see below).
4. One R2 PUT of `content.txt` and two Turso writes.

`asUint8Array` always allocates a second copy of the file, even when the Worker already has a tight `Uint8Array`. A large PDF is therefore source bytes + copy + all page text items inside an isolate whose memory toml does not raise. An OOM or uncaught throw dies in `waitUntil`’s log line. The row stays `extracting` until the 180 s nudge, which can start a **second** full parse while a healthy first parse is still inside the 300 s CPU budget.

Voice-step poll (1 s) is not the extract bottleneck. It is extra Vercel/Turso reads. `ensureTtsJobColumns` is hot after the first call in an isolate.

Whole-book **text** prep after freeze: cue-tagger deadline is 40 s for the whole pass (`FISH_CUE_TAGGER_TIMEOUT_MS`), 12 s per chunk, parallelism 4, hard chunk 3800 chars. A novel-length speakable cannot finish every chunk inside 40 s; the rest fail open to untagged text. That is a synth-quality cap, not an extract cap. Glued paragraphs make it worse because `splitRangeBySize` then breaks on the last `. ` / space inside the window instead of a paragraph boundary.

---

## Quality failure modes (from code and tests)

### PDF — the main loss

`extractPDF` always calls `extractText(..., { mergePages: true })`.

- **unpdf 1.4.0** (Vercel fallback, tests, `npm` app): merged text is `pages.join("\n").replace(/\s+/g, " ")`. Every newline pdf.js emitted (`hasEOL`) is destroyed. Dehyphenation and “page number on its own line” in `normalizeExtractedText` never see a line.
- **unpdf 1.8.1** (Worker lock): `normalizeMergedText` keeps newlines. Better, and still not enough.

`normalizeExtractedText` then splits only on **blank** lines and joins the lines inside each block with spaces. pdf.js `hasEOL` is a visual line break, almost never a blank line. A whole chapter (often the whole book) becomes one paragraph. The Attention fixtures in `speakable-text.test.ts` are hand-built to look like that glue. Tests never run a multi-line PDF through unpdf, so this cannot regress in CI.

Consequences:

| Artifact | What the code does | What the narrator gets |
|---|---|---|
| Wrapped lines | Space-joined | One breath; chapter regexes must guess |
| End-of-line hyphens | `(\p{L})-\n(\p{L})` → delete hyphen, only if `\n` survived | Worker 1.8: `com-\nputer` → `computer`, but also `well-\nknown` → `wellknown`. Vercel 1.4: newline already gone, so `com- puter` or `com-puter` is spoken as-is |
| Soft hyphen U+00AD, ligatures ﬁ ﬂ | Not handled | Spoken junk or a stuck hyphen |
| Form feed `\f` | Stripped in the control-char pass (`\x0c`) before anyone can treat it as a page break | Page boundary signal deleted. `split-text.ts` knows about `\f`, but extract never leaves one |
| Page numbers | Only `^page N$`, `^page N of M$`, `^— N —$` on their own line | Bare `42`, `12 \| 340`, `Title 17` survive. `isLayoutNoiseBlock` in the packer catches some of these **later**, only if they are still their own paragraph — which extract usually prevented |
| Running headers / footers | No cross-page frequency check | “Chapter I / Author Name” repeated every page, in the prose |
| Footnote **bodies** | Markers `* ∗ † ‡ §` stripped in `normalizeSpeakableText`. Bodies kept | Bottom-of-page notes glued into the sentence they visually sat under |
| Two-column pages | Item order is pdf.js content order. `extractTextItems` in unpdf 1.8.1 exposes `x`/`y` and is unused | Columns interleave or read down the wrong column |
| Headings | `splitSectionHeadings` only breaks a known academic name, `Chapter\|Part\|Section` + number/roman/word, or a short numbered title, and only when the next char is a capital on the **same line** | “The Quay” as a chapter title stays fused. Roman `II` works only if it is already its own paragraph (`normalizeSpeakableText` then says `Chapter II`) |
| Scanned / image PDF | No OCR. Under 50 chars (`MIN_EXTRACTED_CHARS`) → failed with a clear message | Correct given the constraint. Empty text layer is a hard fail, not a silent skip |
| Cross-page sentences | Naive “join pages with `\n\n`” would fake a paragraph pause at every page | Do not “fix” glue by only flipping `mergePages` |

`toSpeakableText` then tries to recover academic structure. That layer is real and tested (Attention page 1 and the glued four-page string). It is the wrong layer to keep investing in for novels.

### Academic peel — false positives and negatives

`looksAcademicCover`: ≥2 emails, or 1 email plus an affiliation/conference phrase.

While that is true, **every non-heading paragraph before the first detected heading** goes through `extractCoverTitle` and does **not** set `seenBody`. A dissertation whose first body section is not named `Abstract` / `Introduction` / `Chapter N` gets affiliation phrases stripped out of real prose (“University of X” mid-sentence) until a heading regex hits.

False negatives: author lines without `∗†‡` footnote marks are kept (intentional, so “Need Ashish” is not eaten). Cover text with no email is not peeled. Good for novels; weak for email-less preprints.

`EQUAL_CONTRIBUTION_RE` is capped at 2000 chars. A long contribution note can leave a tail.

### DOCX

`mammoth.extractRawText` drops heading styles. “Chapter” structure exists only if the author typed the word. Lists and tables become flat text. Speed is fine; this is not the latency problem. Quality is “paragraphs yes, headings no”.

### EPUB

JSZip, spine order, `stripHtml`. Headings get a blank line after `</h1>`–`</h6>`, so they can become their own paragraph **if** the heading text is still a separate block after `normalizeExtractedText`.

Gaps:

- Numeric entities `&#\d+;` are **deleted**, not decoded. `&#8217;` disappears.
- Named entities other than amp/lt/gt/quot/apos/nbsp are left for the voice to spell (`&rsquo;`, `&mdash;`).
- Spine items that are the nav / toc / cover are read aloud. No href filter.
- Serial `async("string")` is in-memory zip, not a network loop. Not a speed problem.

### TXT / RTF / MOBI

- **TXT:** blank-line paragraphs are preserved; hard-wrapped lines inside them are space-joined. That is right for Project Gutenberg and wrong for poetry or a screenplay that uses single newlines on purpose.
- **RTF:** control-word regex. `\uN` unicode and `\'hh` hex escapes are not decoded. Fine for simple RTF, garbled for Word RTF.
- **MOBI/AZW:** `extractMOBI` needs `ebook-convert` and `child_process`. The Worker cannot do that, and production extract **is** the Worker. The presign route still accepts `.mobi` / `.azw` / `.azw3`. The user uploads the whole file, then extract fails with “convert to EPUB or PDF”. Fast failure at presign would be the speed win. A pure-JS KF8 parser is a later bet, not Calibre-on-Workers.

### Second speakable pass (intentional, cheap)

`content.txt` is already speakable (`normalizeTitles: false` at extract). Take-home and Live Stream run `toSpeakableText` again so old extracts stay safe, and so delivery settings can title-case ALL-CAPS when the user/adaptive flag says so. Idempotent by test. This is not why extract feels slow.

It does couple quality to delivery: `adaptDeliverySettings` treats `paragraphs <= 2 && chars > 500` as “glued” and forces title normalization. A novel that extract flattened looks like one paragraph, so later pacing (`denseAcademic`, seminar prefix) can be chosen from a lie.

### Cue-tagger (text-shaped only)

`packSpeakableSections` is chapter-aware **after** paragraphs exist. If extract produced one blob, the packer mid-splits on sentence/word (`splitOversizedParagraph`) and the cue tagger does the same inside 3800 chars. Restoring paragraphs is the document-side fix. Raising the 40 s tagger budget is a Fish/OpenRouter knob, not an extract fix.

---

## Speed bottlenecks (ranked by how often they add wall-clock)

1. **pdf.js text layer, full file in memory, all pages scheduled at once.** Dominant CPU. Unbounded `Promise.all` is a memory spike, not a speedup.
2. **Extra full-buffer copy** in `asUint8Array` on a path that already has a clean `Uint8Array` (Worker).
3. **Silent `waitUntil` failure + 180 s stale window.** User sits on “Preparing text…” with a dead row. Nudge then parses the book again. 180 s < 300 s CPU limit, so a **live** long extract can be duplicated. `fail` SQL in the Worker does not say `AND status != 'ready'`, so the late duplicate can mark a finished upload failed.
4. **Vercel inline extract ≤ 8 MB** when the Worker URL is missing. Parse blocks the complete request. Production with the Worker configured does not take this path.
5. **Worker cold start** on the 202 (pdf.js is a large bundle). Seconds, not the parse itself, and only after the isolate is idle. No keep-warm: the worker rejects non-POST.
6. **1 s poll.** Does not slow the Worker. Costs Vercel invocations for up to 30 min (`EXTRACT_TIMEOUT_MS`).
7. **Second `toSpeakableText` + cue tag** on the VM. After `ready`. Cue tag is capped at 40 s and often fail-opens the tail of a long book. Not the voice-step wait.
8. **Turso round-trips** (a handful per extract). Noise next to pdf.js.
9. **EPUB/DOCX/TXT CPU.** Small next to PDF.

There is no content-hash cache. Re-upload of the same bytes parses again. Worth doing after the parse itself is cheaper and single-flight, not before.

---

## Recommendations

Score is (impact × confidence) / effort. Impact means cleaner `content.txt` **and/or** less time until `ready` / until a failed extract is visible. Confidence is from the code paths above, not from production traces (there are no stage logs).

### P0

#### 1. Unwrap PDF lines; stop destroying them first

**Change.** In `extractPDF` / `normalizeExtractedText`:

- Pin **unpdf ≥ 1.8.1** in the app lockfile so Vercel fallback matches the Worker. 1.4.0’s `mergePages` replace is `\s+` → space.
- Do not call `mergePages: true` and then hope. Take the per-page string array (or, better, one self-owned page loop).
- Replace “join every single newline inside a blank-line block” with a line unwrap:
  - Drop obvious furniture **per page** before joining pages (page-number line, `— N —`).
  - Dehyphenate only when joining a line that ends in `-` to a following lowercase letter; keep the hyphen for `well-known` style (dictionary-free rule: keep the hyphen if both sides are ≥3 letters and the next line starts with a capital, or always keep it when the line-end hyphen is a hard hyphen followed by a capital). Start conservative: join `letter-\nlowercase` → one word, leave `letter-\nUppercase` hyphenated.
  - Start a new paragraph when the previous line ends with `.?!` and the next line looks like a heading or a new sentence **and** the previous line is short relative to the page’s median line length (wrapped prose usually does not end the visual line on a period).
  - Join a sentence **across** the page boundary when the last body line does not end a sentence, after the footer line is removed. Do not insert `\n\n` at every page.

**Why.** This is the glued-paragraph bug. Heading split, chapter pack, cue-tag chunking, and `adaptDeliverySettings` all assume `\n\n` means a paragraph.

**Effect.** Novels and papers get pauses and chapter boundaries without a heavier parser. Same CPU as today if this replaces the current merge + normalize, not a second pass. Cue-tag chunks stop splitting mid-sentence as often. Vercel and Worker stop disagreeing.

**Risk.** Over-breaking dialogue or poetry that already uses single newlines (TXT shares `normalizeExtractedText` — gate the new unwrap on PDF, leave TXT/EPUB/DOCX on the current blank-line join). Under-breaking lines that end with abbreviations (`Dr.`). Measure on a fixture set before shipping.

**Measure.** Fixtures: two-column-ish lines, running header, hyphenated line wrap, sentence split across a page, Gutenberg-style TXT (must not change). Metrics: paragraph count, fraction of lines that still contain `-\s`, count of repeated header strings in `content.txt`, wall time of `extractPDF` only.

#### 2. Single-flight extract, and stop hiding Worker crashes

**Change.**

- Give the extract a token (or compare-and-swap on `extract_started_at`) so a second `POST` no-ops while the first is inside the CPU budget. Set the re-nudge floor **above** a healthy long parse (today 180 s vs `cpu_ms` 300 s), or heartbeat `extract_started_at` from the Worker every ~30 s the way take-home heartbeats a lease.
- In `workers/extract` `waitUntil` catch: write `failed` for a definite parse error; for a storage miss, clear the claim so the next 1 s poll can retry, with a small attempt cap. Do not leave `extracting` for 180 s of silence.
- `UPDATE ... failed` and the success `UPDATE` must not clobber `status = 'ready'` from an older duplicate (`AND status = 'extracting'`).

**Why.** This is lost time the user can see (“Preparing text…” with no error) and double CPU on big PDFs.

**Effect.** Failed extracts show up on the next poll (~1 s) instead of +180 s. Large PDFs are parsed once.

**Risk.** A too-aggressive fail on a transient R2 404. Keep the rethrow/retry behavior the Vercel path already documents; just don’t wait 180 s and don’t fail a row that already became `ready`.

**Measure.** Count of `runExtract` starts per `uploadId` (should be 1). p50/p95 time from `extracting` to `ready` or `failed`. Alert on `extracting` older than the CPU limit.

### P1

#### 3. Running headers, footers, and page numbers from per-page lines

**Change.** After (1) yields a list of lines per page, drop a normalized line that appears on a large share of pages (same text, or same text plus a different integer). Drop lines that are only a number or `N | M`. Do this **before** cross-page unwrap so a footer is not glued into the last sentence.

**Why.** (1) fixes wrap. It does not remove “Author Name” on every page. `normalizeExtractedText`’s three regexes miss the common cases, and only when the line survived.

**Effect.** Less spoken furniture. Slightly shorter `char_count` (pricing and Fish spend follow `content.txt`).

**Risk.** A refrain or a one-line chapter title repeated in a short doc. Require the line on ≥30% of pages and ≥3 pages, and never drop a line that `isSpeakableHeading` would keep if it is long. Log dropped lines in dev.

**Measure.** Repeated-line rate in `content.txt` on a 50-page novel fixture. Zero drops on a 2-page doc.

#### 4. Use `x`/`y` for lines, gaps, and columns (still unpdf, no new vendor)

**Change.** On the Worker’s unpdf 1.8.1, `extractTextItems` already returns `x`, `y`, `fontSize`, `hasEOL`. Cluster items into lines by `y`, sort by `x`, split columns when `x` gaps are large, start a paragraph on a `y` gap bigger than the median line gap or on a font-size jump (heading). One pass. Replaces `extractText` + string unwrap for PDF. Cap in-flight pages (about 4) in **our** loop; do not use unpdf’s all-pages `Promise.all`.

**Why.** Two-column papers and “heading is just bigger type” will not fall out of newline heuristics. Capping concurrency is the memory/speed half of the same change.

**Effect.** Best text-layer quality available without OCR. Lower peak memory on long PDFs; wall-clock similar or better (less GC), not magically parallel (Workers JS is one thread).

**Risk.** Rotated pages, RTL `dir`, multi-column footnotes. Keep the line-unwrap from (1) as the fallback when items are missing. Ship (1) first so a bad clusterer cannot be the only path.

**Measure.** Reading-order check on one two-column fixture (left column text before right). Peak: pages in flight. Time-to-`ready` on a ~300-page text PDF before/after the cap.

#### 5. Skip the useless byte copy; log stages

**Change.** `asUint8Array`: if `byteOffset === 0` and the view is not a Node `Buffer` with a hostile `.buffer`, return it. Worker `runExtract`: one log line with `bytes`, `pages`, `downloadMs`, `parseMs`, `speakableMs`, `chars`.

**Why.** The copy is pure overhead and an OOM contributor. You cannot rank further speed work without the log line.

**Effect.** Tens of MB less RAM per PDF. No text change.

**Risk.** The Buffer `byteOffset` bug the helper exists for. Keep the copy for `Buffer` and for any view whose `byteOffset !== 0`. There is already a test for the sliced Buffer case.

**Measure.** That test stays green. Worker log present on one real upload.

#### 6. EPUB entities + skip nav/cover; DOCX heading styles

**Change.**

- `stripHtml`: decode numeric and the common named entities; stop deleting `&#8217;`.
- Skip spine documents whose href or manifest id matches `nav`, `toc`, `cover`, `titlepage` when another spine item exists.
- DOCX: `mammoth.convertToHtml` (or a style map) and turn `h1`–`h3` into their own paragraphs so `isChapterHeading` / the packer can see them. Still no Calibre.

**Why.** These formats are already fast. The bugs are deterministic and local. PDF work does not fix them.

**Effect.** Apostrophes and headings survive. TOC is not read as chapter one.

**Risk.** A book whose only spine item is mis-labeled `nav`. Only skip when a non-nav item remains. HTML conversion must not pull mammoth into the client bundle (it is already server-only).

**Measure.** Extend the existing EPUB zip test with `&#8217;` and a nav document. A docx fixture with a Heading 1 (mammoth can build one, or check in a tiny generated docx).

#### 7. Fail MOBI at presign when extract is the Worker

**Change.** If `isExtractWorkerConfigured()` (or always, since Calibre is not on Vercel either), reject `.mobi` / `.azw*` in `POST /api/pdf/upload` with the same “convert to EPUB or PDF” message. Leave the Calibre function for local/dev if you want, but don’t make the user PUT a book first.

**Why.** Production cannot succeed. The wait is the upload, then a guaranteed fail.

**Effect.** Immediate error. No R2 PUT, no Worker.

**Risk.** Someone running Calibre on a non-Worker dev box loses presign. Gate the reject on production / Worker configured.

**Measure.** Upload route test: mobi → 400, no row, or row not left `pending` forever.

### P2 — later bets

#### 8. Same-bytes cache

SHA-256 (or R2 ETag) of `source.*` on the upload row. If this user already has a `ready` upload with that hash, copy `content.txt` and mark ready. Do this **after** (1), or you will cache glued text. Privacy: same `user_id` only.

#### 9. Keep-warm, not Smart Placement

A `GET` health that does not boot pdf.js, plus a 5-minute cron, trims cold start on the 202. Smart Placement does little: the heavy work is CPU after an R2 binding read; Turso is a few small queries. Placement will not move pdf.js.

#### 10. Poll backoff

1 s, then 2 s, cap ~5 s, and back off harder while `preparing`. Saves Vercel calls. Adds at most a few seconds after `ready`. Do not do this instead of (2).

#### 11. Narrow the academic peel

Only peel paragraphs that still look like cover (emails, footnote-marked names, affiliation lines), not every paragraph until the first heading. Stops “University of X” being stripped from a preface. Small, but easy to overfit to the Attention fixtures — add a novel-with-a-copyright-email fixture that must keep paragraph two verbatim.

#### 12. Scanned PDFs (optional, costed)

Not a default. A WASM OCR pass on the Worker will burn the 300 s CPU budget and the isolate memory cap on a phone scan of a book. If you offer it later: client-side OCR before PUT (user’s CPU, you store text), or a paid Document AI call per page with a hard page cap and a price line. Do not block the text-layer path on it. Image-only PDFs should keep failing fast with the current copy.

#### 13. RTF unicode / poetry TXT

Only if uploads show up. RTF `\u` and `\'hh` decoding is a small pure function. A “keep single newlines” mode for TXT is a product choice (poetry vs Gutenberg), not a parser bug.

---

## Chapter / section outline

### What already exists

| Layer | What it knows | When it exists | Who sees it |
|---|---|---|---|
| `toSpeakableText` / `isSpeakableHeading` | Academic names (`Abstract` … `Appendix`), `Chapter\|Part\|Section` + number/roman/word, short numbered titles, lone Roman lines (later spoken as `Chapter II`), ALL-CAPS lines | Inside `content.txt` only if the heading survived as its own paragraph | Nobody as a list. The words are in the flat text |
| `isChapterHeading` | Those, plus a short all-caps title (≤ 60 chars, 1–8 words) | Used at pack time | Not stored on the upload |
| `packSpeakableSections` | A heading starts a new frozen section. `chapterIndex` increments. `chapterTitle` is set on **that first window only**. Later windows of the same chapter store `chapterTitle: null` (`split-text.ts` continuation `startOpen(..., null)`) | `audiobooks/<jobId>/sections.json` on the **first take-home claim**, after cue-tag | Operator markup (`ECHO_OPERATOR_TOOLS`, `fish-markup.ts`) prints `chapterTitle`. `serializeJob` does not. The player “Sections” list is `01 · Section ready` (`player/[id]/page.tsx`) |
| EPUB spine | Real document order, already walked in `extractEPUB` | Thrown away. Chapters are concatenated with `\n\n` | Lost |
| DOCX heading styles | In the file | `mammoth.extractRawText` drops them | Lost |
| PDF outline / bookmarks | Often present in the file | unpdf text extract never reads the outline tree | Lost |

Front/back matter the user named is **not** in `SECTION_HEADING_NAMES`. `Foreword`, `Preface`, `Prologue`, `Epilogue`, `Coda`, `Afterword`, `Notes` are ordinary paragraphs unless they happen to match `Chapter N` or all-caps. `Acknowledgements?` is in the academic list. A paragraph that is only `***` is not layout noise (`isLayoutNoiseBlock` drops `---`, page numbers, and form-feed, not asterisks), so it can be spoken.

`content.txt` has no offsets. The upload poll returns `charCount` and `paragraphCount` on the in-process path only (`toUploadPublicView`); the Worker ready-row does not even return paragraph count. Nothing returns a chapter list.

### What “view chapters” needs

Detect → store at **extract**, not at TTS freeze. The voice step is the first moment the user is looking at the book, and voice pick must stay unblocked. Waiting for `sections.json` means no outline until Whole book has been claimed, and stream jobs never get that file’s chapter titles on screen.

**Store** `pdfs/<uploadId>/chapters.json` in the same `runExtract` / `extractUploadedDocument` that writes `content.txt` (one small PUT, text already in memory):

```json
{
  "version": 1,
  "source": "epub-spine",
  "chapters": [
    { "index": 0, "title": "Foreword", "level": 1, "charStart": 0, "charEnd": 1840 }
  ]
}
```

`source` is `epub-spine` | `docx-heading` | `pdf-outline` | `heading-lines` | `none`. Offsets are into the stored speakable `content.txt` so a later pack can map a chapter to a section without re-parsing the PDF.

Optional Turso column `chapter_count` on `uploads` (additive migrate) so the 1 s poll can say “12 chapters” without downloading the JSON. Full list loads once when the outline opens.

Do **not** put the outline only on the job. Copy or derive a playback map at freeze: `{ title, charStart, firstSectionIndex }` from `chapters.json` + `sections.json`, and return that compact list from `serializeJob`. The player already seeks by segment index, not by character.

### How each format emits boundaries

| Format | Reliable signal | Work | Speed |
|---|---|---|---|
| EPUB | Spine item boundaries we already iterate. Title = first `h1`/`h2`, else the previous heading, else a short first line, else `Chapter N`. Record `charStart` as we append to the joined string, **then** run speakable normalize and shift offsets (or normalize per chapter and sum lengths) | Small, in `extractEPUB` | No extra download. Same zip pass |
| DOCX | Mammoth HTML or a style map: `h1`–`h3` become chapters, body stays paragraphs. `extractRawText` cannot do this | Small, swap the mammoth call | Mammoth is already the cost |
| PDF | Prefer the PDF outline/bookmark tree if unpdf/pdf.js exposes it (`getOutline`) — titles + dest page, then map page → char after the per-page extract. Else heading lines from the line unwrap (P0.1): `Chapter`, `Part`, front/back matter names, short all-caps. Mark `source: "heading-lines"` | Outline read is cheap next to `getTextContent`. Heuristic titles are only as good as the unwrap | Do not add a second full parse |
| TXT | Same heading-line rules. Gutenberg “Chapter N” works once it is its own paragraph (it usually already is) | Tiny | Negligible |
| Paste | Same heading-line scan on the speakable string | Tiny | Negligible |

If nothing matches, store one chapter whose title is the filename. Do not invent a chapter per paragraph, and do not call a model to guess titles.

Expand the heading list used for **both** the outline and `isSpeakableHeading`: `Foreword`, `Preface`, `Prologue`, `Introduction` (already academic), `Epilogue`, `Afterword`, `Coda`, `Notes`, `Endnotes`. Keep the match line-bounded and short (the existing `< 80` char guard) so a sentence that starts with “Notes on the treaty…” is not a chapter. Level 2 (`1.2`, `h2`) can be stored and indented; the first UI can show level 1 only.

### UX

- **Voice page, after `ready`.** A quiet list under the existing “Preparing text…” line: Foreword, Chapter 1, …. Not a gate. Preview and narrator choice stay as they are. Empty/`none` source: hide the list rather than show one fake row of the whole book, or show the single filename chapter without calling it a table of contents.
- **Player.** Replace “Section ready” with the chapter title for the section’s `chapterIndex`. Clicking a chapter sets `segmentIndex` to `firstSectionIndex` once that segment is ready (same button path as today). While generating, the row can still say the title plus “Generating…”.
- **Library / queue.** `chapter_count` on the book row is enough. Do not fetch `chapters.json` for every card.

Operator markup already shows `chapterTitle` and can stay the debug view.

### Speed

Linear scan of text already extracted, plus one R2 PUT of a few kilobytes. EPUB/DOCX titles fall out of the parse we already do. PDF bookmarks are one pdf.js call beside `getTextContent`, not a second download. No cue-tagger, no Turso write per chapter. The outline appears when extract flips to `ready`, which is the same moment voice can start a job.

### Ranked plan (outline)

**P0 — Persist heading boundaries at extract.** EPUB spine + DOCX heading styles + TXT/PDF heading lines → `chapters.json`. Widen the front/back-matter names. Show the list on the voice page when the upload poll says ready. This is the user-visible feature. It is weak on PDF until the line unwrap (extract P0.1) or bookmark read lands; ship EPUB/DOCX/TXT first if you want a vertical slice that is already trustworthy.

**P0 — PDF bookmarks, then heading lines.** `getOutline` when the file has one (`source: "pdf-outline"`). Heading-line fallback only after unwrap, flagged `heading-lines` so the UI can stay quiet when confidence is low (for example fewer than two hits, or hits that are mostly `Abstract`/`References` on a paper).

**P1 — Player seek by chapter.** At freeze, map `charStart` → first `FrozenSection.index`. Add the compact list to `serializeJob`. Group the existing section drawer by `chapterTitle` instead of `01 · Section ready`. Continuation sections keep `chapterIndex` but should also keep `chapterTitle` (stop passing `null` in `startOpen`) so a refresh does not depend on scanning backward.

**P1 — Do not block extract on the outline.** If chapter detection throws, still write `content.txt` and `ready`. Outline failure is `source: "none"`, not `EXTRACTION_FAILED`.

**P2 — In-player “you are here”.** Highlight the chapter whose `charStart` contains the playing section. Needs the playback map, not a new parser.

---

## Structure and numeric Fish cues

### What Fish will actually honor

Allowlist in `src/lib/tts/fish-s2-cues.ts` (comment points at Fish’s emotion docs). Whole-book sanitize drops anything else, and drops the **whole chunk** if the prose fingerprint changes (`sanitizeFishS2TaggedText`).

| Kind | Allowed today | Not allowed (do not invent) |
|---|---|---|
| Pause | `[break]`, `[long-break]` | `[pause]`, SSML `<break>`, S1 `(break)` |
| Delivery | `[conversational seminar tone]` | A “heading voice” or “narrator” tag |
| Tone that can mark a label | `[soft tone]`, `[whispering]`, `[calm]`, `[emphasis]` | `[announce]`, `[aside]`, `[skip]` |
| Emotion / effect | The long emotion list, intensity `slightly\|very\|extremely`, laughs/sighs | Celebrity impressions, free-form stage directions |

`s2.1-pro-free` reads those square brackets. Edge / Google keep `[break]` / `[long-break]` only (`stripNonPauseFishCues`). OpenRouter / Gemini / Grok stay untagged so they do not speak the words.

There is **no** tag that means “say this as a year” or “say this as money”. A spoken form is a word change. The cue tagger is required to fail open on word changes. So `$12.50` → “twelve dollars and fifty cents” cannot be an LLM edit.

### What the pipeline does now

`toFishNarrationScript` (synth time, after the tagger): if `isSpeakableHeading`, output is `Heading words` + newline + `[long-break]`. The heading is spoken in the same voice as the body, then a long pause. Body paragraphs get `[long-break]` between them. That is pause structure, not a different delivery.

The OpenRouter tagger (`fishCueTaggerSystemPrompt`) is told to insert sparse emotion/tone tags and **not change words**. It is not told that a heading, a coda label, or `***` is special. It runs on the flat speakable **before** packing, so a glued heading is invisible to it.

`***`, `* * *`, `###` are not stripped. Footnote glyphs `*∗†‡§` on words are stripped in `normalizeSpeakableText`. A scene-break line of asterisks is left to be read.

Digits are untouched. Fish will often read `1998` as a cardinal (“one thousand nine hundred ninety-eight”) and `$12.50` as “dollar twelve point five zero” or similar. `decideLongSentenceCommaBreak` already refuses to break `1,998`-style digit commas. That is the only numeric special case.

### Ranked plan (cues)

**P0 — Deterministic structure at synth, not a new model call.** Extend the pass that already knows headings (`toFishNarrationScript` / `narrationScriptForSynthesis`), Fish only for non-pause tags:

- Heading or front/back-matter line → `[soft tone]` (allowlisted) immediately before the title, then the existing `[long-break]`. Edge/Google keep the long break and drop `[soft tone]`, so they still pause without speaking a tag.
- A paragraph that is only scene-break glyphs (`*`, `#`, `•`, `·`, spaced asterisks) → drop the glyphs in `isLayoutNoiseBlock` / speakable normalize so they never enter `content.txt`, the tagger, or the outline. The surrounding paragraphs already get `[long-break]`. `---` is already dropped; asterisks should match that.
- One prompt line on the existing tagger: do not put emotion tags on a paragraph that is only a chapter or section title; keep any `[soft tone]` / `[break]` / `[long-break]` already present. Sanitize stays. If the model rewrites, that chunk fail-opens as today.

This does not add a Fish round trip and does not slow extract.

**P0 — Spoken form for money and years, also deterministic, also at synth.** Run a small expander inside `narrationScriptForSynthesis` **before** Fish sees the string, **after** the cue tagger has snapshotted the prose. Then the fingerprint still matches `content.txt` / `sections.json`, and the outline still shows `$12.50` and `1998`.

- Money: `$12.50`, `$12`, `USD 12.50`, `£12.50`, `€12.50` → “12 dollars and 50 cents” / “12 pounds and 50 cents” / “12 euros and 50 cents” (words for the amount when it is small enough to say cleanly; leave a long figure as digits if you are unsure). Idempotent.
- Years: a 4-digit token from 1000–2099 only with a local cue (`in`, `since`, `by`, `during`, `until`, a month name, or the token standing as its own short heading). Say “nineteen ninety-eight”, not “one thousand…”. Leave `1998` inside a longer digit run, an ISBN-like string, or a page range.
- Fail open **per token**: if the pattern is ambiguous, keep the original characters. Do not send the sentence to DeepSeek to “fix pronunciation”.

**P1 — Same heading list as the outline.** `isSpeakableHeading` should recognize Foreword / Coda / Notes (short line only) so the synth pass and `chapters.json` agree. A heading the outline shows is a heading Fish treats with `[soft tone]` + `[long-break]`.

**P1 — Do not ask the tagger to expand numbers.** A prompt that says “rewrite $12.50 as words” will fail `proseFingerprint` and discard every other cue in that chunk. Spoken form stays in the deterministic pass.

**P2 — More tokens, still rules.** Percentages, ordinals (`21st` → “twenty-first”), ranges (`1998–2001`), and `No.` / `Fig.` abbreviations. Each needs a fixture and a leave-it-alone case. Not part of the first ship.

### Speed

All of this is string work on text already loaded for synth or already in the extract buffer. Scene-break dropping during extract is one regex on paragraphs, not a new network hop. The cue tagger’s 40 s ceiling is unchanged. Voice pick stays on the extract poll, not on this pass.

---

## Quick wins vs larger bets

**Quick (days of careful code, not a new system)**

- Pin unpdf 1.8.1 in the app.
- PDF line unwrap + conservative dehyphenation (extract P0.1), behind fixtures.
- Extract single-flight + don’t clobber `ready` + surface Worker errors (extract P0.2).
- EPUB spine titles + DOCX heading styles → `chapters.json` (outline P0). TXT heading lines in the same pass.
- Scene-break glyph drop (same class as today’s `---`) and `[soft tone]` + existing `[long-break]` on heading lines at synth (cue P0).
- `asUint8Array` skip-copy when safe. EPUB entity decode. MOBI reject at presign.

**Larger**

- PDF bookmark outline, then `x`/`y` columns.
- Player chapter seek (`firstSectionIndex` on the job payload).
- Money/year spoken-form rules with leave-it-alone fixtures (cue P0, but easy to get wrong — ship after the heading cue, with tests).
- Cross-page header/footer frequency. Content-hash reuse. Any OCR or paid extract API.

Do not add a second PDF engine in the same change as the unwrap. unpdf 1.8.1 is already on the Worker; the bug is how we call it and how `normalizeExtractedText` flattens the result. Do not ask DeepSeek to rewrite `$12.50` or to skip a chapter title: the allowlist has no such tag, and a word change throws away the chunk.

---

## Do this next

1. **Restore real paragraphs and heading lines in extract** (pin unpdf ≥ 1.8.1, per-page unwrap, dehyphenate, don’t pause mid-sentence at a page break). This is the quality/speed fix, and it is what makes a PDF outline and a heading cue true instead of a guess. Add fixtures so CI fails if newlines collapse again.
2. **Write `chapters.json` in that same extract pass and show it.** EPUB spine and DOCX headings first (reliable), TXT/PDF heading lines next, PDF bookmarks when present. Voice page lists Foreword / Chapter 1 / Coda when the upload is ready, without blocking narrator choice. Map those offsets to player sections only after freeze.
3. **Treat non-prose at synth with the tags Fish already allows.** Drop `***`-style scene breaks the way `---` is already dropped. Speak headings (including Coda / Foreword once they count as headings) with `[soft tone]` and the existing `[long-break]`, Fish only. Expand `$12.50` and clear year tokens in that same deterministic pass, after the cue tagger’s fingerprint, leaving ambiguous numbers alone. Keep the OpenRouter tagger fail-open; add one prompt line so it does not emotion-tag a title line.

Single-flight extract (don’t double-parse, don’t hide a Worker crash for 180 s) is the next speed fix under these three. It does not change the text.

No PR in this pass. Flipping `mergePages` alone still glues each page or cuts a sentence at every page. A chapter list or a new Fish tag on top of that glue would ship the wrong outline and the wrong pauses.
