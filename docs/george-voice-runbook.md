# George

George replaces Ryan in the picker. The voice is Kokoro-82M `bm_george`
on the same Modal CPU app as Sowell (`echomancer-sowell`). It is not an
OpenRouter voice. The Sowell pack is not used. A book already stored as
Ryan stays on Edge and is not spoken again. A custom clone is untouched.

## One app, not a second fleet

The class has `min_containers=0`, `max_containers` default 16 (clamped 1..16
at deploy), 2 CPU, 6 GB, and 4 Torch threads (`SOWELL_TORCH_THREADS`;
benchmarked ~1.5x faster than 2 on cpu=2 — see
`docs/sowell-voice-runbook.md`). `@modal.enter` loads one Kokoro model
and two phonemizers: American for the Sowell pack, British (`lang_code='b'`)
for `bm_george`. Drew is the second resident kmodel when its volume is
mounted.

George, Walter, and Drew share one sixteen-container fleet. A book's lanes
are its exact share of that fleet among the Kokoro books running now
(`planKokoroBookLanes`; quotas sum to the fleet and are re-read on every
claim), and the `kokoro` provider-slot rows are the hard cross-process cap,
so a George book and a Sowell book do not open thirty-two containers between
them. Idle scale-down is 5 s. George packs at `KOKORO_CPU_SECTION_CHARS`
(default 700) like the other two Kokoro-CPU voices.

`GEORGE_URL` is a separate host from `SOWELL_URL` only if Modal prints
two. On this app both methods are the same `speak` endpoint. Set
`GEORGE_URL` to that host **after** the app that returns
`x-kokoro-voice: bm_george` is deployed. Until then the card is absent.
An older app that ignores `voice` does not get to store audio: the
worker rejects a body with no `bm_george` header.

`SOWELL_MAX_CONTAINERS` is one fleet knob for all three narrators. Raising it
raises the shared pool for George, Walter, and Drew together; it is not a
per-voice setting. It defaults to 16, and the worker clamps a book's
`SOWELL_BOOK_LANES` to it.

## Deploy

The image copies `voices/bm_george.pt` from Kokoro-82M revision
`f3ff3571791e39611d31c381e3a41a3af07b4987` and refuses any other hash
(`f1bc812213dc59774769e5c80004b13eeb79bd78130b11b2d7f934542dab811b`).

```bash
modal deploy modal/sowell_worker.py
```

Then, on the worker and on Vercel, after that deploy:

```bash
GEORGE_ENABLED=1
GEORGE_URL=https://<workspace>--echomancer-sowell-speaker-speak.modal.run
GEORGE_TOKEN=<the same SOWELL_TOKEN value>
```

Host only, no path. Restart the worker with `--update-env`. Sowell's
three variables stay as they are.

## Rollback

Unset `GEORGE_ENABLED`. The card disappears and a new Ryan request
returns 503. Stored Ryan audio still plays. Do not point George at
OpenRouter.

## Cache

George sections use `kokoro82m-b-bm_george-f3ff3571791e`. Ryan's Edge
takes stay under the Edge key. They are not replayed as George.

## Preview

`public/voice-previews/george.mp3` is a local CPU take of `PREVIEW_TEXT`
from that pinned `bm_george` file. 24 kHz mono, 96 kbps. It is not a
live synthesis, and it is the raw take, not mastered. Re-record it when
`PREVIEW_TEXT` changes, through `scripts/previews/master-preview.ts` so it is
mastered like a George book section.
