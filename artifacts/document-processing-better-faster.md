# Document processing: better text, less wait

Investigation only. No product change in this pass.

**Verdict on the hypothesis.** Confirmed, with a sharper cause. Time-to-voice and time-to-`content.txt` are dominated by PDF text extraction, not Fish or remaster. The quality ceiling is the same place: `extractPDF` asks unpdf for `mergePages: true`, then `normalizeExtractedText` space-joins every remaining single newline. Speakable heading regexes are repairing damage that extract already threw away. Worker cold start is real but second-order next to that, and next to a silent failure / double-extract race.

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

## Quick wins vs larger bets

**Quick (days of careful code, not a new system)**

- Pin unpdf 1.8.1 in the app.
- PDF line unwrap + conservative dehyphenation (P0.1), behind fixtures.
- Extract single-flight + don’t clobber `ready` + surface Worker errors (P0.2).
- `asUint8Array` skip-copy when safe (P1.5).
- EPUB entity decode; MOBI reject at presign (P1.6–7).

**Larger**

- `x`/`y` column and gap reconstruction with a capped page loop (P1.4).
- Cross-page header/footer frequency (P1.3) — small once lines exist, fiddly to tune.
- Content-hash reuse (P2.8).
- Any OCR or commercial extract API (P2.12).

Do not add a second PDF engine in the same change as the unwrap. unpdf 1.8.1 is already on the Worker; the bug is how we call it and how `normalizeExtractedText` flattens the result.

---

## Do this next

1. **Pin unpdf ≥ 1.8.1 and replace PDF merge-and-flatten with a per-page line unwrap** (dehyphenate, paragraph breaks, join sentences across pages). Add fixtures so CI fails if newlines are collapsed again. This is the quality win and it removes wasted speakable/cue-tag work on one giant paragraph.
2. **Make extract single-flight and visible when it dies** (heartbeat or a stale window longer than a real parse; `waitUntil` must write `failed` or release the claim; success/fail updates must require `status = 'extracting'`). This is the speed win users feel on errors and on long PDFs.
3. **Drop repeated headers/footers using those per-page lines**, then only if two-column fixtures are still wrong, switch the PDF loop to `extractTextItems` (`x`/`y`) with a small page concurrency cap.

No PR in this pass. The unpdf skew is not a safe one-line flip: `mergePages: false` plus today’s “join lines with spaces” still glues each page, and joining pages with `\n\n` would pause mid-sentence at every page break.
