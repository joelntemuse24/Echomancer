# Nari Qwen3-TTS serving, compared with the S2 clone engine

Reviewed 2026-11-07 from GitHub. No Nari source is copied into this repo.
Apache-2.0 would allow a later copy only with its copyright and license
notice kept, and only if the code still matches this engine. The Qwen
talker, codec, and CUDA-graph kernels do not. Qwen3-TTS is not a
substitute for S2-Pro.

## Pinned sources

| Repo | Commit | License | What was read |
|---|---|---|---|
| [nari-labs/nari-qwen3-tts](https://github.com/nari-labs/nari-qwen3-tts) | [`e8c5b2bf6d65a965037f161d713bfa3e8856feb3`](https://github.com/nari-labs/nari-qwen3-tts/commit/e8c5b2bf6d65a965037f161d713bfa3e8856feb3) (2026-08-19, `feat: initial commit`) | Apache-2.0, [LICENSE](https://github.com/nari-labs/nari-qwen3-tts/blob/e8c5b2bf6d65a965037f161d713bfa3e8856feb3/LICENSE). No `NOTICE` file. | Engine, planner, profile, graph capture |
| [nari-labs/benchmarks](https://github.com/nari-labs/benchmarks) | [`a2d65e16fa121d9dbd80dfbb0cf1007563f96509`](https://github.com/nari-labs/benchmarks/commit/a2d65e16fa121d9dbd80dfbb0cf1007563f96509) (2026-08-19) | Apache-2.0 | Methodology and the Qwen3-TTS report |

Permalinks for the mechanisms below:

- [`planner/policy.py`](https://github.com/nari-labs/nari-qwen3-tts/blob/e8c5b2bf6d65a965037f161d713bfa3e8856feb3/src/nari_qwen3_tts/planner/policy.py) — round-robin, first-pass precedence, deadline-aware codec
- [`planner/planner.py`](https://github.com/nari-labs/nari-qwen3-tts/blob/e8c5b2bf6d65a965037f161d713bfa3e8856feb3/src/nari_qwen3_tts/planner/planner.py) — `Planner.plan` packs one compatible cohort into a captured batch
- [`engine/engine.py`](https://github.com/nari-labs/nari-qwen3-tts/blob/e8c5b2bf6d65a965037f161d713bfa3e8856feb3/src/nari_qwen3_tts/engine/engine.py) — single engine thread, bounded command queue, cancel, readiness
- [`profiles/ttfa.yaml`](https://github.com/nari-labs/nari-qwen3-tts/blob/e8c5b2bf6d65a965037f161d713bfa3e8856feb3/src/nari_qwen3_tts/profiles/ttfa.yaml) — static batch sizes, token buckets, codec chunk schedule, KV pages
- [`executor/cuda_graph.py`](https://github.com/nari-labs/nari-qwen3-tts/blob/e8c5b2bf6d65a965037f161d713bfa3e8856feb3/src/nari_qwen3_tts/executor/cuda_graph.py) — warmup iterations, then `torch.cuda.CUDAGraph` replay
- [Benchmark methodology](https://github.com/nari-labs/benchmarks/blob/a2d65e16fa121d9dbd80dfbb0cf1007563f96509/docs/tts_bench/methodology.md)
- [Nari Qwen3-TTS report](https://github.com/nari-labs/benchmarks/blob/a2d65e16fa121d9dbd80dfbb0cf1007563f96509/reports/Qwen3-TTS-1.7B-CustomVoice/Nari-Qwen3-TTS/README.md)

## What the sub-50 ms figure is

The report's median p95 audible TTFA on profile `ttfa` is **34.114 ms at
10 RPS** and **26.523 ms at 1 RPS**. At 20 RPS the profile is `balanced`
and the same median p95 is **77.231 ms**. The README's "sub-50 ms" and
"sub-80 ms" lines match those rows.

Audible TTFA is the first detected audible PCM sample minus dispatch
(methodology §4). Dispatch is the first JSON body byte on localhost.
The client and server share one GCE `a3-highgpu-1g` (one H100 SXM 80GB)
in `asia-east1-c`. Each trial is a fresh container with the model cache
mounted read-only, `QWEN3_TTS_LOCAL_FILES_ONLY=1`, and a real PCM
readiness check before measurement. Readiness stays false until CUDA
graph capture and a warmup TTS request have both finished
(`README.md` in the serving repo). Traffic is then a 30-second
load-shaped warmup plus open-loop Poisson arrivals. The measured model
is `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` revision
`0c0e3051f131929182e2c023b9537f8b1c68adfe`, voice Ryan, English, streaming
PCM16 mono 24 kHz, `non_streaming_mode=false`. Prompts are the 1,088-row
English Seed-TTS set.

That number is a warm, steady, streaming first-audio sample on an
assigned GPU. It is not a cold start, not scale-to-zero, not a clone of
a customer sample, and not a finished book section. This review did not
re-run the benchmark and does not claim 50 ms for Echomancer.

## What this engine already does that matches the generic ideas

Nari runs one thread that admits requests, picks a stage, and replays a
captured batch. Echomancer's clone path is a Modal HTTP batch of S2-Pro
rows (`modal/s2_contract.py`, `src/lib/tts/providers/modal-clone-dispatch.ts`),
scale-to-zero, one narrator per book.

| Nari mechanism | Where it lives | Echomancer counterpart |
|---|---|---|
| Startup work before steady work. `RoundRobinPolicy` prefers the first codec chunk over other requests' decode. `DeadlineAwarePolicy` ranks startup stages codec, then prefill. | `policy.py` | Section 0 is one lane, published, and only then do other lanes open (`firstLight` in `modal-clone-dispatch.ts`). A batch that includes section 0 holds the first audio until the slowest row returns. |
| Pack only compatible rows, and stop at the capture's batch capacity. | `Planner.plan` | `planModalCloneLanes` fills a call toward `batch` and refuses a row wider than the lane. A pack that misses its budget is retried one section per call. |
| Admit only up to `max_active_requests`. A full command queue raises `ServiceCapacityExceeded`. PCM is capped by `max_buffered_pcm_bytes`. | `engine.py` `_put`, `_handle_submit` | A busy GPU lane answers 429 (`ModalCloneLaneBusyError`). The orchestrator releases that placement and does not start a second container for a live lease. |
| Cancel removes the request from the pipeline, including when the caller's future already timed out (`_orphan_cancellations`). | `engine.py` | A cancelled book is not published. A caller that times out does not cancel the GPU call: the section can still finish and a late completion with the same owner is kept. That is the book contract. Nari's cancel-on-timeout would drop a take the player may already be waiting on. |
| `/ready` is false until graphs and one warmup utterance exist. | `Engine.start` | `/ready` counts live heartbeats for the current build. A cold pool parks the book (`ModalCloneColdError`) instead of failing it or switching voice. The compile stays off the book path. |

The existing S2 notes, not this review, record a warm first section near
16–20 s after a finished restore, and about 68 s when the restore is
still in progress (about 57 s restore plus one short section). Those are
section-audio times on the clone path. They are a different quantity
from a 34 ms audible sample.

## Model-specific. Leave it there

These are why the 34 ms figure is possible, and why copying them onto
S2 would either do nothing or change the voice:

- **Static shapes and CUDA graphs.** `ttfa.yaml` captures talker prefill
  at token buckets 32–640 and batch sizes 1, 2, 4, 8, and codec batches
  at listed frame counts. `cuda_graph.py` warms the op twice, then
  records a `CUDAGraph` into a shared pool. Replay is only valid for
  those tensors. S2's row length follows the narration (`UNIT_MAX_CHARS`
  560, sections near 2,000 characters). Padding text or audio to a
  bucket would change the take. Capture also belongs at snapshot time.
  A book must not wait on it.
- **Codec chunk schedule** `[1, 2, 4, 8, 12]` (frames, 12 Hz model) is
  how the first audible chunk is a few frames and later chunks grow.
  S2 inserts silence at unit boundaries and keeps a paragraph under 560
  characters as one generation so the model places the breaths. That
  width was set from splice counts on real books, not from a frame clock.
- **KV pages** (`kv_pages: 256`, `kv_page_size: 128`, 512 MiB workspace)
  page the Qwen talker's cache. S2's history is one anchor: the row's
  first turn, not a paged decode cache. The two allocators are not
  interchangeable.
- **Streaming input.** WebSocket appends tokens into a live talker.
  Take-home text is known before the GPU call. Live Listen for stock
  voices is a different provider stream, not this container.
- **The model.** CustomVoice Ryan is a stock speaker. An Echomancer
  clone is the customer's reference through Fish S2-Pro. Swapping in
  Qwen would be a different narrator. That is not approved.

## What this review does not change

No serving code, no snapshot recipe, no `min_containers`, no character
cap, no Drama fallback, and no stock-voice list. `modal/s2_contract.py`
stays free of the Nari package. A test reads this file and fails if the
pinned commits disappear or if `nari_qwen3` shows up in the S2 contract
or the batch image.

## Next experiment, when a staging GPU is already up

Do not start a GPU for this question. If a staging container is warm
for another reason, time one synthetic section-0 call and record
`placement_kind`, wall time, and `first_section_at`. Compare that with
the 16–20 s / 68 s notes above. Do not compare it with 34 ms.

A graph-capture experiment is separate and still off the book path:
list the S2 forward shapes that are already fixed (codec frame size,
not text length). If none are fixed, there is nothing to capture. If
one is fixed, replay it on the staging app only, and keep the result
out of `takehomeCacheVariant` unless the audio bytes match the eager
run. A mismatch is a quality change and stops there.
