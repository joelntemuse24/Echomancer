# Heart

Heart replaces Ava and Libby in the picker. The voice is Kokoro-82M
`af_heart` (American female) on the same Modal CPU app as George and Walter
(`echomancer-sowell`). It uses the stock Kokoro-82M base model and the
`af_heart` voice pack. It is not Drew's fine-tune, not an OpenRouter voice,
and not the Sowell pack. There is no GPU.

The customer-facing name is the constant `HEART_DISPLAY_NAME` in
`src/lib/tts/heart-voice.ts` (`Heart`). Rename that constant to rename the
voice. The catalog id stays `heart`.

A book already stored as Ava or Libby stays on Edge and is not spoken again.
A book already stored as Michelle stays on Edge. A book already stored as
Clara stays on Fish. A new request or saved pick that names `ava`, `libby`,
`clara`, or `michelle` is Heart. A request that names no voice is Drew.

## One app, not a second fleet

The class has `min_containers=0`, `max_containers` default 16 (clamped 1..16
at deploy), 2 CPU, 6 GB, and 4 Torch threads. `@modal.enter` loads one
Kokoro model. American phonemes (`lang_code='a'`) speak Walter and Heart.
British (`lang_code='b'`) speaks George. Drew is the second resident kmodel
when its volume is mounted. Heart's style index stays `None`, so the stock
pack stays length-indexed. Drew's pinned row 300 and Drew's prosody rules
are not applied.

Heart, George, Walter, and Drew share one sixteen-container fleet. A book's
lanes are its exact share of that fleet. Idle scale-down is 5 s. Heart packs
at `KOKORO_CPU_SECTION_CHARS` (default 700) like the other Kokoro-CPU voices.
The circled-plus warmup includes Heart: `heart` is in `KOKORO_CPU_VOICE_IDS`,
so a Heart pick warms the `kokoro` pool.

`HEART_URL` is the same `speak` host Modal prints for this app. Set it
**after** the app that returns `x-kokoro-voice: af_heart` is deployed. Until
then the card is absent. An older app that ignores `voice` does not get to
store audio: the worker rejects a body with no `af_heart` header.

`SOWELL_MAX_CONTAINERS` is one fleet knob. Raising it raises the shared pool
for Heart, George, Walter, and Drew together.

## Deploy

Do this by hand. An agent does not run it.

The image copies `voices/af_heart.pt` from Kokoro-82M revision
`f3ff3571791e39611d31c381e3a41a3af07b4987` and refuses any other hash
(`0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff`).

```bash
modal deploy modal/sowell_worker.py
```

That rebuilds the `echomancer-sowell` image. It does not deploy the clone
GPU app and it does not change Drew's weights.

Then, on the worker **and** on Vercel, after that deploy:

```bash
HEART_ENABLED=1
HEART_URL=https://<workspace>--echomancer-sowell-speaker-speak.modal.run
HEART_TOKEN=<the same SOWELL_TOKEN value>
```

Host only, no path. `HEART_URL` is the same host as `GEORGE_URL` and
`SOWELL_URL` when Modal prints one `speak` endpoint. Restart the worker
with `--update-env` so pm2 picks up the three variables. Vercel needs the
same three so the voices API lists the card. Sowell's, George's, and Drew's
variables stay as they are.

Until `HEART_ENABLED=1` plus a host and token are set, Heart is absent from
the picker. A new request that names Heart, Ava, Libby, Clara, or Michelle
returns 503 `HEART_NOT_CONFIGURED` and no row is inserted.

## Rollback

Unset `HEART_ENABLED` on the worker and on Vercel, and restart the worker
with `--update-env`. The card disappears. A new Ava, Libby, Clara, or
Michelle request returns 503. Stored Ava and Libby audio still plays on
Edge. Stored Clara audio still plays on Fish. Stored Michelle audio still
plays on Edge. Do not point Heart at OpenRouter.

## Cache

Heart sections use `kokoro82m-a-af_heart-f3ff3571791e`. George's key is
`kokoro82m-b-bm_george-f3ff3571791e`. Drew's key is the fine-tune id
`drew-kokoro82m-ft-…`. Ava's and Libby's Edge takes stay under the Edge
key. They are not replayed as Heart.

## Speed

Measured on one CPU host, stock Kokoro-82M, 4 Torch threads, after a
one-line warmup. The text is the harbor paragraph from
`modal/sowell_bench.py` (720 characters). This is not a Modal container
(`cpu=2`); it is the same process speaking both packs, so the comparison
is the speed of `af_heart` against `bm_george`.

| Voice | Wall | Audio | RTF | Chars/s |
| --- | --- | --- | --- | --- |
| `af_heart` | 8.04 s | 41.12 s | 5.12 | 89.6 |
| `bm_george` | 7.90 s | 41.10 s | 5.20 | 91.1 |

Heart's wall time is within 2% of George's on the same text. The audio
length matches. Heart does not add a pass and does not use Drew's weights.

## Preview

`public/voice-previews/heart.mp3` is a local CPU take of `PREVIEW_TEXT`
from the pinned `af_heart` file, mastered with
`scripts/previews/master-preview.ts` (the same podcast chain as a Drew
preview). Re-record it when `PREVIEW_TEXT` changes. `ava.mp3` and
`libby.mp3` stay on disk and are not listed samples. A request that names
Ava or Libby is served Heart's sample.
