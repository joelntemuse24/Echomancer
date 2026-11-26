# Kokoro ONNX lean runtime: handoff (26 Nov 2026, 03:10 GMT)

Branch `cursor/kokoro-onnx-lean`. It holds work in progress and has **not** been tested end to end. Nothing is deployed, nothing is merged, and the production worker was not touched.

## Goal (Joel's brief)
- A lean CPU-only Kokoro image with no CUDA torch.
- ONNX fp32, with 4 concurrent calls × 1 thread per container (cpu=2).
- Memory sized to the measured peak.
- Mastering inside the Kokoro container, so there is no `echomancer-cpu` hop for Kokoro sections. The book join stays where it is.
- Lanes sized at about 1 container per 80 seconds of audio on ONNX.
- Keep the torch fallback flag. The image is provider-agnostic.
- Quality gate: WER not worse, no artifacts or clipping, and it must match the ONNX Drew sample Joel approved (`drew_onnx32_4x1_s1`: a single-file export with **no prosody G**). Joel said that sample sounded better than prod. **Do not** do the two-graph split to restore G.
- Drew's native Kokoro speed is **1.0** (Joel, by ear). Style row 300 stays.
- Tests and CI must pass. Measure on throwaway Modal apps (budget < $0.75): wall time, billed and modelled cost for the 16-minute book versus today, and peak RAM.

## Done (in this branch)
- `scripts/sowell/phoneme_runs.py`: the torch-free chunking (PHONEME_CAP, `iter_phoneme_runs`, `words`), moved out of `engine.py`. `engine.py` imports it, so the behaviour is unchanged.
- `scripts/sowell/onnx_export.py`: exports through Kokoro 0.9.4 `KModelForONNX` (`disable_complex=True`, opset 17) as one graph: `input_ids`, `style[1,256]`, `speed` → waveform. It does not carry prosody G.
  - `stock`: the pinned `kokoro-v1_0.pth` → `kokoro-v1_0.onnx`, plus pinned `.npy` packs for am_sowell (Walter, the private pack), bm_george and af_heart, plus `vocab.json`. This runs at **image build** into `/opt/sowell/onnx`.
  - `drew`: Drew's private checkpoint on Modal volume **`andrew-distill`** (`/kokoro/retrain_v3/stageA/step00900_kmodel.pth`, pack `step00900_voice.pt`) → `drew.onnx` + `drew.npy`. The pack is pinned to fixed style row 300, which Joel confirmed is essential.
  - The default output is `/andrew-distill/kokoro/retrain_v3/stageA/onnx` (`DREW_ONNX_DIR` overrides it). Every file's SHA-256 goes into `manifest.json`, and the runtime refuses a mismatch. Drew's weights never go into the image or git.
- `scripts/sowell/onnx_engine.py` (`OnnxEngine`) has no torch import.
  - It uses the same misaki G2P, chunking, vocab, pinned style rows and Drew speed mapping as the torch engine.
  - There is one ORT session per model, shared by concurrent requests. Each has `KOKORO_ONNX_THREADS` (default 1). The CPU arena stays on: it measured faster and smaller than with it off.
  - `block_torch_import()` keeps spaCy/thinc from importing torch, which saves about 1 GB of RSS per process. This needs `spacy-curated-transformers` uninstalled, which the Dockerfile does.
- `scripts/sowell/pack.py`: torch is now imported lazily, inside the loaders. The first Modal smoke test crashed here (see Known problems).
- `scripts/sowell/master.py`: section mastering in the container. It runs the ffmpeg graphs the worker sends (two-pass loudnorm ≥ 3 s, short-gain with a BS.1770 port < 3 s). **Verified byte-identical** MP3s against the TS `masterSectionBuffer` on a 23 s section and a 2.2 s section.
- `src/lib/tts/kokoro-master.ts`: `kokoroMasterRecipe()` builds the recipe from the same `mastering.ts` functions, so the two paths can't drift. It also has a bundle parser (MP3 + WAV in one body, with lengths in `x-kokoro-mp3-bytes` / `x-kokoro-wav-bytes`). It is gated by `KOKORO_CONTAINER_MASTER=1` (default off).
- Providers `sowell`, `drew`, `george` and `heart` send `master` only for one-call sections and return `SynthesizeResult.mastered`.
  - `process-job.ts` passes `premastered` to `commitSectionAudio`.
  - `section-publish.ts` publishes it straight to `sections/NNNN.mp3` (the raw WAV is still kept under `raw/`) when the chain is podcast, no QA is deferred, and the audio isn't silent. Otherwise the old CPU task runs.
- `kokoro-pool.ts`: `kokoroStreamsPerContainer()` (`KOKORO_STREAMS_PER_CONTAINER`, unset and not ONNX = old behaviour) and `kokoroAudioLaneCap()`. ONNX lanes are one container per 80 s of audio, so the 16-minute book gets 12 containers and 48 calls. `planKokoroBookLanes` takes `remainingChars` and `streamsPerContainer`.
- `modal/sowell_worker.py`:
  - `KOKORO_RUNTIME` (deploy-time `torch` default | `onnx` opt-in, baked into the container env).
  - `@modal.concurrent(max_inputs=KOKORO_STREAMS)` with a `BoundedSemaphore` gate.
  - `memory_mb()` (ONNX default 6144, measured 5.0–5.9 GB; torch stays at 6144). A plain deploy is torch. Modal `memory=` is a request, not an OOM guard.
  - `max_containers` counts containers (default 16). ONNX is 4 calls each, so 48–64 calls.
  - Prosody G is refused on ONNX with a 400. The prod worker default `DREW_PROSODY_RULES` is off, so prod doesn't send G.
  - Optional `master` gives a bundle response; if mastering fails, it returns a plain WAV with `x-kokoro-master-error`.
  - A new `export_drew_onnx` function (`modal run modal/sowell_worker.py::export_drew_onnx`) writes into the andrew-distill volume. It has **not been run against the prod volume**.
- `workers/sowell/Dockerfile`:
  - Installs `torch==2.15.0+cpu` from the PyTorch CPU index first, then asserts the build is `+cpu`, that there are no `nvidia-*` wheels, and that ORT has the CPU provider.
  - `requirements.txt` adds `onnxruntime==1.20.1` and `onnx==1.17.0`.
  - Uninstalls `spacy-curated-transformers`.
  - Exports the stock ONNX at build time and verifies its manifest.
  - Image env defaults to `KOKORO_RUNTIME=torch` and `KOKORO_STREAMS=1`. The ONNX deploy bakes `onnx` and 4 streams over that.
  - The image **built successfully on Modal**, including the stock export.

## Left to do
1. Redeploy the throwaway test app and smoke-test Drew + master. The first smoke returned 500 because of `pack.py`'s top-level `import torch`. That is fixed in this branch but not re-verified on Modal. Check Walter, George and Heart as well.
2. Four concurrent Drew sections peaked at 5.9 GB, 5.0 GB with mem-pattern off and arena `kSameAsRequested`. The ONNX default is 6144 MB. Modal `memory=` does not stop an OOM above that.
3. Run the 16-minute-book measurement with the harness pattern from PR 331's test (25 sections, Christmas Carol stave 1, 15.7k chars, Drew):
   - 13–16 calls against the ONNX test app, with master in the request.
   - The concat still runs on the CPU app.
   - Measure wall time, billed cost (Modal billing per app and hour) and modelled cost against today: post-331 prod, CPU_SCALEDOWN 10.
4. Quality gate: WER (faster-whisper small.en) against torch prod on the same passage for Drew, Walter, George and Heart, and check for clipping (peak/NaN). A/B samples of the same 30 s passage (prod vs new) go to `samples/`.
5. Tests: add vitest for `kokoro-master.ts` (bundle parse, recipe), `kokoro-pool` audio cap, `section-publish` premastered path and the providers' bundle handling. Add pytest for `master.py` (js_number, probe parse, linear_af), `onnx_engine` (manifest hash, torch block) and `sowell_worker` helpers (`kokoro_runtime`, `kokoro_streams`, `memory_mb`, `max_containers`). Existing tests that assert `max_inputs=1`, `memory=6144`, the gate Lock and the Dockerfile text may need updating. Run `npm run typecheck` (passed locally), lint and vitest, plus the modal/ pytest suite and CI.
6. Rebase conflicts with main after the 331 merge, if any.
7. Runbook for Joel:
   - Run `export_drew_onnx` once (it writes `/andrew-distill/kokoro/retrain_v3/stageA/onnx`).
   - Deploy with `KOKORO_RUNTIME=onnx`.
   - Set worker env `KOKORO_STREAMS_PER_CONTAINER=4` and `KOKORO_CONTAINER_MASTER=1`.
   - To roll back: `KOKORO_RUNTIME=torch` redeploy, and unset the two worker env vars.
   - Note that Drew answers 503 on ONNX until the export exists.
8. `DREW_NATIVE_KOKORO_SPEED` is **1.0**. Joel picked it by ear. The cache variant is `v3` so a 0.88 take is not replayed. Style row 300 is unchanged.

## Test results so far
- Earlier Modal benchmark (OPTIMISE.md, Nov 25–26): ONNX fp32 with 4 procs × 1 thread gave **1.57×** the audio per core-second of torch's 1 × 4 threads, with identical WER.
  - Speaker cosine against torch was 0.965 for Drew and 0.984 for Walter, because the ONNX path has no G and uses a different STFT. Joel listened and approved the ONNX sound.
- Local box (Intel Xeon, ORT 1.20.1, stock model, Walter):
  - 1 thread sequential: 92.8 s of audio in 46.5 s, process peak **1.53 GB** with the arena on (arena off: 62 s and 1.98 GB).
  - 4 concurrent requests in one process (shared session): 115.9 s of audio in 19.2 s, maxrss **2.64 GB**. torch was not imported.
  - Adding Drew's graph should add about 0.35 GB, so the estimated 4-stream container peak is about 3–3.5 GB. **Measure it.**
- Mastering parity: Python and TS produce byte-identical MP3s on both paths.
- The Modal image build (CPU torch, ORT, stock export) succeeded. The Drew export ran on Modal in a throwaway app. The output went to the **test volume `echomancer-onnx-test331`** at volume path `/drew`. The volume mounts at `/andrew-distill`, so the container path is `/andrew-distill/drew`. It was not written to the production volume.

## Drew speed study (Joel's question about 0.88)
I used 28 real Edge Andrew clips (623 words) from `andrew-distill` `/eval/edge_andrew_rate0` and `/dataset_edge`, and rendered Drew (ONNX, fixed row 300) on the same texts.

| | WPM incl. pauses | WPM excl. | syll/s excl. | duration vs Andrew |
|---|---|---|---|---|
| Edge Andrew | 182.5 | 200.2 | 5.13 | 1.00 |
| Drew 0.88 (current) | 169.0 | 186.5 | 4.78 | 1.09 |
| Drew 0.95 | 175.5 | 192.7 | 4.94 | 1.05 |
| Drew 1.0 | 179.1 | 196.0 | 5.02 | 1.02 |

So 1.0 is the closest match; about 1.04 would match exactly. 0.88 is 8–9% slower than Andrew. Joel then picked 1.0 by ear. `DREW_NATIVE_KOKORO_SPEED` is 1.0 on both the torch and ONNX paths. The table is the measurement, not the current default.

## Samples made (on the box: the operator box (samples dir))
Same ~35 s passage throughout:
- `andrew_edge_reference.mp3`
- `drew_speed_0.88.mp3`, `drew_speed_0.95.mp3`, `drew_speed_1.0.mp3`
- `drew_nofixedstyle.mp3`: speed 0.88 with pack[len-1] instead of row 300. This is a listening sample only.

Earlier ONNX/torch A/B samples are on the operator box. The prod vs new A/B for this PR is **not made yet**.

## Known problems / risks
- `pack.py` torch import: fixed, but not re-verified on Modal.
- ORT sessions are created in the plain enter, after restore. A live restore on Modal is still unmeasured here.
- `ONNX_MEMORY_MB=6144` is the measured default (peak 5.0–5.9 GB). Modal `memory=` is a request, not an OOM guard.
- G2P runs under one lock across the 4 streams. That is about 0.2% of section time, so it should be fine.
- The Drew ONNX export must exist before an ONNX deploy, or Drew (the default narrator) returns 503. There is no automatic fallback to torch inside the ONNX process, because torch is blocked there.
- `KOKORO_STREAMS_PER_CONTAINER` on the worker must match the deploy (4 on ONNX). With the torch fallback deploy, unset it.
- Split (multi-call) sections and cached sections still go through the CPU master task. That is correct, but the CPU app hop is not fully gone for those.
- A blob-download stall from Modal function results (>~10 MB) hit again. Write outputs to a test volume and use `modal volume get`.
- The throwaway Modal resources are left in place: the secret `echomancer-sowell-onnxtest331` and the volume `echomancer-onnx-test331` (it holds Drew's ONNX export, which is private). The apps were permanently stopped (`modal app stop`), so they cannot be called again. Delete the secret and volume once they're no longer needed.
- This checkout does not contain `voices/sowell/am_sowell_avg.pt` (gitignored). A new image build fails at that `COPY`. The stopped test app cannot be used to extract the pack.
- The test-volume export matches the source checkpoint (26 Nov 2026): kmodel `6ebdc982990b45aacf6113525fc659d2f71fb9cebd11c1f9386876e3b3792371`, voice `e821f9c3553dbcb1e50f1e8c78d4ddad57e66f9f3cbe148b0e48884e5e4f93b0`, style index 300. On the volume the directory is `/drew`. In the container, because the volume mounts at `/andrew-distill`, that is `/andrew-distill/drew`. `DREW_ONNX_DIR=/drew` does not see it. Do not re-export until those source hashes change. The comparison was a read of `andrew-distill`; nothing was written there.
- Modal spend so far this phase: Drew export plus 3 render jobs plus 2 short deploys, roughly $0.10–0.15 (estimated, not checked against billing).
