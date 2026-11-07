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
SOWELL_URL=https://<workspace>--echomancer-sowell-speak.modal.run
SOWELL_TOKEN=<the secret>
```

The URL is the host only.

## Local CPU check

This does not call Modal. It downloads the pinned Kokoro weights once.

```bash
python3 scripts/sowell/test_pack.py
python3 scripts/sowell/synthesize.py \
  --pack voices/sowell/am_sowell_avg.pt \
  --text "The harbor was quiet after the rain." \
  --out /tmp/sowell.wav
```

A request over 280 characters is refused. The container answers 429
while it is already speaking.

## Smoke

Use a synthetic job id, not a customer book. With the flag on, create
one take-home whose `catalogVoiceId` is `sowell` and whose text is one
short sentence. Confirm the raw object is wav from this provider, the
section cache key contains `sowell-kokoro82m-v1_0-a9fa4422864e`, and
Andrew's preview is unchanged. Turn `SOWELL_ENABLED` off and confirm
the same create returns 503 and the slim picker is the five stock voices.
