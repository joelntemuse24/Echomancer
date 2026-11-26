# Kokoro ONNX deploy

CPU-only. This does not touch `echomancer-s2-clone` or a GPU. Drew's native
Kokoro speed is **1.0**, applied once in `scripts/sowell/drew.py`
(`DREW_NATIVE_KOKORO_SPEED`). Style row **300** stays. The take-home cache
variant is `drew-kokoro82m-ft-stageA-step00900-style300-v3`, so a section
recorded at the old 0.88 is not replayed. Prosody G stays off.

`ONNX_MEMORY_MB` still defaults to **3072**. That number is a local estimate
(4-stream stock maxrss 2.64 GB, plus about 0.35 GB for Drew's graph), not a
Modal measurement. Deploy the first ONNX app with `ONNX_MEMORY_MB=5120` so
the container does not OOM, read `x-kokoro-rss-mb` and `x-kokoro-cgroup-mb`
under 4 concurrent Drew calls, then set the code default to that peak plus
headroom before the production deploy. Torch stays `memory=6144` and one
call per container.

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
at `/drew` (`drew.onnx`, `drew.npy`, `manifest.json`, style index 300).
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
DREW_ONNX_DIR=/drew \
modal run modal/sowell_worker.py::export_drew_onnx
```

`read_manifest` refuses the files if the hashes drift.

## 3. Deploy

```bash
SOWELL_APP_NAME=echomancer-sowell \
KOKORO_RUNTIME=onnx \
ONNX_MEMORY_MB=5120 \
modal deploy modal/sowell_worker.py
```

`KOKORO_RUNTIME` is read at deploy and baked into the image env. A later
shell export does not change a running container. `max_containers` becomes
`ceil(SOWELL_MAX_CONTAINERS / KOKORO_STREAMS)`. The defaults are 16 calls
and 4 streams, so 4 containers. Each container still has `cpu=2` and
accepts 4 calls (`@modal.concurrent(max_inputs=4)` plus a semaphore).

After the memory measurement, set `ONNX_MEMORY_MB` to the measured value
(or change `ONNX_MEMORY_MB_DEFAULT` and redeploy without the override).

## 4. Worker env

On the take-home VM, then restart the worker:

```bash
KOKORO_STREAMS_PER_CONTAINER=4
KOKORO_CONTAINER_MASTER=1
```

`KOKORO_STREAMS_PER_CONTAINER` must match the deploy. Unset or `0` is the
torch-era lane plan (no audio cap). Container mastering publishes a
one-call section's MP3 from the Kokoro response. A split section and a
cache hit still master on the CPU app. The book join stays there too.

`DREW_PROSODY_RULES` stays unset. ONNX answers 400 if a body sends
`prosody: "G"`.

## 5. Rollback

Redeploy with `KOKORO_RUNTIME=torch`. That forces one stream, `memory=6144`,
and `max_containers` equal to the call cap. Unset
`KOKORO_STREAMS_PER_CONTAINER` and `KOKORO_CONTAINER_MASTER` on the worker
and restart it. Torch reads the checkpoint from the volume; it does not
need the ONNX export. Sections already stored under `v3` stay. New torch
sections use the same 1.0 speed and the same cache key.

## 6. Picker sample

`public/voice-previews/drew.mp3` was recorded at Kokoro **0.88**. Re-record
it at 1.0, style row 300, before customers hear the new pace in the picker.
The file is not a 1.0 render.
