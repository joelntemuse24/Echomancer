# fish-scales-ops 0.3.0 vs Echomancer S2 clone serving

Research note, 2026-11-25. No GPU was run. Modal was not called. Numbers
taken from this repo and from fish-scales-ops `HEAD` (README says version
0.3.0, changelog date 2026-11-09). A GitHub tag `v0.3.0` did not resolve.
Anything not measured on our H100 is marked **unverified**.

## Summary

| Question | Answer |
|---|---|
| What we run | Custom batched Dual-AR loop on fish-speech's own `DualARTransformer`, bf16, `torch.compile` + CUDA graphs, one H100, GPU memory snapshot. Not SGLang, not vLLM. |
| Does fso support that GPU? | Kernels are sm_90. Published tables are **H200 only**, not H100. |
| Relevant speedup | Family A MLP (same dims as S2's backbone) is **1.74× vs torch bf16 at M=1** and **1.78× at M=32**, on H200. Attention on Hopper is stock SDPA. S2 is dense, not MoE. |
| Likely book-level effect | **About 1.3–1.6×** on decode wall, **unverified**, and only if batch-invariant mode keeps most of that. GPU $ moves by that factor, not by a new order of magnitude. |
| Does fish-speech already use it? | **No** `fish_scales_ops` hits on the public fish-speech default branch. |
| Adopt now? | **No.** Measure the already-written v10 CUDA-graph path first. fso needs a torch 2.8+cu128 → 2.13+cu130 jump, a snapshot rebuild, and an audio A/B. |

## 1. How Echomancer serves S2

Production app is `echomancer-s2-clone` (`modal/s2_clone_service.py`). It
imports the engine from `modal/s2_batch.py`. The batch file's own Modal app
name (`echomancer-s2-batch`) is the bench entry; the live class is
`S2CloneWorker`.

**Engine.** `_BatchEngine` loads `fishaudio/s2-pro` through fish-speech's
`DualARTransformer.from_pretrained` and casts it to **bfloat16**
(`modal/s2_batch.py` around the `self.dtype = torch.bfloat16` assignment).
The image checkouts fish-speech at
`541566932abbaebcb0a40e562a1f846738383f38` and installs that repo's
**`cu128` extra**, which pins **`torch==2.8.0`** (fish-speech
`pyproject.toml` at that commit). There is no SGLang or vLLM import on
this path. The model card's "SGLang-based streaming inference engine" is
Fish's description of the release, not what this container runs.

**What a step does.** One audio frame is one compiled `_decode_step`:
36 slow layers (attention + SwiGLU), a sliced LM head
(`F.linear` on `embeddings.weight` rows for the semantic ids only, ~4096
wide — the comment in `_logits_to_probs` says the sample is over a
4,096-wide vocabulary, not the 155,776 text vocab), then the fast AR
(`num_codebooks` steps, 10 codebooks in the Hub config, so 10 fast
forwards including the position-0 write). The fast stack is 4 layers of
the same width. The DAC codec (`modded_dac_vq`, `codec.pth` ~1.9 GB) runs
after the codes exist. v10 can overlap it; **v9 does not**
(`S2B_PIPELINE_CODEC` defaults off when `S2C_ENGINE` is unset).

**Production engine is v9.** `S2C_ENGINE` defaults to `v9`.
`_render_legacy` sets `b = BATCH` (default **32**) and prefills with
`width=BATCH`. A one-section call still launches a 32-row GEMM; idle rows
are padding. v10 (`S2B_BUCKET`, fast decode, work stealing) is in this
tree and is not what a plain deploy runs.

**Compile and graphs.** `_compile_step` is
`torch.compile(..., mode="reduce-overhead" if S2B_CUDAGRAPHS else "default", fullgraph=True, dynamic=True)`.
`S2B_CUDAGRAPHS` defaults on. The v9 sample path still calls upstream
`logits_to_probs`, which the file itself says puts a CPU `-inf` into the
graph and makes Inductor **skip CUDA graphs**. That skip is the deployed
behaviour; v10's tensor `masked_fill` exists to remove it. Whether a live
container actually logs `cudagraph_skips` was **not** read (no Modal).

**GPU and snapshot.** Default `S2B_GPU` is `H100!` so Modal does not
place an H200 (snapshots are per GPU type). `S2CloneWorker` sets
`enable_memory_snapshot=True` and `enable_gpu_snapshot`, loads and warms
inside `@modal.enter(snap=True)` on a dedicated GPU thread, then
`reset_state()` so customer audio is not in the snapshot.
`@modal.concurrent(max_inputs=2)` allows one render plus one light call.
Production `max_containers` stays 1. Inductor/Triton caches sit on the
`echomancer-compile-cache` volume, keyed by torch, GPU, engine, and a
source stamp.

**Batching.** KV capacity is 32 × 4096. A book is one container. Section
0 is one row; later pages are many rows in one call (planner ceiling 24
inline, 32 only after `/ready` reports R2 transport). Measured in-repo
rates, not re-measured here: ~2.8× realtime for one row, ~9.2× at four
rows, ~33× at 24 rows on the 2026-11-11/12 smokes. The code's H100 price
constant is `$0.001097/s`.

**Weights and shape** (Hub `fishaudio/s2-pro` `config.json`, read
2026-11-25; the image does not pin a weight revision, so a deployed
snapshot **might** differ):

| | Slow AR (`text_config`) | Fast AR (`audio_decoder_config`) |
|---|---|---|
| `dim` | 2560 | 2560 |
| `n_layer` | 36 | 4 |
| `intermediate_size` | 9728 | 9728 |
| heads | 32 query / 8 KV, head 128 | same |
| `use_moe` | false | false |
| vocab | 155,776 (head is sliced) | 4,096 |
| checkpoint dtype | `bfloat16` | (same file) |

Parameter check: `model-00001` + `model-00002` ≈ 9.1 GB, about 4.55 B
bf16 parameters. The model card says slow AR ~4 B and fast AR ~400 M.
`K` and `N` of wqkv (6144×2560), wo (2560×4096), gate_up (19456×2560)
and down (2560×9728) are multiples of 128. There is **no FP8 checkpoint**.

Per frame the slow stack reads ~7–8 GB of bf16 weights and the fast
stack about the same again across 10 steps (~15 GB total). That matches
the comment at the top of `s2_batch.py`. At a 2,048-token KV the
attention read is a few percent of that, so decode is bandwidth-bound
on the linears. **Unverified** split of a real step's wall time.

## 2. What fish-scales-ops 0.3.0 actually is

Block-FP8 / MXFP8 GEMM, MoE, and attention as a PyTorch extension.
`fso.dense.linear` takes bf16 activations, quantizes inside the op, and
returns bf16. There is **no bf16 GEMM** in the library. Ops are custom
ops with fake implementations, so they sit under `torch.compile` and
inside CUDA graphs after one eager call of that shape (sm_90 also
JIT-compiles the kernel on that first call, via bundled NVRTC 13.0.88).

| | H200 sm_90 | B200/B300 sm_100/103 | RTX 5090 sm_120 |
|---|---|---|---|
| Dense | block-FP8 1×128 | MXFP8 1×32 | MXFP8 1×32 |
| MoE | block-FP8 | MXFP8 | MXFP8 |
| Attention | **torch SDPA** | torch SDPA | MXFP8 kernels, else SDPA |

**H100.** sm_90 is the Hopper ISA (H100 and H200). The library never
names H100. Every sm_90 table is an H200 at stock clocks, 132 SMs.
H100 SXM HBM3 is ~3.35 TB/s; H200 HBM3e is ~4.8 TB/s. Decode cells are
at 5–160 TFLOPS, far under FP8 peak, so they are bandwidth-bound.
**Estimate, unverified:** H100 absolute µs ≈ H200 µs × ~1.4; the
fp8/bf16 **ratio** should be similar if both precisions are
bandwidth-bound. A kernel that is launch-overhead bound would move less.

**Install.** The wheel refuses any torch other than **2.13.0+cu130**,
Python 3.12, driver that can run CUDA 13 (tables used driver 595). An
in-place build allows torch ≥ 2.11 with a CUDA 13 runtime, and the sm_90
JIT then needs the source tree (`FSO_JIT_INCLUDE_DIRS`). Our image is
torch 2.8.0+cu128. The wheel will not import.

**Shapes that match S2.** Family A in `docs/perf/` is Qwen3-4B dense,
36 layers: wqkv 6144×2560, wo 2560×4096, gate_up 19456×2560, down
2560×9728. That is the slow AR (and the fast AR's per-layer GEMMs).
Families B and C are MoE. S2 sets `use_moe: false`. The MoE kernels do
not apply. The "audio tower" `conv_out` cells in the changelog are not
this Dual-AR loop; our codec is a separate conv net the library does not
wrap.

**H200 MLP block vs torch bf16** (`docs/perf/layer/sm90.md`, CUDA-graph
replay, cold weights, cosine of the block output vs bf16):

| M | bf16 µs | block-FP8 µs | ratio | cosine |
|--:|--------:|-------------:|------:|-------:|
| 1 | 48.87 | 28.09 | 1.74× | 0.9980 |
| 8 | 52.10 | 28.77 | 1.81× | 0.9980 |
| 32 | 54.14 | 30.48 | 1.78× | 0.9980 |
| 512 | 136.27 | 83.84 | 1.63× | 0.9980 |

`model ms` at M=1 is 1.01 ms, which is 36 × 28 µs: MLP only, no
attention, no fast AR. Decode-band geometric mean vs torch bf16 is
1.74×; vs cuBLAS block-FP8 `scaled_mm` 1.58×; vs SGLang DeepGEMM 1.21×.
SGLang is faster than fso at M=160 (4.9%) and M=1024 (2.1%).

**Batch invariance.** 0.3.0's split-K routes are **on by default** and
change a row's bytes when M crosses a band boundary (~0.01% of elements,
one ulp). `FSO_BATCH_INVARIANT=1` disables those routes on sm_90. The
table above is the 0.3.0 remeasure, so it **includes** split-K. Our v9
loop always uses M=32, so a single call is internally consistent, but a
later v10 bucket (M=1 vs M=24) would sample different tokens.
**Unverified** how much of the 1.74× remains with the flag on. For a
clone, the flag should be on.

**Fish's own server.** GitHub code search of `fishaudio/fish-speech` for
`fish_scales_ops` returned zero files. SGLang hits are translated docs,
not an engine import. fso's own MoE bench text mentions an internal
stack it calls "apex" that serves SGLang Triton configs and can serve
fso. That code is not in the public fish-speech tree. No public issue
or changelog line says fish-speech will vendor this library.
**Unverified** whether Fish's hosted API uses it.

## 3. Comparison

**Decode speedup for our calls.** v9 already steps M=32, and the H200
MLP barely changes from M=1 to M=32 (49 → 54 µs bf16). So a
one-section call and a full page see almost the same GEMM speedup:
about **1.7× on the MLP block**, not 2×. Hopper attention is unchanged
SDPA. The fast AR is the same GEMMs, short KV, so it should track the
MLP ratio. Sampling, norms, the host sync every 8 steps, and a skipped
CUDA graph are not in the fso table.

If linears are ~80% of a v9 step (plausible from the 15 GB/frame weight
traffic, **unverified**), end-to-end decode is about
`1 / (0.80/1.75 + 0.20) ≈ 1.5×`. A honest band is **1.3–1.6×**. It is
not 2×, and it shrinks if v9 is launch-overhead bound because graphs
are skipped — in that case fixing graphs beats FP8. Prefill (one prompt
per unit, M = prompt length, often a few hundred tokens) is ~1.6× on
the MLP and is a small slice of a 1,024-frame unit.

**Cost.** At `$0.001097/s`, a 1.5× decode cut on a generation that
really is ~206 s for 10 h of audio (the planner figure in `AGENTS.md`)
is about **$0.23 → ~$0.15** of GPU for that generation, plus the same
cold start (~60–70 s, ~$0.07) either way. The same guide's "**about
$1.62**" for that 206 s does **not** match `$0.001097 × 206`. Treat
$1.62 as an unresolved older or broader figure. Either way, FP8 does
not move a book by euros; the €4.50 target is not set by this kernel.
A snapshot rebuild's first compile (the code comments say 15+ minutes)
is about **$1** by itself.

**Quality.** Cosine 0.998 is one MLP block against bf16, not 36 layers
× ~1,000 autoregressive frames × 10 fast steps. Autoregressive sampling
turns a 1-ulp logit change into a different token. Block-FP8 here is
on-the-fly from the bf16 checkpoint (`prepare_weight(..., format="bsfp8")`
with no scale tensor), a second rounding, not a calibrated FP8
checkpoint. Timbre is the risk that matters for a clone; Whisper WER
only catches dropped words. **No S2 audio has been scored.**

**Cold start.** Any image change (torch, the wheel, a swapped linear)
invalidates the H100 GPU snapshot. sm_90 kernels JIT on first eager
call; that call has to happen inside `enter(snap=True)` before
`torch.compile` captures, or the first book pays the JIT and can
capture a graph too late. The compile-cache volume does not store fso's
NVRTC cubin unless we put it there. Weight memory drops by about half
of 9 GB after the bf16 copy is freed; 80 GB is not the limit today.

**Ops risk.** CUDA 13 on Modal's H100 host driver is **unverified**. If
the driver cannot run cu130, the container never starts. Production
`max_containers` must stay 1. A mistaken `modal deploy` of
`echomancer-s2-clone` wipes production snapshots. fso's default
split-K is not batch-invariant.

**Other cheaper wins**

| Idea | Why it is or isn't cheaper |
|---|---|
| Confirm v9 CUDA-graph skips, then measure v10 | Already in `s2_batch.py`. No torch upgrade. The file says the v9 sampler is why graphs are skipped, and that launch overhead dominates a decode step. This can beat a 1.5× GEMM cut. v10 also changes RNG consumption, so it is an audio A/B, not a silent flip. |
| Per-tensor FP8 on torch 2.8 | Avoids the 2.13 pin. cuBLAS block-FP8 in the fso tables needs CUDA 13.1, and fso is 1.58× faster than that `scaled_mm` path. A weaker FP8 kernel plus the same quality risk is a worse trade. |
| RTX 5090 | Supported (sm_120), and it is the only place fso has a real attention kernel. Published M=1 `gate_up` is 35.9 µs vs 16.7 µs on H200, about 2× slower, before price. Our snapshots are H100-only. **Not** a drop-in. |
| L40S | Ada, sm_89. **Not a supported architecture.** |
| H200 | Same sm_90 kernels, more bandwidth. The `H100!` pin exists so a placement does not miss the snapshot. A move is a new snapshot and a higher $/s. **Unverified** whether bandwidth pays for the price. |

## 4. Recommendation

Do not integrate fish-scales-ops into `echomancer-s2-clone` on the
strength of the H200 tables. The library is a real Hopper FP8 GEMM, and
Family A is the right shape, but the expected win on our step is
roughly **1.3–1.6× decode**, the quality risk is an autoregressive
clone, and the integration is a CUDA-major torch upgrade plus a
snapshot rebuild. MoE and Blackwell attention do not help this model
on an H100.

Before any FP8 work, after 1 Dec, spend the first H100 hour on the
question the code already asks: does production v9 log
`cudagraph_skips`, and what does v10's graph-clean step do to
frames/s and to Whisper on one fixed clip? That experiment uses the
current image.

## 5. Experiment after 1 Dec (one H100, about $1–2)

Owner approval is required. Staging app only
(`S2C_APP_NAME=echomancer-s2-clone-staging`). Do not deploy
`echomancer-s2-clone`. Do not raise `max_containers`. Stop at 20
minutes of GPU (~$1.32 at `$0.001097/s`) even if the run is unfinished.

**A — graph question, current image (do this first)**

1. Read-only: staging `/ready` and a boot log. Fail the FP8 idea's
   priority if `cudagraph_skips` is non-zero — fix that before FP8.
2. One staging call, v9 vs `S2C_ENGINE=v10`, same reference, same
   200-character sentence, same seed, one row. Exclude restore time.
3. Pass: v10 frames/s ≥ 1.25× v9, Whisper WER within +0.02 absolute,
   no truncated unit. Fail: graphs still skip, or WER moves more than
   that. This is the runbook's existing A/B, not a new kernel.

**B — fso, only if A shows graphs already work and GEMM is the wall**

1. A throwaway staging image, not production. `nvidia-smi` first. If
   the driver cannot run CUDA 13, **stop**. That check should cost
   seconds.
2. torch 2.13.0+cu130, Python 3.12, `fish_scales_ops` 0.3.0 wheel
   `--no-deps`, `FSO_BATCH_INVARIANT=1`. Load the existing bf16
   checkpoint and `prepare_weight(w, format="bsfp8")` for wqkv, wo,
   and the SwiGLU linears of both slow and fast stacks. Leave
   attention, norms, embeddings, the sliced head, sampling, and the
   DAC codec on the current bf16 path. Eager-call M=32 (and the
   prefill lengths `warm_up` already records) on the GPU thread
   **before** `torch.compile`, inside `enter(snap=True)`.
3. Same clip and seed as A. Time decode only, after the snapshot
   restore, not the compile.
4. Pass: decode ≥ 1.25× the v9 baseline on that same GPU; zero
   `cudagraph_skips`; Whisper WER within +0.02 of the bf16 take; a
   human pass on timbre (speaker-embedding cosine is optional and has
   no calibrated threshold here). Fail: restore+compile burns the 20
   minutes before a timed decode; WER or a dropout/timbre change; the
   import rejects the torch build; split-K is left on
   (`FSO_BATCH_INVARIANT` unset).

Do not treat a layer cosine of 0.998 as a pass. Do not run a full book.
A 20-second clip is enough to accept or reject the kernel.
