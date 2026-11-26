# Sowell voice

> **The listed name is now Walter.** The catalog id stayed `sowell` so stored
> books, picks, and `public/voice-previews/sowell.mp3` keep working; only the
> label changed. See `docs/drew-walter-voice-runbook.md` for the rename and for
> Drew, the app default that replaced Andrew.

Sowell is a separate narrator. It does not replace Drew, Heart,
George, or a clone. The weight file is not in git: this
repository is public. The hash is in `voices/sowell/manifest.json`.

The export did not record a trainer checkpoint. The tensor is
`(510, 1, 256)` float32, which is the Kokoro-82M v1.0 voice contract:
`pack[phoneme_count - 1]` is 256 wide. `SOWELL_FIXED_STYLE_INDEX` is `None`,
so Walter keeps that length index: the pack file is not in the repo and was
not on a volume, so it has not been shown to move with length the way Drew's
does. George is a stock pack and is flat across those rows, so it stays
indexed too. Drew is the voice that pins one row; see
`docs/drew-walter-voice-runbook.md`. `kokoro-v1_0.pth` uses the
first 128 for the decoder and the rest for the predictor
(`hexgrad/kokoro` `dfb907a`, model revision
`f3ff3571791e39611d31c381e3a41a3af07b4987`). The runtime loads that
revision only. If the laptop used a different base, say so before
deploying. `trainerCheckpointSha256` is null until then.

`verify.json` similarities are not a listening test and are not a claim
that the voice is better than stock.

## Do not run it on the take-home VM

`WORKER=1` refuses a loopback `SOWELL_URL`. There is no `/sowell` route
on the Contabo worker. A book that names Sowell while the endpoint is
missing fails with `SOWELL_NOT_CONFIGURED` and is not spoken by Andrew.

## Runtime

Each container is a Modal class. `@modal.enter` loads the pack, the
pinned Kokoro weights, and the pipeline once. Later requests in that
container call the same objects. `min_containers` is 0, so an idle
container still scales off. The model is not reentrant: one request
holds a lock, and `@modal.concurrent(max_inputs=1)` plus a 429 keeps a
second request off that container. Audio is WAV bytes in memory. There
is no shared `/tmp/sowell.wav`.

The fleet is **16 containers** by default, 2 CPU, 6 GB each
(`SOWELL_MAX_CONTAINERS`, default 16, clamped to 1..16 at deploy). The
integer `cpu` and `memory=6144` do not change with the lane count; 16
containers is 16 containers of the same size.

`SOWELL_BOOK_LANES` is how many of those containers one book may use. It
defaults to 16, is clamped to 16, and is clamped again to the fleet. A book
uses one lane per section still to speak and no more than that cap. A
production deploy can lower `SOWELL_MAX_CONTAINERS` for a smaller fleet; the
code default stays 16.

Idle scale-down is **5 s** (`SOWELL_SCALEDOWN_SECONDS`, default 5, clamped
to Modal's 2..1200). The measured book was 15.7k characters: 16 lanes ×
700-char sections finished in 47 s against 74 s for 6 lanes × 1.4k. The idle
tail then dominated the cost, so a short idle keeps the total about equal to
the old shape while the book finishes sooner.

### Sections: ~700 characters per lane

Each section is one HTTP call to one container, so section length sets both
the per-call latency and the tail of a book. Kokoro-CPU books (Drew, Walter,
George) pack at `KOKORO_CPU_SECTION_CHARS` — **default 700**, clamped
300..2000. The opening two sections stay shorter (400 and 550 characters), so
first audio lands fast, and the packer still closes on a sentence. At ~2x
realtime a 700-character section is ~30 s of audio and 8-15 s of wall,
against ~90 s of audio and 22-47 s of wall at 2,000. That shortens the last
wave and gives a lane that frees late work it can finish.

The container's own request cap stays 2,000 (`MAX_CHARS` in
`modal/sowell_worker.py`), and `engine.py` still splits at 510 phonemes.
Nothing else about the call changed: same voice, same 429 retry, same audio
guard.

The PCM concat and the disk finalize keep **225 ms** of silence on a
sentence or mid-paragraph edge and **300 ms** on a paragraph or chapter
edge. The paragraph fade stays inside that silence, so it does not run
into the next word. A mid-paragraph cut uses a 12 ms micro fade. The
mastered MP3 copy-join leaves a longer pause in the copied body and fades
only its last window (**80 ms** for a book under 4,000 characters, **120 ms**
otherwise).
Every section is verified to be more than four seconds of audio
(`COPY_JOIN_MIN_SECONDS`) so the copy-join never re-encodes a stub.

### Sharing the fleet

Several books from different users share the fleet. The worker measures how
many books are speaking right now (the `kokoro` provider-slot rows) and
divides the fleet **exactly**, oldest book first (`planKokoroBookLanes`):

- one book alone gets all of it (16 by default);
- two books get 8 + 8;
- three books get 6 + 5 + 5 — the remainder goes to the older books, so the
  quotas always sum to the fleet and a container never sits idle while a book
  waits;
- a book ranked past the fleet still gets one lane, so nobody is starved.

The budget is re-read before every claim, not once per tick: a book that
starts mid-wave gets lanes as another book's sections finish, and a running
book shrinks to its new share instead of holding the fleet for its whole
book. The `kokoro` provider-slot rows remain the hard cross-process cap, so
the total concurrent Kokoro calls across books never exceeds
`SOWELL_MAX_CONTAINERS` even if a budget read is stale or fails. A 429 from a
busy container is retried in place with backoff, never failed.

The warm path starts **one** container (`KOKORO_WARM_CONTAINERS`), never the
whole lane plan; `min_containers` stays 0. `kokoroWarmLimit` caps a warm loop
at `min(fleet, SOWELL_BOOK_LANES, sectionCount)`, so a click cannot stand up
more than the book will use.

## Why the pool is rolling

The measured book (16,940 characters, 11 sections, Drew) took 9:00 of wall
for 17:04 of audio. Four causes: only two lanes, fixed-pair dispatch that
left a lane idle until the slower section of its pair finished, mastering
that did not overlap speech, and 300 s of billed idle. All four are fixed:
the pool claims the next section the moment any lane frees (the same shape
as the Edge path), and mastering runs on its own promise so the lane starts
speaking again immediately. Ordering is untouched — a section is bound to
its index before it starts and the final join still walks `0..N-1`.

Job `949891ec` (7 Nov 2026) is the measured book, not a local bench.
1,480 characters, two sections, 81 seconds of audio. Created to ready
was 62 seconds. First published section was 52 seconds after creation.
Both indexes were claimed at 3 seconds. Raw audio existed by 42 and 48
seconds. That 6 second gap is not two full serial renders, and it is
not proof the HTTP calls overlapped. There is no container init time
in that log. Whisper QA was disabled and did not run. After the raw
files existed, the two masters did not overlap: 6s then 5s of
placement, 3s of work each, then concat waited 2s and ran 2s. Ready
was 62 seconds. More than two Sowell containers cannot shorten that
book. The next book should log `[sowell]` with `headerMs`, `bodyMs`,
and, after the Sowell image is deployed, `inferMs`, `loadMs`, and
`init`. `GET /api/jobs/:id` includes `generation_started_at`,
`first_section_at`, and `last_section_at` as unix seconds.

`CPU_DISPATCH_BUSY_MS` (default 8s) is how long a master or concat
keeps posting after a container answers 429, so the second section
does not wait until the first master has exited. Zero posts once. A section is
packed to `KOKORO_CPU_SECTION_CHARS` (default 700; the container still
refuses anything over 2,000). Kokoro then splits that text on its own
510-phoneme boundary. A run of 511 still comes out (`en_tokenize` does not
guarantee the cap, and Kokoro's own generator would truncate it). The engine
splits that run and keeps every phoneme character; it still refuses a piece
that would have to drop text. A 2,699-character prose probe made 6 runs, none
over 510 phonemes, and the word list matched. The old 280-character section
cap is not used.

A 429 is retried a few times so the other container can take the
section. A 500 fails the take. Nothing is concatenated from a failed
piece, and Andrew is not a fallback.

## Image

`python:3.11-slim-bookworm`, not the apt Python used by the extract
image. Pip on that image is not externally managed. Do not add a
`pip config get` check. The build copies the pack and fails if the hash
or layout is wrong, then installs `kokoro==0.9.4`.

The build also bakes every cold-start download, so `@modal.enter` on a
scaled-from-zero container only reads local files:

- `en_core_web_sm` **3.8.0**, from its pinned GitHub release wheel. misaki's
  English G2P otherwise runs `spacy.cli.download` on first use. The layer
  asserts spaCy is 3.8.x first, so a version drift fails the build instead of
  shipping a model the installed spaCy cannot load.
- `hexgrad/Kokoro-82M` `config.json` and `kokoro-v1_0.pth` at
  `f3ff3571`, plus the `bm_george.pt` voice. They land in `HF_HOME=/opt/hf`,
  which is set **before** those layers, so the runtime's `hf_hub_download`
  calls are cache hits.
- `espeak-ng` is already an apt package (misaki's OOD-word fallback). No nltk
  data is needed: misaki does not use nltk.

Place the file, then build. Do not commit it.

```bash
install -m 600 /path/to/am_sowell_avg.pt voices/sowell/am_sowell_avg.pt
sha256sum voices/sowell/am_sowell_avg.pt
# a9fa4422864e0048d035ead9ad6a304170f73aec409271903b05c9a789c7510d
```

Create Modal secret `echomancer-sowell` with `SOWELL_TOKEN`. Then:

```bash
SOWELL_MAX_CONTAINERS=16 \
SOWELL_SCALEDOWN_SECONDS=5 \
SOWELL_TORCH_THREADS=4 \
KOKORO_CPU_SECTION_CHARS=700 \
modal deploy modal/sowell_worker.py
```

These are the code defaults, so a redeploy without them keeps the same shape.
`SOWELL_MAX_CONTAINERS` is read by the Modal class at deploy time and by the
worker as its shared cap; `SOWELL_BOOK_LANES` matches it. Lower either one
for a smaller fleet; both are clamped at 16. `KOKORO_CPU_SECTION_CHARS` is
read by the worker, not by the container, so it needs no redeploy — set it on
Vercel and the VM worker.

Threads: `SOWELL_TORCH_THREADS` (default **4**) is applied by
`torch.set_num_threads` in `@modal.enter`, before the first model load.
`SOWELL_TORCH_INTEROP_THREADS` (default 1) is the same for inter-op. Both are
read once per container, so changing them needs a redeploy. Torch only
accepts `set_num_interop_threads` before its pool starts; a second call is
ignored rather than fatal.

4 is the default because it was measured on the deployed image, not inferred
from a local probe:

| Text | Chars | Audio | 2 threads wall | 2 threads RTF | 4 threads wall | 4 threads RTF |
|--|--|--|--|--|--|--|
| harbor | 719 | 39.7 s | 25.3–27.1 s | 1.46–1.57 | 16.5–19.3 s | 2.06–2.41 |
| prose | — | — | — | 1.25–1.57 | — | 1.80–2.47 |
| opening | — | — | — | 1.35–1.58 | — | 1.84–3.07 |

Two rounds × 2 repeats, Drew, `cpu=2`, `modal/sowell_bench.py`. 4 threads is
about **1.5× faster** at the same container cost, so 4 is the default;
`min(n, os.cpu_count() or 4)` only clamps a smaller host.

Re-measure on the same image before changing it again. The benchmark is
CPU-only (no GPU, no GPU image) and reads no `echomancer-sowell` secret:

```bash
modal run modal/sowell_bench.py --threads 2
modal run modal/sowell_bench.py --threads 4
# both in one command, one fresh container per count:
modal run modal/sowell_bench.py --threads 2 --threads 4 --repeats 3
```

Each row prints `wallSeconds`, `audioSeconds`, `rtf` (`audio/wall`),
`charsPerSecond`, `firstAudioSeconds`, and `initCount`. The bench app is
`echomancer-sowell-bench`: `max_containers=1`, `min_containers=0`,
`scaledown_window=10`.

This app is `echomancer-sowell`. It does not deploy `echomancer-cpu` or
`echomancer-s2-clone`. `min_containers` is 0. A create-flow click can POST
`{"warm": true}` to this endpoint. That starts **one** container, loads Kokoro
in `@modal.enter`, and returns without audio. It does not call
`update_autoscaler`, and it does not pre-start the fleet. The cap is 16. Idle
scale-down is 5 seconds.

A warm is claimed once per pool for 25 seconds (`KOKORO_WARM_HOLD_MS` in
`src/lib/capacity/warm.ts`). A warmed container lives about a 20 s boot plus
the 5 s idle, so the hold stays close to that lifetime: a warm is only useful
if generation starts within ~25 s of it. A five-minute hold would suppress
the next legitimate warm long after the container had gone.

On Vercel, after the endpoint exists:

```bash
SOWELL_ENABLED=1
SOWELL_URL=https://<workspace>--echomancer-sowell-speaker-speak.modal.run
SOWELL_TOKEN=<the secret>
```

Use the host Modal prints. The class is `Speaker` and the method is
`speak`, so the name is not the old function URL. The URL is the host
only.

## Local CPU check

This does not call Modal. It downloads the pinned Kokoro weights once.

```bash
python3 scripts/sowell/test_pack.py
python3 scripts/sowell/synthesize.py \
  --pack voices/sowell/am_sowell_avg.pt \
  --text "The harbor was quiet after the rain." \
  --out /tmp/sowell.wav
```

A request over 2,000 characters is refused by the container. Kokoro's
own splitter still runs inside that cap. The container answers 429
while its one resident model is speaking.

Torch runs 4 threads (`SOWELL_TORCH_THREADS`, with `OMP_NUM_THREADS`,
`OPENBLAS_NUM_THREADS`, and `MKL_NUM_THREADS` in step). An older deployment
that only sets `SOWELL_CPU_THREADS` keeps working: it is the fallback name.
The model is `eval()` and the render runs under `inference_mode`.

The local table below is the older probe, kept for the audio figures. Its
2-CPU 4-thread row (27.594 s) is a **local** result that disagreed because the
probe pinned `taskset -c 0,1` on a busy desktop, not Modal's 2 dedicated
cores. The deployed measurement above supersedes it: on `echomancer-sowell`
4 threads is ~1.5× faster than 2, and 4 is now the default.

Measured here with the real pack and the pinned base. Not a listening
test. The paragraph is 719 characters, 144 words, 38.125 seconds of
audio, 1,830,044 byte wav. `taskset -c 0,1` stands in for one
container's 2 CPUs. Cold includes model init. Warm is the next call in
that same process (`initCount` stays 1). First audio is when the first
phoneme run has samples. The HTTP body still waits for the whole
section, which is what the player can start.

| Case | First audio | Whole request | initCount |
|--|--|--|--|
| 2 CPUs, 1 thread, warm | 12.801 s | 20.077 s | 1 |
| 2 CPUs, 2 threads, cold | 7.958 s | 15.515 s | 1 |
| 2 CPUs, 2 threads, warm | 7.944 s | 12.116 s | 1 |
| 2 CPUs, 4 threads, warm | 22.950 s | 27.594 s | 1 |
| 4 CPUs, 4 threads, warm | 4.672 s | 7.196 s | 1 |

Two such paragraphs, each process pinned to its own 2 CPUs and 2
threads: 18.376 s wall together, versus 33.943 s one after the other.
Each kept 144 words and the same byte length. Overlap on one shared
CPU set without a thread cap was slower (an earlier 1,079-character
pair took 37.7 s). That setting is not used. The book claims 2 sections
because two containers with their own 2 CPUs finished two paragraphs
in 18.4 s instead of 33.9 s.

`python3 scripts/sowell/bench_threads.py /path/to/am_sowell_avg.pt`
repeats the thread comparison. It does not call Modal.

## Load-test sections (production-identical)

A load test is only meaningful when its requests are shaped like production's.
`scripts/sowell/split_for_loadtest.ts` runs the **production** splitter with a
Kokoro-CPU voice, so the section count, the ~700-character target, the short
opening, and the heading threshold are exactly what a book gets:

```bash
# JSON array of {index, chars, text}
npx tsx scripts/sowell/split_for_loadtest.ts book.txt drew

# A bare JSON array of section strings, for a request loop
npx tsx scripts/sowell/split_for_loadtest.ts book.txt drew --texts-only

# Vary the target without touching the worker env (clamped 300..2000)
npx tsx scripts/sowell/split_for_loadtest.ts book.txt sowell 900
KOKORO_CPU_SECTION_CHARS=1200 npx tsx scripts/sowell/split_for_loadtest.ts book.txt george
```

The voice is `drew` (default), `sowell` (Walter), or `george`. It reads the
file and prints; it never calls Modal, and it does not need any secret.

## Smoke

On the voice page, Sowell is a named card after the stock voices only when
`GET /api/tts/voices` includes provider `sowell`. The other stock voices
and any clones stay where they were. The play control is separate from the name. It plays
`public/voice-previews/sowell.mp3`, a local CPU take of the standard
preview line with `am_sowell`, and it does not synthesize or start a
container. George has `public/voice-previews/george.mp3`. Choosing Sowell
and pressing Make audiobook sends
`catalogVoiceId: "sowell"`. With the flag off, that response omits
Sowell, the card is absent, and a saved Sowell pick does not highlight
Andrew.

Use a short original note, not a customer book. Confirm the raw object
is wav from this provider, the section cache key contains
`sowell-kokoro82m-v1_0-a9fa4422864e-g2plex1`, and Andrew's preview is unchanged.
