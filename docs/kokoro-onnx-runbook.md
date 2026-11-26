# Kokoro ONNX deploy

CPU-only. This does not touch `echomancer-s2-clone` or a GPU. Drew's native
Kokoro speed is **0.88**, applied once in `scripts/sowell/drew.py`
(`DREW_NATIVE_KOKORO_SPEED`). The app still sends 1.0. On this graph 0.88
is about 5–6% longer than 1.0 (123.1 s versus 116.4 s on a two-minute
passage). Style row **300** stays. The take-home cache
key is `drew-kokoro82m-ft-stageA-step00900-style300-<runtime>-speed0.880-g2plex1`.
The worker's `KOKORO_RUNTIME` picks `torch` or `onnx`. The provider stores
the bytes only when `x-kokoro-speed`, `x-kokoro-runtime`, and
`x-kokoro-pronunciation` match that key. Esther, George, and Walter
require the pronunciation header the same way.
A worker that ships before the image refuses the old 0.88 container instead
of caching it, and a torch rollback does not replay an ONNX take. Prosody G
stays off.

A plain `modal deploy` is **torch**: one call per container, `memory=6144`.
`KOKORO_RUNTIME=onnx` is the opt-in. `max_containers` is a container count
on both runtimes (default 16, clamp 1..16). ONNX serves 4 calls in each
container, so 12 containers are 48 calls and 16 are 64. The worker's call
ceiling matches that. A 16-minute book is sized at one container per 80 s
of audio, which is 12 containers, and its sections default to about 350
characters (`KOKORO_RUNTIME=onnx`). Torch keeps 700-character sections and
one call per container when `KOKORO_RUNTIME` is unset.

ONNX memory defaults to **6144** MB. Four concurrent Drew sections peaked
at 5.9 GB, and at 5.0 GB with `enable_mem_pattern=False` and arena
`kSameAsRequested` (both set on the session). Modal `memory=` is a
scheduling request, not an OOM guard: a container can still be killed
above it. `x-kokoro-rss-mb` is `ru_maxrss`. `x-kokoro-cgroup-mb` is the
cgroup peak when that file exists, and the same RSS figure otherwise.

## 1. The image needs Walter's pack

`workers/sowell/Dockerfile` copies `voices/sowell/am_sowell_avg.pt`. That
file is gitignored. A build machine without it fails at `COPY`. The hash in
`voices/sowell/manifest.json` is
`a9fa4422864e0048d035ead9ad6a304170f73aec409271903b05c9a789c7510d`.

## 2. Export Drew before the ONNX app serves him

Drew's graph is not in the image. Until
`/kokoro/retrain_v3/stageA/onnx/manifest.json` exists on the volume the app
mounts, an ONNX Drew request is 503 `DREW_UNAVAILABLE`. There is no torch
fallback inside the ONNX process.

The test volume `echomancer-onnx-test331` already holds a matching export
at volume path `/drew` (`drew.onnx`, `drew.npy`, `manifest.json`, style
index 300). The volume mounts at `/andrew-distill`, so the container
reads it at `/andrew-distill/drew`.
Its `kmodelSha256` is
`6ebdc982990b45aacf6113525fc659d2f71fb9cebd11c1f9386876e3b3792371` and its
`voiceSha256` is
`e821f9c3553dbcb1e50f1e8c78d4ddad57e66f9f3cbe148b0e48884e5e4f93b0`. Those
are the SHA-256 of `andrew-distill`
`/kokoro/retrain_v3/stageA/step00900_kmodel.pth` and `step00900_voice.pt`
as read on 26 Nov 2026. Re-export only if those source hashes change.

Production export writes the production volume. It is an owner command.
Do not run it from an agent, and do not point `DREW_VOLUME_NAME` at
`andrew-distill` on a test app (`Volume.from_name(..., create_if_missing=True)`
would create a volume if the name were wrong, and `export_drew_onnx`
commits the mounted volume).

```bash
# Owner, production volume. CPU only. One container.
modal run modal/sowell_worker.py::export_drew_onnx
```

A test export uses a different volume and does not commit `andrew-distill`:

```bash
SOWELL_APP_NAME=echomancer-sowell-onnxtest331 \
SOWELL_SECRET_NAME=echomancer-sowell-onnxtest331 \
DREW_VOLUME_NAME=echomancer-onnx-test331 \
DREW_ONNX_DIR=/andrew-distill/drew \
modal run modal/sowell_worker.py::export_drew_onnx
```

`read_manifest` refuses the files if the hashes drift.

## 3. Deploy

```bash
SOWELL_APP_NAME=echomancer-sowell \
KOKORO_RUNTIME=onnx \
modal deploy modal/sowell_worker.py
```

`KOKORO_RUNTIME` is read at deploy and baked into the image env. A later
shell export does not change a running container. `SOWELL_MAX_CONTAINERS`
is the container count, not the call count. The ONNX opt-in is 16
containers by default, each `cpu=2`, `memory=6144`, and 4 calls
(`@modal.concurrent(max_inputs=4)` plus a semaphore): 64 calls. Set
`SOWELL_MAX_CONTAINERS=12` for the measured 16-minute book (48 calls).
Omit `KOKORO_RUNTIME` and the deploy stays torch: 16 containers, one call
each.

ORT sessions, their thread pools, and the engine locks are created in the
plain `@modal.enter`, after a memory snapshot restores. The snap enter
loads packs and G2P only. A Drew export that is missing at boot is retried
on the next Drew request, under the engine lock. A snapshot taken before
`export_drew_onnx` does not 503 forever.

## 4. Worker env

On the take-home VM, then restart the worker:

```bash
KOKORO_RUNTIME=onnx
KOKORO_STREAMS_PER_CONTAINER=4
KOKORO_CONTAINER_MASTER=1
```

`KOKORO_RUNTIME` on the worker is the same value baked into the image. It
is part of Drew's cache key. Leave it unset while the deploy is still torch.

`KOKORO_STREAMS_PER_CONTAINER` must match the deploy. Unset with
`KOKORO_RUNTIME=onnx` is still 4. Unset with the torch image is the old
lane plan (no audio cap, 700-character sections). Container mastering publishes a
one-call section's MP3 from the Kokoro response. A split section and a
cache hit still master on the CPU app. The book join stays there too.
A Kokoro book fires the existing CPU warm at the start of the tick, on the
same hold and keepalive as a New Book warm, so the join container is
already up. A second tick does not POST again and does not start another
timer.

`DREW_PROSODY_RULES` stays unset. ONNX answers 400 if a body sends
`prosody: "G"`.

## 5. Rollback

Redeploy with `KOKORO_RUNTIME` unset (or `torch`). That forces one stream,
`memory=6144`, and one call per container. `max_containers` stays the
container count. Unset
`KOKORO_RUNTIME`, `KOKORO_STREAMS_PER_CONTAINER`, and
`KOKORO_CONTAINER_MASTER` on the worker and restart it. Torch reads the
checkpoint from the volume; it does not need the ONNX export. Drew's cache
key changes with the runtime, so ONNX sections are not replayed. New torch
sections use Kokoro speed 0.88.

## 6. Picker sample

`public/voice-previews/drew.mp3` is Kokoro **0.88**, style row 300, which
matches `DREW_NATIVE_KOKORO_SPEED`. Re-record it if that constant changes.
