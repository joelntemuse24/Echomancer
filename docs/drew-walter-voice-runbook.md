# Drew and Walter on the shared Kokoro CPU app

Two changes shipped together:

- **Drew** is a new narrator and the app's **default** for new books. It is a
  fine-tuned Kokoro-82M (StyleTTS2) with **its own full kmodel weights** and
  its own voice pack. It replaces **Andrew** (Edge `en-US-AndrewNeural`).
- **Sowell is renamed Walter.** Only the listed name changed. The catalog id is
  still `sowell`, stored books are untouched, and the committed sample is still
  `public/voice-previews/sowell.mp3`.

Both live on the existing `echomancer-sowell` Modal app next to George. The S2
clone GPU app (`echomancer-s2-clone`) is not involved and must not be touched.

## Drew's weights are private and are not in the image

The repository is public. The two files are uploaded to a Modal **Volume**, not
baked into the Docker image and not committed.

| What | Volume | Path inside the volume |
|---|---|---|
| kmodel (313 MB, `KModel(model=path)` state dict) | `andrew-distill` | `/kokoro/retrain_v3/stageA/step00900_kmodel.pth` |
| voice pack (`.pt`, shape `(510, 1, 256)`, float32) | `andrew-distill` | `/kokoro/retrain_v3/stageA/step00900_voice.pt` |

The app mounts that volume at **`/andrew-distill`**, so the container reads:

```
/andrew-distill/kokoro/retrain_v3/stageA/step00900_kmodel.pth
/andrew-distill/kokoro/retrain_v3/stageA/step00900_voice.pt
```

Both are overridable. `DREW_VOLUME_NAME` (default `andrew-distill`) and
`DREW_VOLUME_MOUNT` (default `/andrew-distill`) name the volume and mount;
`DREW_KMODEL_RELATIVE_PATH` and `DREW_VOICE_RELATIVE_PATH` move the files
inside it. `scripts/sowell/drew.py` is the one place those defaults live, and
`DREW_KMODEL_PATH` / `DREW_VOICE_PACK_PATH` in `src/lib/tts/drew-voice.ts`
mirror them for documentation and for the rollout checklist.

Upload (from a machine with the Modal CLI and the files):

```bash
# 1. Create the volume once. `create_if_missing=True` in the app does this too.
modal volume create andrew-distill

# 2. Put each file at the documented path. `modal volume put` creates the
#    intermediate directories, so one call per file is enough.
modal volume put andrew-distill /local/path/step00900_kmodel.pth \
  /kokoro/retrain_v3/stageA/step00900_kmodel.pth
modal volume put andrew-distill /local/path/step00900_voice.pt \
  /kokoro/retrain_v3/stageA/step00900_voice.pt

# 3. Confirm the layout before deploying.
modal volume ls andrew-distill /kokoro/retrain_v3/stageA
```

`scripts/sowell/drew.py` checks the layout at load time: the voice pack must be
a float32 `(510, 1, 256)` tensor with no non-finite values, and the kmodel must
load through `KModel(model=...)`. A wrong or partial upload fails the load with
`DrewPackError`; it does not silently produce audio that is not Drew.

**Missing volume is not fatal to the app.** A container without the volume
still serves Walter and George. Only Drew answers `503 DREW_UNAVAILABLE`, and
the Next.js route with `DREW_ENABLED` unset hides the card entirely.

## Memory

Walter and George share one stock Kokoro kmodel (about 330 MB). Drew is a
**second** kmodel of its own, so the container ceiling moved **4 GB → 6 GB**
(`memory=6144` in `modal/sowell_worker.py`). That is per container and does
not change with the lane count: sixteen lanes are sixteen containers of the
same size. CPU (2), `min_containers` (0) and `@modal.concurrent(max_inputs=1)`
are unchanged.

`max_containers` is **16** by default and `scaledown_window` is **5 s**
(clamped to Modal's 2..1200). The measured book was 15.7k characters: 16
lanes × 700-char sections finished it in 47 s against 74 s for 6 lanes ×
1.4k. The idle tail then dominated the cost, so a short idle keeps the total
about equal while the book finishes sooner. `SOWELL_MAX_CONTAINERS` is read
at deploy time and clamped to 1..16, so a production deploy can lower it for
a smaller fleet.

## Sections

Kokoro-CPU books (Drew, Walter, George) pack at `KOKORO_CPU_SECTION_CHARS`
(**default 700**, clamped 300..2000) with a 400-character opening and a
550-character second section. One section is one container call, so a shorter
section means a shorter tail: ~30 s of audio and 8-15 s of wall per section
against ~90 s and 22-47 s at 2,000. Other engines are unchanged. The
container still refuses a request over 2,000 characters and splits at 510
phonemes internally. To load-test with production-identical sections:

```bash
npx tsx scripts/sowell/split_for_loadtest.ts book.txt drew --texts-only
```

## Lanes and the shared fleet

One Modal fleet serves all three narrators. These numbers decide concurrency:

| Env | Default | Meaning |
|--|--|--|
| `SOWELL_MAX_CONTAINERS` | 16 | Fleet cap, clamped 1..16 at deploy. Also read by the worker as its cross-process cap, so several books cannot open more concurrent Kokoro calls than the fleet. |
| `SOWELL_BOOK_LANES` | fleet | Lanes one book may ask for. Unset: 16 on torch, the ONNX call cap (64 at 16 containers × 4 streams) otherwise. Clamped to that cap. `TTS_SECTIONS_PER_TICK` does not lower it. |
| `KOKORO_CPU_SECTION_CHARS` | 700 | Section target for the three Kokoro-CPU voices, clamped 300..2000. Read by the worker, so no redeploy. |
| `SOWELL_SCALEDOWN_SECONDS` | 5 | Idle time before a container goes away, clamped to Modal's 2..1200. |
| `SOWELL_TORCH_THREADS` | 4 | Torch intra-op threads, applied in `@modal.enter`. Benchmarked ~1.5× faster than 2 on cpu=2. |
| `SOWELL_TORCH_INTEROP_THREADS` | 1 | Torch inter-op threads, same place. |

A book's lanes are its exact share of the fleet among the Kokoro books
running right now (`planKokoroBookLanes`): one book alone gets all 16, two
books get 8 + 8, three books get 6 + 5 + 5.
The quotas sum to the fleet, so a container never sits idle while a book
waits, and every book keeps at least one lane. The budget is re-read before
every claim, so a book that starts mid-wave takes lanes as another book's
sections finish. The `kokoro` provider-slot rows are the hard cross-process
cap; a 429 from a busy container is retried with backoff, never a failed
take.

## Deploy

```bash
# Same app as before. This does not deploy echomancer-cpu or
# echomancer-s2-clone.
SOWELL_MAX_CONTAINERS=16 \
SOWELL_SCALEDOWN_SECONDS=5 \
SOWELL_TORCH_THREADS=4 \
KOKORO_CPU_SECTION_CHARS=700 \
modal deploy modal/sowell_worker.py

# Re-measure thread counts on the same image (CPU only, no GPU):
modal run modal/sowell_bench.py --threads 2
modal run modal/sowell_bench.py --threads 4
```

`SOWELL_TORCH_THREADS=4` is the default for a measured reason. On
`echomancer-sowell` (Drew, `cpu=2`, two rounds × 2 repeats,
`modal/sowell_bench.py`), the 719-character harbor paragraph is 39.7 s of
audio:

| Threads | Wall | RTF |
|--|--|--|
| 2 | 25.3–27.1 s | 1.46–1.57 |
| 4 | 16.5–19.3 s | 2.06–2.41 |

Prose (1.25–1.57 → 1.80–2.47) and the short opening (1.35–1.58 → 1.84–3.07)
followed the same shape. 4 threads is about **1.5× faster** at the same
container cost, so it is the default; `min(n, os.cpu_count() or 4)` only
clamps a smaller host.

Then set the Next.js/worker environment. Drew needs all three:

```bash
DREW_ENABLED=1
DREW_URL=https://<workspace>--echomancer-sowell-speaker-speak.modal.run
DREW_TOKEN=<the same secret as SOWELL_TOKEN>
```

Host only, no path: `DREW_URL` is rejected by both the client and the test
harness if it carries a path. The handler accepts either `SOWELL_TOKEN` or
`DREW_TOKEN` as the bearer, so the same secret value works for both.

Drew is the default the moment those three are set. **Before** they are set,
a request that names no voice is still Drew and the job route returns 503
`DREW_NOT_CONFIGURED`, so nothing is stored pointing at an endpoint that
cannot speak.

## Speed: 0.88 is applied once

Drew's natural pace is Kokoro speed **0.88**. The app sends 1.0. That is
applied **once**, in the container. `DREW_APP_SPEED_MAX` stays 1.0 so the
0.88 is not applied a second time. On the ONNX graph a two-minute passage
is 116.4 s at Kokoro 1.0 and 123.1 s at 0.88, about 5–6% longer.

```
request speed (app units, 1.0 = natural)  ×  0.88  =  Kokoro speed
```

- `scripts/sowell/drew.py` → `drew_speed()` is that multiply. It clamps to
  `0.5–2.0` and treats a missing/zero/NaN value as 1.0.
- `scripts/sowell/engine.py` calls `KPipeline.infer(..., kokoro_speed)`, where
  `kokoro_speed` is `drew_speed(speed)` for Drew and a flat `1.0` for Walter and
  George.
- TypeScript sends the app speed unchanged. `initialNarrationSpeed` returns
  **1.0** for `drew`, and the per-section `calibrateNarrationSpeed` step is
  skipped for `provider: "drew"` exactly as it is for Paradee. That is what
  keeps Drew out of the drift that walked later Andrew sections down to ~0.85.

Do **not** apply the native speed in TypeScript as well. `drewKokoroSpeed()` in
`src/lib/tts/drew-voice.ts` exists so the mapping can be tested and documented;
the request path does not use it.

## Pronunciation

`scripts/sowell/pronounce.py` runs on every Kokoro path (Drew, Walter, George,
Esther; ONNX and torch) before misaki. It folds typographic quotes so a curly
don't stays one word, splits a glued letter-number token (`CS183` → `CS 183`),
and reads a roman outline heading at the start of a line (`I.`, `IV.`) as
`One.`, `Four.`. A pronoun I in a sentence is left alone.

`PRONUNCIATIONS` is written over misaki's `us_gold` after the lexicon loads, so
those words win. To add a word, put a lowercase key and its IPA in that dict
and bump `PRONUNCIATION_ID` in the same file together with
`KOKORO_PRONUNCIATION_ID` in `src/lib/tts/kokoro-pronunciation.ts`. That suffix
is on every Kokoro cache key, so old previews are not replayed.

## Cache

Drew sections use `drew-kokoro82m-ft-stageA-step00900-style300-` plus the
worker runtime, `speed0.880`, and `-g2plex1` (`torch` unless `KOKORO_RUNTIME=onnx`).
The provider refuses a response whose `x-kokoro-speed`,
`x-kokoro-runtime`, or `x-kokoro-pronunciation` is anything else, so the
take is not cached. Esther, George, and Walter use the same pronunciation
header: a container that omits it is not stored under `-g2plex1`. Andrew's
Edge takes stay under the Edge key and are never replayed as Drew. Bump
`DREW_WEIGHTS_ID` in `src/lib/tts/drew-voice.ts` when the volume gets a
different checkpoint — that is a different model, so its audio must not be
found under this key. The `style300` piece is the pinned pack row below.
A new row is a different take even when the checkpoint is the same one, so
the variant moves with `DREW_FIXED_STYLE_INDEX`.

`DREW_PROSODY_RULES` is off unless set. Off, the key above is unchanged and
the request body has no `prosody` field. On (`1`, `true`, `on`, or `yes`),
`drewCacheVariant` appends `-prosodyG` and the body is `{ prosody: "G" }`.
That suffix is the recipe, not a new checkpoint: row 300 and Kokoro speed 0.88
stay. Bump the suffix in `scripts/sowell/prosody_rules.py`
(`PROSODY_G_CACHE_SUFFIX`) and `src/lib/tts/drew-voice.ts`
(`DREW_PROSODY_G_SUFFIX`) together if the G constants change. Do not put
`ACCENT_K` or `DECL_ST` in the environment. The A/B's defaults of those
variables were a different variant.

The container applies G only when the body says so. A missing or empty
field forces the stock forward even if the container has
`DREW_PROSODY_RULES` set, because the cache key is decided by the process
that sent the body. A response that was asked for G and does not return
`x-kokoro-prosody: G` is not stored.

Roll the flag out in this order. Deploy the Modal app that honors
`prosody: "G"` first (`echomancer-sowell`; this is an owner deploy, not an
agent command). Then set `DREW_PROSODY_RULES=1` on the take-home VM and
restart the worker. Vercel does not synthesize Drew take-home. Unset the
flag and restart to roll back; stored unruled takes stay under the key
without the suffix, and new sections render stock again. Re-record
`public/voice-previews/drew.mp3` only after the flag is on in the process
that renders the preview. Until then the committed sample is the unruled
take, which is what the flag-off app speaks.

Measured on the Hamlet passage in
`scripts/sowell/fixtures/drew_prosody_passage.json` (the A/B's text, about
49 s) with this path: row 300, app speed 1.0, Kokoro 0.88, 4 torch threads,
CPU, no Modal. After a one-sentence warmup the unruled renders took 10.17 s
and 10.39 s of infer; the ruled renders took 10.07 s and 10.21 s. First
audio stayed about 4 s. Both files are 48.875 s (1,173,000 samples), so the
rules did not change duration. Editing a 51 s F0 contour took 3.3 ms.
`librosa.pyin`: pitch std 4.23 st unruled, 4.34 st ruled. Sentence-median
spread 0.84 st to 2.16 st. Question-final move (every `?`, including
wh-questions) −4.72 st to −2.23 st. The yes/no questions moved from about
−5 st to −1 st, and the wh-question stayed at −4.6 st. Peaks were 0.42,
nothing clipped, and there were no octave jumps. Two unruled renders of the
same text differ by RMS 0.007; unruled against ruled differs by RMS 0.08.
Those timings are the 0.88 run. The default is now Kokoro 1.0, so the same
passage is shorter and this wall time does not describe the current speed.
Kokoro on this CPU is not bitwise stable even with the flag off, and the
flag-off path does not install the hook. No Andrew reference wav was in the
tree, so the correlation was not recomputed. The row-200 A/B's G was spread
2.82 st and question-final −3.43 st, against Andrew at 2.72 st and −1.77 st.
Row 300 does not reproduce those two numbers. The spread moved most of
the way toward Andrew, and the question ending (−2.23 st) is closer to
Andrew than the row-200 G was. Re-run with `scripts/sowell/prosody_ab.py` and
`scripts/sowell/prosody_metrics.py --andrew <wav>` when a reference exists.

## One style row

Kokoro reads `pack[phoneme_count - 1]`. Drew's pack changes with that index:
timbre cosine between tensor rows 150 and 450 is 0.78, and the same sentence
is about 4.6 dB brighter in the 2–5 kHz band at row 509 than at row 150, and
about 2 LU quieter. A section split into a long chunk and a short one was
changing voice in the middle.

`pin_style` in `scripts/sowell/style.py` copies one row into every index when
the voice is loaded. `KPipeline.infer` still indexes with the phoneme count
and still receives `drew_speed(speed)`. The speed argument is not scaled a
second time. Walter (`SOWELL_FIXED_STYLE_INDEX`) and George stay `None`:
George's rows 150 and 450 are cosine 0.9997 / 0.9986 (timbre / prosody), and
the same sentence differs by 0.01 dB and 0.0 LU, so George's cache key is
unchanged. Walter's pack is not in this repository and was not on a Modal
volume, so it is not pinned and its cache key is unchanged. The hook is
there for a later measurement.

Drew's row is tensor index **300**. Mean speaker cosine against the Andrew
pilot paragraph and the Edge rate-0 reading of the same words is a 0.005 tie
from row 120 through 300 (0.900–0.901). Row 300 is the closest 2–5 kHz
balance to the pilot (−0.73 dB). Rows 400 and 509 fall to about 0.85 and run
about +2.4 dB bright. `scripts/sowell/choose_fixed_style.py` is the measurement.

## Preview

The committed sample is **`public/voice-previews/drew.mp3`**: `PREVIEW_TEXT`
rendered with Drew at app speed 1.0 (Kokoro 0.88, which is
`DREW_NATIVE_KOKORO_SPEED`, 24 kHz mono, pinned style
row 300), then mastered exactly like a book section with
`scripts/previews/master-preview.ts` (podcast chain, voice curve, loudness to
the book target, the short-clip gain under 3 s) on ffmpeg n8.1.3. The result is
the same 44.1 kHz mono 128 kbps MP3 a section is stored as, about −16.6 LUFS;
do not re-encode it. `"drew"` is in `COMMITTED_PREVIEW_IDS`. Re-record it when
`PREVIEW_TEXT`, the volume checkpoint, `DREW_FIXED_STYLE_INDEX`, `DREW_NATIVE_KOKORO_SPEED`, prosody G
being turned on, or the section mastering chain changes:

```bash
FFMPEG_PATH=/path/to/ffmpeg-n8.1.3 \
npx tsx scripts/previews/master-preview.ts drew-raw.wav public/voice-previews/drew.mp3
```

Walter's sample is unchanged: `public/voice-previews/sowell.mp3`, a local CPU
take of `PREVIEW_TEXT` with `am_sowell`. It is the raw take, not mastered, so
it is quieter and less finished than a Walter book. Re-record it through
`scripts/previews/master-preview.ts` when it is next touched.

## Rollback

Unset `DREW_ENABLED`. The card disappears, a request naming Drew, and a
request that names no voice, return 503 `DREW_NOT_CONFIGURED`. Stored Drew
audio still plays from object storage. Heart, Walter, George, and every
stored Andrew, Ava, Libby, and Ryan book are unaffected.

## Smoke

Use a short original note, not a customer book.

1. `GET /api/tts/voices` lists `drew` first with `displayName: "Drew"`, and no
   `standard` row.
2. Press play on Drew: the first play may render; a second play is instant if
   the static preview has been added.
3. Make a one-page audiobook with Drew. Confirm the raw object is WAV from this
   provider and the section cache key contains `drew-kokoro82m-ft-stageA`.
4. Confirm two paragraphs of a Drew section come back at the pace you expect —
   not slower than Andrew. A double-applied native speed is the failure to listen for.
5. Choose Walter: the card reads "Walter", and a book made with it still
   resolves `catalogVoiceId: "sowell"`.
6. Open a book already made with Andrew: it plays its stored audio and is not
   re-spoken.
