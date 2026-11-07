# Sowell voice

Sowell is a separate narrator. It does not replace Andrew, Ava, Libby,
Ryan, Echomancer Andrew, or a clone. The weight file is not in git: this
repository is public. The hash is in `voices/sowell/manifest.json`.

The export did not record a trainer checkpoint. The tensor is
`(510, 1, 256)` float32, which is the Kokoro-82M v1.0 voice contract:
`pack[phoneme_count - 1]` is 256 wide, and `kokoro-v1_0.pth` uses the
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

The fleet stays 2 containers, 2 CPU, 4 GB. The book claims 2 sections
at a time, which matches those containers. A section may be up to 2,000
characters. Kokoro then splits that text on its own 510-phoneme
boundary and refuses the call if a run would have to drop words. A
2,699-character prose probe made 6 runs, none over 510 phonemes, and
the word list matched. The old 280-character section cap is not used.

A 429 is retried a few times so the other container can take the
section. A 500 fails the take. Nothing is concatenated from a failed
piece, and Andrew is not a fallback.

## Image

`python:3.11-slim-bookworm`, not the apt Python used by the extract
image. Pip on that image is not externally managed. Do not add a
`pip config get` check. The build copies the pack and fails if the hash
or layout is wrong, then installs `kokoro==0.9.4`.

Place the file, then build. Do not commit it.

```bash
install -m 600 /path/to/am_sowell_avg.pt voices/sowell/am_sowell_avg.pt
sha256sum voices/sowell/am_sowell_avg.pt
# a9fa4422864e0048d035ead9ad6a304170f73aec409271903b05c9a789c7510d
```

Create Modal secret `echomancer-sowell` with `SOWELL_TOKEN`. Then:

```bash
SOWELL_MAX_CONTAINERS=2 \
SOWELL_SCALEDOWN_SECONDS=60 \
modal deploy modal/sowell_worker.py
```

This app is `echomancer-sowell`. It does not deploy `echomancer-cpu` or
`echomancer-s2-clone`. `min_containers` is 0.

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

Torch is pinned to 2 threads (`SOWELL_CPU_THREADS`, `OMP_NUM_THREADS`,
`OPENBLAS_NUM_THREADS`, `MKL_NUM_THREADS`). The model is `eval()` and
the render runs under `inference_mode`. A 4-thread pool on a 2-CPU
set was slower, not faster.

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

## Smoke

On the voice page, Sowell is a named card after Ryan only when
`GET /api/tts/voices` includes provider `sowell`. The five stock voices
and any clones stay where they were. The card has no play control: no
sample is stored, and the tap does not ask the server to synthesize
one. Choosing it and pressing Make audiobook sends
`catalogVoiceId: "sowell"`. With the flag off, that response omits
Sowell, the card is absent, and a saved Sowell pick does not highlight
Andrew.

Use a short original note, not a customer book. Confirm the raw object
is wav from this provider, the section cache key contains
`sowell-kokoro82m-v1_0-a9fa4422864e`, and Andrew's preview is unchanged.
