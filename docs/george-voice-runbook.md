# George

George replaces Ryan in the picker. The voice is Kokoro-82M `bm_george`
on the same Modal CPU app as Sowell (`echomancer-sowell`). It is not an
OpenRouter voice. The Sowell pack is not used. A book already stored as
Ryan stays on Edge and is not spoken again. A custom clone is untouched.

## One app, not a second fleet

The class still has `min_containers=0`, `max_containers` default 2,
2 CPU, 4 GB, and 2 threads. `@modal.enter` loads one Kokoro model and
two phonemizers: American for the Sowell pack, British (`lang_code='b'`)
for `bm_george`. Both voices share the `kokoro` permit of 2, so a George
book and a Sowell book do not open four containers.

`GEORGE_URL` is a separate host from `SOWELL_URL` only if Modal prints
two. On this app both methods are the same `speak` endpoint. Set
`GEORGE_URL` to that host **after** the app that returns
`x-kokoro-voice: bm_george` is deployed. Until then the card is absent.
An older app that ignores `voice` does not get to store audio: the
worker rejects a body with no `bm_george` header.

Do not raise `SOWELL_MAX_CONTAINERS` for George. That would be a second
approval.

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
live synthesis. Re-record it when `PREVIEW_TEXT` changes.
