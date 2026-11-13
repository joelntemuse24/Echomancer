"""Batched Fish Speech S2-Pro on Modal: many passages per GPU, several GPUs per book.

EVALUATION ONLY. S2-Pro weights are under the Fish Audio Research License,
which forbids commercial use without a separate agreement.

Why batching: upstream decodes one sequence at a time, and each audio frame reads
~16 GB of weights, so a GPU is memory-bandwidth bound and mostly idle. Decoding
BATCH rows per step reads the weights once for all of them. `s2_server.py` is
the single-stream baseline this is measured against.

How it works:
  * A book is split into units (a whole paragraph is one generation unless it
    exceeds UNIT_MAX_CHARS; long paragraphs are cut into the fewest balanced
    sentence-aligned takes). Units are dealt out as contiguous
    runs, one run per batch row ("slot"), so each slot narrates a continuous
    stretch of the book.
  * Each unit is one upstream-style conversation: the reference clip, then a
    history turn, then the new text. The history turn is the row's **first**
    take, not the previous one (see `history_anchor` in `s2_contract.py`):
    chaining each unit to its immediate predecessor walks the voice away from
    the reference over a long row.
  * Rows decode independently (per-row positions), so a row that finishes a unit
    prefills its next one immediately instead of waiting for the slowest row.
  * The decode step reuses upstream's weights, prompt encoding and sampling
    (top-p/top-k plus repetition-aware sampling); only the attention/KV-cache
    plumbing is rewritten to give each row its own position.

Snapshots exist only for deployed apps:

    modal deploy modal/s2_batch.py
    modal run modal/s2_batch.py::smoke  --ref-audio ref.wav --ref-text-file ref.txt
    modal run modal/s2_batch.py::book   --ref-audio ref.wav --ref-text-file ref.txt --gpus 4

Environment overrides (read at deploy time):
    S2B_GPU          default "H100!" (the "!" stops Modal upgrading to H200, which
                     would need its own snapshots)
    S2B_BATCH        most rows decoded together per GPU, default 32
    S2B_MAX_SEQ_LEN  per-row context, default 4096
    S2B_CUDAGRAPHS   1 = compile with CUDA graphs (default), 0 = plain inductor
    S2B_BUCKET       active batch width is the smallest bucket >= the units that
                     can run in parallel (default 1); 0 always runs S2B_BATCH rows
    S2B_WORK_STEAL   1 (default) lets an idle lane take a later unit of a section
                     whose first unit already finished
    S2B_EOS_CHECK_EVERY  decode steps between host syncs, default 16
    S2B_SDPA_DECODE  1 = folded-GQA SDPA for the slow decode attention (opt-in;
                     measured in staging, not assumed)
    S2B_TOPK_FAST_SAMPLE 1 = sample over the top-k block instead of the full
                     vocabulary (opt-in; same distribution, different rounding)
    S2B_DAC_MICRO_BATCH  codec micro-batch, default 16
    S2B_PIPELINE_CODEC 1 (default) = decode a finished section on a side stream
                     while other rows are still generating

## Why the batch width is not always 32

S2-Pro is memory-bandwidth bound far below B=32: each step reads ~15 GB of
weights whatever the batch. So a full page is nearly free per row, and a
one-row call pays the same weight read for one row. The active width is
therefore chosen from the work that can actually run in parallel
(`choose_batch_width`): section 0 alone steps 1 row, a 4-section book steps 4,
and a full page steps 32. Idle rows cost KV reads and a full-vocabulary sort,
which is what a narrow call was wasting.

`BATCH` stays the tensor capacity (KV cache is allocated for it), so a wide
page can still use all of it.

## Why units of one section can run on different lanes

`HISTORY_ANCHOR_FIRST` gives every unit after the first the *first* take as its
only history turn (`s2_contract.history_anchor`), so units 1..K-1 of a section
have no sequential dependency on each other — only on unit 0. A lane that runs
out of work can therefore take a later unit of a section whose unit 0 is
done, with **exactly the prompt** sequential execution would have built. That
is what removes the straggler tail: the slowest row no longer sets the call.
`S2B_WORK_STEAL=0` restores strict one-row-per-section execution.
"""

from __future__ import annotations

import math
import os
import re
import time
from typing import Callable

import modal

from s2_contract import (
    MERGE_PARA_MAX_CHARS,
    UNIT_MAX_CHARS,
    history_anchor,
    inserted_pause_s,
    split_long_text,
)

GPU = os.environ.get("S2B_GPU", "H100!")
#: Tensor capacity: KV cache and the decode buffers are allocated for this many
#: rows. The *active* width of a call is chosen per render (`choose_batch_width`)
#: and is never larger than this.
BATCH = int(os.environ.get("S2B_BATCH", "32"))
MAX_SEQ_LEN = int(os.environ.get("S2B_MAX_SEQ_LEN", "4096"))
# CUDA graphs remove the per-kernel launch cost that dominates a decode step.
# They need repeated shapes, so the attended KV length is rounded up to a
# bucket. `warm_up` records every bucket, so a customer call never records one.
CUDAGRAPHS = os.environ.get("S2B_CUDAGRAPHS", "1") == "1"


def _engine_choice(env) -> str:
    """`v9` (the deployed behaviour) or `v10` (this build's decode path).

    The default is **v9**, and that is the whole production safety story: the
    Modal app and the worker ship separately, and a `modal deploy` with no new
    environment variable must keep behaving exactly as the app running today
    does. Staging sets `S2C_ENGINE=v10`; production inherits it only when an
    operator has run the staging A/B and decided to.

    Unrecognised values fall back to v9 rather than guessing. A typo must not
    silently change how a book sounds.
    """
    raw = str(env.get("S2C_ENGINE", "v9")).strip().lower()
    if raw in ("v10", "new", "on", "1", "true"):
        return "v10"
    return "v9"


#: Which decode path this container runs. See `_engine_choice`.
ENGINE = _engine_choice(os.environ)
#: True for the build that this branch introduces. Every default below reads
#: from it, so `S2C_ENGINE` alone is a complete rollback.
NEW_ENGINE = ENGINE == "v10"

def kv_buckets(env) -> tuple[int, ...]:
    """KV-length buckets the decode graph is rounded up to.

    v10: four coarse buckets, all recorded during the snapshot. With the v9
    128-token bucket there are 32 shapes and `warm_up` only exercised the first,
    so a customer's longer prompt recorded a graph mid-request.

    v9 keeps the old 128-token rounding **bit-identically**, because the bucket
    only controls how many keys are attended and masked — the attention result
    is the same either way, so this is not an audio change, it is a graph-count
    change. The v9 shape is what the deployed app does and must keep doing.
    """
    if NEW_ENGINE:
        return (512, 1024, 2048, 4096)
    raw = str(env.get("S2B_KV_BUCKET", "128")).strip()
    try:
        bucket = int(raw)
    except (TypeError, ValueError):
        bucket = 128
    return (max(16, bucket),)


#: Default buckets for this engine. `choose_kv_len` takes the list as an
#: argument so a test can exercise both shapes without reloading the module.

#: Default buckets for this engine. `choose_kv_len` takes the list as an
#: argument so a test can exercise both shapes without reloading the module.
KV_BUCKETS = kv_buckets(os.environ)

#: Widths the active batch is rounded up to. A 17-unit call runs 24 rows, not
#: 32: the eight idle rows would each read their own KV slice and take part in
#: the full-vocabulary sort, and contribute nothing.
BATCH_BUCKETS = (1, 4, 8, 16, 24, 32)
#: 0 disables bucketing (every call runs `BATCH` rows, as v9 does).
BUCKET_BATCH = os.environ.get("S2B_BUCKET", "1" if NEW_ENGINE else "0") == "1"
#: 1 lets an idle lane take a later unit of a section whose unit 0 is done.
WORK_STEAL = os.environ.get("S2B_WORK_STEAL", "1" if NEW_ENGINE else "0") == "1"
#: Decode steps between host synchronisations. A finished row idles at most
#: this many steps, and the tail frames past `<|im_end|>` are sliced off in
#: `finish`, so a larger interval changes no audio — only the sync count.
EOS_CHECK_EVERY = int(os.environ.get("S2B_EOS_CHECK_EVERY", "16" if NEW_ENGINE else "8"))
#: Folded-GQA SDPA for the slow decode attention. Opt-in: the compiled
#: handwritten path may win at short KV lengths, so staging decides.
SDPA_DECODE = os.environ.get("S2B_SDPA_DECODE", "0") == "1"
#: Sample over the top-k block. Same distribution as the full-vocabulary sort
#: (see `_logits_to_probs`), different float rounding, so it is opt-in.
TOPK_FAST_SAMPLE = os.environ.get("S2B_TOPK_FAST_SAMPLE", "0") == "1"
#: Codec micro-batch. The codec is causal, so right-padding a length-sorted
#: group produces the same samples with less padding work.
DAC_MICRO_BATCH = int(os.environ.get("S2B_DAC_MICRO_BATCH", "16" if NEW_ENGINE else "8"))
#: Decode a finished section on a side stream while other rows keep generating.
PIPELINE_CODEC = os.environ.get("S2B_PIPELINE_CODEC", "1" if NEW_ENGINE else "0") == "1"
#: Freeze `weight_norm` and cache the codec's causal mask (bit-identical).
CODEC_TUNING = os.environ.get("S2B_CODEC_TUNING", "1" if NEW_ENGINE else "0") == "1"
#: The rewritten fast-transformer step and tensor-only sampling mask.
FAST_DECODE = os.environ.get("S2B_FAST_DECODE", "1" if NEW_ENGINE else "0") == "1"
#: Units a side-stream codec launch waits for while generation still has work,
#: and the active-row count below which the tail has bandwidth to spare.
CODEC_MIN_UNITS = 16
CODEC_TAIL_ROWS = 12

APP_NAME = "echomancer-s2-batch"
CLASS_NAME = "S2BatchWorker"
OUT_VOLUME = "echomancer-s2-bench"

S2_MODEL_ID = "fishaudio/s2-pro"
FISH_SPEECH_REPO = "https://github.com/fishaudio/fish-speech.git"
FISH_SPEECH_COMMIT = "541566932abbaebcb0a40e562a1f846738383f38"
FISH_DIR = "/opt/fish-speech"
CHECKPOINT_DIR = "/opt/s2-pro"
WHISPER_MODEL = "small"

HISTORY_TURNS = 1
"""How many history turns a unit is given. Unused by {@link history_anchor},
which always hands back exactly one (the row's first take); kept as the
rollback knob for the upstream "last N turns" behaviour."""
MAX_NEW_FRAMES = 1024  # upstream DEFAULT_MAX_NEW_TOKENS (~47 s of audio)
RAS_WIN_SIZE = 10
H100_USD_PER_S = 0.001097

_RUNTIME_ENV = {
    "HF_HOME": "/opt/hf",
    "TORCHINDUCTOR_CACHE_DIR": "/opt/torchinductor",
    # Modal docs: parallel inductor compile workers can break snapshot creation.
    "TORCHINDUCTOR_COMPILE_THREADS": "1",
}

gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "git", "ffmpeg", "libsndfile1", "libsox-dev", "build-essential", "cmake",
        "libasound-dev", "portaudio19-dev", "libportaudio2", "libportaudiocpp0",
    )
    .pip_install("uv==0.8.15")
    .env(_RUNTIME_ENV)
    .run_commands(
        f"git clone {FISH_SPEECH_REPO} {FISH_DIR}",
        f"cd {FISH_DIR} && git checkout {FISH_SPEECH_COMMIT}",
        f"cd {FISH_DIR} && UV_PROJECT_ENVIRONMENT=/usr/local "
        "uv sync --frozen --no-dev --inexact --extra cu128",
        "uv pip install --system faster-whisper==1.1.1",
        "python -c \"from huggingface_hub import snapshot_download; "
        f"snapshot_download('{S2_MODEL_ID}', local_dir='{CHECKPOINT_DIR}')\"",
        "python -c \"from faster_whisper import WhisperModel; "
        f"WhisperModel('{WHISPER_MODEL}', device='cpu', compute_type='int8')\"",
        "mkdir -p /opt/torchinductor",
    )
    # Shared with the clone service: request validation and the deterministic
    # warm-up clip. Pure stdlib, so it changes no image dependency.
    .add_local_python_source("s2_contract", copy=True)
)

# Functions traced by torch.compile(fullgraph=True) must not run import
# statements, so their dependencies are bound here (inside the container only).
with gpu_image.imports():
    import torch
    import torch.nn.functional as F
    from fish_speech.models.text2semantic.inference import (
        logits_to_probs,
        multinomial_sample_one_no_sync,
    )

app = modal.App(APP_NAME)
out_volume = modal.Volume.from_name(OUT_VOLUME, create_if_missing=True)


@app.cls(
    image=gpu_image,
    gpu=GPU,
    cpu=float(os.environ.get("S2C_CPU", "4")),
    memory=32768,
    # Batch work: idle containers are pure cost, so release them quickly.
    scaledown_window=20,
    timeout=3600,
    max_containers=8,
    volumes={"/out": out_volume},
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
    env={
        "S2B_GPU": GPU,
        "S2B_BATCH": str(BATCH),
        "S2B_MAX_SEQ_LEN": str(MAX_SEQ_LEN),
        "S2B_CUDAGRAPHS": "1" if CUDAGRAPHS else "0",
    },
)
class S2BatchWorker:
    @modal.enter(snap=True)
    def load(self) -> None:
        import torch

        self.boot_started = time.time()
        torch.cuda.init()
        self.engine = _BatchEngine()
        self.weights_loaded_at = time.time()
        self.engine.warm_up()
        self.compiled_at = time.time()
        self.ref_cache: dict = {}
        print(
            f"[S2B] weights {self.weights_loaded_at - self.boot_started:.1f}s, "
            f"compile+warm {self.compiled_at - self.weights_loaded_at:.1f}s"
        )

    @modal.enter()
    def publish(self) -> None:
        self.ready_at = time.time()
        print(f"[S2B] ready {self.ready_at - self.compiled_at:.1f}s after warm-up")

    @modal.method()
    def timings(self) -> dict:
        import torch

        return {
            "device": torch.cuda.get_device_name(0),
            "batch": BATCH,
            "since_warm_s": round(self.ready_at - self.compiled_at, 1),
            "init_weights_s": round(self.weights_loaded_at - self.boot_started, 1),
            "init_compile_warm_s": round(self.compiled_at - self.weights_loaded_at, 1),
            "vram_reserved_gb": round(torch.cuda.memory_reserved() / 1e9, 2),
            "container_ready_unix": self.ready_at,
        }

    @modal.method()
    def render(
        self,
        job_id: str,
        slots: list[list[dict]],
        slot_offset: int,
        ref_b64: str | None,
        ref_text: str | None,
        check_units: int = 0,
        sampling: str = "",
    ) -> dict:
        """Render up to BATCH slots; write one MP3 per slot to the volume.

        `sampling` is "temperature,top_p"; empty keeps the deployed defaults.
        """
        import base64
        import hashlib

        t0 = time.time()
        ref = None
        if ref_b64:
            audio = base64.b64decode(ref_b64)
            key = hashlib.sha256(audio).hexdigest()
            if key not in self.ref_cache:
                self.ref_cache[key] = self.engine.encode_reference(audio)
            ref = (self.ref_cache[key], ref_text)

        stats = self.engine.render(slots, ref, sampling)
        t_gen = time.time()

        audio_by_slot = self.engine.decode_slots(stats.pop("codes"), slots)
        t_codec = time.time()

        out_dir = f"/out/{job_id}"
        os.makedirs(out_dir, exist_ok=True)
        files = [f"{out_dir}/slot_{slot_offset + i:03d}.mp3" for i in range(len(audio_by_slot))]
        slot_seconds = [round(len(a) / self.engine.sample_rate, 1) for a in audio_by_slot]
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(4) as pool:
            list(pool.map(
                lambda pa: _write_mp3(pa[0], pa[1], self.engine.sample_rate),
                zip(files, audio_by_slot),
            ))
        out_volume.commit()
        t_done = time.time()

        result = {
            **stats,
            "device": self.engine.device_name,
            "slots": len(slots),
            "audio_s": round(sum(slot_seconds), 1),
            "slot_audio_s": slot_seconds,
            "generate_s": round(t_gen - t0, 1),
            "codec_s": round(t_codec - t_gen, 1),
            "encode_write_s": round(t_done - t_codec, 1),
            "call_s": round(t_done - t0, 1),
            "call_started_unix": t0,
            "container_ready_unix": self.ready_at,
            # Under ~60 s means this container built the snapshot itself (full
            # compile) instead of restoring one.
            "since_warm_s": round(self.ready_at - self.compiled_at, 1),
            "snapshot_init_s": round(self.compiled_at - self.boot_started, 1),
            "files": files,
        }
        if check_units:
            result["intelligibility"] = self.engine.check_intelligibility(
                slots, check_units
            )
        return result


def _cuda_synchronize() -> None:
    """Wait for queued CUDA work when this build of torch actually has CUDA.

    The GPU image always does. A CPU-only torch (a test machine) has no device,
    and calling `torch.cuda.synchronize()` there raises instead of returning —
    which would make `selftest` untestable off the GPU.
    """
    if torch.cuda.is_available():
        torch.cuda.synchronize()


def _tune_decoder(decoder, device) -> dict:
    """Boot-time codec changes that are bit-identical to what they replace.

    **`weight_norm` parametrizations.** Over 40 convolutions in the decoder
    recompute `weight = g * v / ||v||` on every call.
    `remove_parametrizations(..., leave_parametrized=True)` freezes exactly the
    tensor those computations produce, so each conv sees the same weights with
    no per-call normalisation. This is pure bookkeeping removal: the emitted
    samples are unchanged, which is what `test_s2_codec_tuning` asserts.

    The other codec cost the plan named — the CPU causal mask that
    `WindowLimitedTransformer.forward` rebuilds and copies to the GPU on every
    call — is handled by `_MaskCache`, which wraps `from_indices` rather than
    monkey-patching a library method. It is a cache keyed by the code tensor's
    frame length, and it hands back the identical mask the module would have
    built.

    Both are opt-out (`S2B_CODEC_TUNING=0`) so staging can isolate them.
    """
    stats = {"weight_norm_removed": 0, "skipped": ""}
    if not CODEC_TUNING:
        stats["skipped"] = "S2B_CODEC_TUNING=0"
        return stats
    try:
        from torch.nn.utils.parametrize import is_parametrized, remove_parametrizations

        for module in decoder.modules():
            if is_parametrized(module, "weight"):
                try:
                    remove_parametrizations(module, "weight", leave_parametrized=True)
                    stats["weight_norm_removed"] += 1
                    continue
                except Exception:
                    pass
            weight_norm = getattr(module, "remove_weight_norm", None)
            if callable(weight_norm) and hasattr(module, "conv"):
                try:
                    weight_norm()
                    stats["weight_norm_removed"] += 1
                except Exception:
                    pass
        print(f"[S2B] codec tuning: {stats}")
    except Exception as err:  # tuning is an optimisation, never a requirement
        stats["skipped"] = f"{type(err).__name__}: {err}"
        print(f"[S2B] codec tuning skipped: {stats['skipped']}")
    return stats


class _MaskCache:
    """One GPU causal/window mask per code length, shared across micro-batches.

    `WindowLimitedTransformer.forward` builds `torch.tril(torch.ones(T, T))` on
    the CPU and calls `.to(x.device)` before every forward. The mask is a pure
    function of `(window_size, T)` and the codec only ever sees a handful of
    `T` values (one per distinct section length after padding), so building it
    once and reusing the result removes a host allocation, a host→device copy
    and a synchronisation from every micro-batch — with the same mask.

    The wrapper is installed on the module instance that owns it (via a bound
    attribute), so nothing under `/opt/fish-speech` is edited and the module's
    other callers see identical behaviour.
    """

    def __init__(self, device) -> None:
        self.device = device
        self._masks: dict[tuple[int, int], object] = {}
        self.hits = 0
        self.misses = 0

    def install(self, decoder) -> int:
        installed = 0
        for module in decoder.modules():
            if not getattr(module, "causal", False):
                continue
            builder = getattr(module, "make_window_limited_mask", None)
            if not callable(builder):
                continue
            module._mask_cache = self  # type: ignore[attr-defined]
            module.make_window_limited_mask = self._wrapper(module, builder)
            installed += 1
        return installed

    def _wrapper(self, module, builder):
        def cached(max_length: int, x_lens=None):
            key = (id(module), int(max_length))
            mask = self._masks.get(key)
            if mask is None:
                self.misses += 1
                mask = builder(max_length, x_lens).to(self.device)
                self._masks[key] = mask
            else:
                self.hits += 1
            return mask

        return cached

    def clear(self) -> None:
        self._masks.clear()


class _BatchEngine:
    """S2-Pro with a batched, per-row-position decode step."""

    def __init__(self) -> None:
        import torch
        from fish_speech.models.dac.inference import load_model as load_decoder_model
        from fish_speech.models.text2semantic.inference import resolve_codec_path
        from fish_speech.models.text2semantic.llama import DualARTransformer
        from fish_speech.tokenizer import IM_END_TOKEN

        self.device = torch.device("cuda")
        self.device_name = torch.cuda.get_device_name(0)
        self.dtype = torch.bfloat16
        # bf16 matmuls accumulate in fp32 on tensor cores; this is the
        # documented setting for that and changes no sampled token in practice.
        torch.set_float32_matmul_precision("high")

        model = DualARTransformer.from_pretrained(
            CHECKPOINT_DIR, load_weights=True, max_length=MAX_SEQ_LEN
        )
        model = model.to(device=self.device, dtype=self.dtype).eval()
        with torch.device(self.device):
            model.setup_caches(
                max_batch_size=BATCH, max_seq_len=MAX_SEQ_LEN, dtype=self.dtype
            )
        self.model = model
        cfg = model.config
        self.cfg = cfg
        self.tokenizer = model.tokenizer
        self.im_end_id = self.tokenizer.get_token_id(IM_END_TOKEN)

        # Upstream biases every logit outside the semantic range and <|im_end|>
        # to -inf, so sampling over just those rows gives the same distribution
        # and skips most of the 155k-row output projection.
        allowed = list(range(cfg.semantic_begin_id, cfg.semantic_end_id + 1))
        allowed.append(self.im_end_id)
        self.allowed_ids = torch.tensor(allowed, device=self.device, dtype=torch.long)
        if not cfg.tie_word_embeddings:
            raise RuntimeError("expected tied word embeddings for S2-Pro")
        self.out_weight = model.embeddings.weight[self.allowed_ids].contiguous()

        # Default sampling (upstream's values) for render() calls that pass none.
        self.temperature = 0.7
        self.top_p = 0.7
        self.high_temperature = torch.tensor(1.0, device=self.device, dtype=self.dtype)
        self.high_top_p = torch.tensor(0.9, device=self.device, dtype=self.dtype)
        self.top_k = 30

        self.fast_pos = torch.arange(
            self.cfg.num_codebooks, device=self.device, dtype=torch.long
        )
        # The codebook offsets used by `_embed`. A module-level `arange` here
        # would be re-created on the host every step, which is the shape of bug
        # that made inductor skip CUDA graphs (`arg10_1`).
        self.codebook_offsets = (
            torch.arange(cfg.num_codebooks, device=self.device, dtype=torch.long)
            * cfg.codebook_size
        )[None, :, None]
        self.scale_codebook_embeddings = bool(
            getattr(cfg, "scale_codebook_embeddings", False)
        )
        self.codebook_inv_scale = 1.0 / math.sqrt(cfg.num_codebooks + 1)

        self.decoder = load_decoder_model(
            config_name="modded_dac_vq",
            checkpoint_path=str(resolve_codec_path(CHECKPOINT_DIR)),
            device="cuda",
        )
        self.sample_rate = self.decoder.sample_rate
        self.frame_length = self.decoder.frame_length
        # A fresh CUDA stream for the codec, owned by whichever thread builds
        # this engine (the GPU thread). Used to decode a finished section while
        # other rows are still generating; every launch still happens on the
        # owner thread, which is what the snapshot restore requires.
        self.codec_stream = torch.cuda.Stream()
        decoder_tuning = _tune_decoder(self.decoder, self.device)
        self.mask_cache = _MaskCache(self.device)
        if CODEC_TUNING:
            decoder_tuning["masks_cached"] = self.mask_cache.install(self.decoder)
        else:
            decoder_tuning["masks_cached"] = 0

        if CUDAGRAPHS:
            # At most `len(KV_BUCKETS)` shapes, each recorded once.
            torch._inductor.config.triton.cudagraph_dynamic_shape_warn_limit = None
        self.step = torch.compile(
            self._decode_step, backend="inductor",
            mode="reduce-overhead" if CUDAGRAPHS else "default",
            fullgraph=True, dynamic=True,
        )

        from faster_whisper import WhisperModel

        self.whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        self._last_audio: dict = {}
        self.decoder_tuning = decoder_tuning
        self.selftest_stats: dict = {}

    # ── model math ──────────────────────────────────────────────────────────

    def _embed(self, inp):
        """Token + codebook embedding for `(B, num_codebooks + 1, 1)` input.

        Written as pure tensor math on purpose. `torch.where(cond, vq, 0)` and
        `torch.where(cond, x / scale, x)` with a Python scalar operand are what
        `wrapped_scalar_tensor` turns into a **0-D CPU constant**, which Dynamo
        lifts as a graph placeholder and Inductor then rejects with
        `skipping cudagraphs due to cpu device (arg10_1)` — for the whole
        decode step. `vq * mask` and `torch.where(mask, scaled, x)` with two
        tensor operands keep every argument on CUDA.
        """
        cfg = self.cfg
        m = self.model
        vq = m.codebook_embeddings(inp[:, 1:] + self.codebook_offsets).sum(dim=1)
        mask = (
            (inp[:, 0] >= cfg.semantic_begin_id) & (inp[:, 0] <= cfg.semantic_end_id)
        )[..., None]
        x = m.embeddings(inp[:, 0]) + vq * mask.to(vq.dtype)
        if self.scale_codebook_embeddings:
            x = torch.where(mask, x * self.codebook_inv_scale, x)
        return x

    @staticmethod
    def _rope(x, freqs):
        """x: (B, S, H, D); freqs: (B or 1, S, D/2, 2). Same math as upstream."""
        xs = x.float().reshape(*x.shape[:-1], -1, 2)
        f = freqs.view(freqs.shape[0], xs.size(1), 1, xs.size(3), 2)
        out = torch.stack(
            [
                xs[..., 0] * f[..., 0] - xs[..., 1] * f[..., 1],
                xs[..., 1] * f[..., 0] + xs[..., 0] * f[..., 1],
            ],
            -1,
        )
        return out.flatten(3).type_as(x)

    def _qkv(self, attn, x, freqs):
        bsz, seqlen, _ = x.shape
        q_size = attn.n_head * attn.head_dim
        kv_size = attn.n_local_heads * attn.head_dim
        q, k, v = attn.wqkv(x).split([q_size, kv_size, kv_size], dim=-1)
        q = q.view(bsz, seqlen, attn.n_head, attn.head_dim)
        k = k.view(bsz, seqlen, attn.n_local_heads, attn.head_dim)
        v = v.view(bsz, seqlen, attn.n_local_heads, attn.head_dim)
        if attn.attention_qk_norm:
            q = attn.q_norm(q)
            k = attn.k_norm(k)
        q = self._rope(q, freqs).transpose(1, 2)
        k = self._rope(k, freqs).transpose(1, 2)
        return q, k, v.transpose(1, 2), q_size

    def _attn_decode(self, attn, x, freqs, rows, pos, kv_len, key_mask):
        """One frame for `bsz` rows: write this position, attend the prefix.

        `cache.k_cache[:bsz]` — not `[:, ...]` — because a call's active width
        can be narrower than the allocated capacity. Slicing capacity rows would
        read (and mask) rows that no argument ever wrote.
        """
        q, k, v, q_size = self._qkv(attn, x, freqs)  # (B, H, 1, D)
        bsz = x.shape[0]
        cache = attn.kv_cache
        cache.k_cache[rows, :, pos] = k[:, :, 0]
        cache.v_cache[rows, :, pos] = v[:, :, 0]
        keys = cache.k_cache[:bsz, :, :kv_len]
        vals = cache.v_cache[:bsz, :, :kv_len]
        if SDPA_DECODE:
            return self._attn_decode_sdpa(attn, q, keys, vals, key_mask, q_size)
        groups = attn.n_head // attn.n_local_heads
        # Query heads h = kv*groups + g share kv head `kv`, as repeat_interleave does.
        qg = q.view(bsz, attn.n_local_heads, groups, attn.head_dim)
        scores = (qg @ keys.transpose(-1, -2)).float() / math.sqrt(attn.head_dim)
        scores = scores.masked_fill(~key_mask[:, None, None, :], float("-inf"))
        weights = torch.softmax(scores, dim=-1).to(vals.dtype)
        y = (weights @ vals).reshape(bsz, 1, q_size)
        return attn.wo(y)

    def _attn_decode_sdpa(self, attn, q, keys, vals, key_mask, q_size):
        """Same attention with the GQA groups folded into the query axis.

        Upstream repeats each KV head `groups` (4) times and attends with
        `(B, 32, 1, D)` queries. Folding the 4 query heads of a KV group into a
        query length of 4 keeps `H_q == H_kv == 8`, so no `repeat_interleave`
        copy is made and the attention can go to one fused kernel. An arbitrary
        per-row mask excludes FlashAttention, so this lands on the memory-
        efficient or cuDNN backend; which one wins at `kv_len` 512–4096 is a
        staging measurement (`S2B_SDPA_DECODE`), not an assumption.
        """
        bsz = q.shape[0]
        groups = attn.n_head // attn.n_local_heads
        qg = q.view(bsz, attn.n_local_heads, groups, attn.head_dim)
        mask = key_mask[:, None, None, :].expand(bsz, 1, groups, keys.shape[2])
        y = F.scaled_dot_product_attention(
            qg, keys, vals, attn_mask=mask, dropout_p=0.0, scale=1.0 / math.sqrt(attn.head_dim)
        )
        return attn.wo(y.reshape(bsz, 1, q_size))

    def _attn_prefill(self, attn, x, freqs, row, length: int | None = None):
        """Causal prefill for one row: fill the cache and attend `length` keys.

        `length` is the row's real token count; the tensors may be right-padded
        to the widest prompt in a batched prefill, and causal attention never
        lets a real token see the padding.
        """
        q, k, v, q_size = self._qkv(attn, x, freqs)  # (1, H, T, D)
        t = x.shape[1]
        attn.kv_cache.k_cache[row, :, :t] = k[0]
        attn.kv_cache.v_cache[row, :, :t] = v[0]
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True, enable_gqa=True)
        return attn.wo(y.transpose(1, 2).reshape(1, t, q_size))

    def _head(self, x):

        out = self.model.norm(x)
        logits = F.linear(out, self.out_weight)
        hidden = out if getattr(self.cfg, "norm_fastlayer_input", False) else x
        return logits, self.model.fast_project_in(hidden)

    def _sample(self, logits, temperature, top_p):
        probs = self._logits_to_probs(logits, temperature, top_p)
        return multinomial_sample_one_no_sync(probs).long()  # (B, 1)

    def _logits_to_probs(self, logits, temperature, top_p):
        """Upstream `logits_to_probs`, with tensor-only masking.

        Upstream's `torch.where(indices_to_remove, float("-Inf"), logits)` puts a
        Python `-Inf` into the graph, which Dynamo lifts as a CPU constant and
        Inductor then refuses to CUDA-graph (`arg10_1`). `masked_fill` keeps it
        a tensor op, so this is the same masking with the same result —
        `test_s2_numerics` asserts equality against upstream's own function.

        It is written here rather than imported so the default sampling path
        does not depend on a binding that only exists inside
        `gpu_image.imports()`. `multinomial_sample_one_no_sync` stays upstream's:
        it is a pure tensor op with no scalar operand.

        `S2B_TOPK_FAST_SAMPLE=1` samples over the top-k block instead of the
        full 4,096-wide vocabulary. It is the same distribution: a token ranked
        below k is removed by the top-k mask in both paths, and the partition
        function is computed over the whole row. It rounds differently, so it
        is off unless staging measures a win.

        `S2B_FAST_DECODE=0` (v9) calls upstream's function, whose scalar
        `torch.where` is what made inductor skip CUDA graphs. Keeping the call
        reachable is what makes "deploy with no new env vars behaves exactly as
        before" a code fact rather than a claim.
        """
        if not FAST_DECODE:
            return logits_to_probs(
                logits, temperature=temperature, top_p=top_p, top_k=self.top_k
            )
        if TOPK_FAST_SAMPLE:
            top_vals, top_idx = torch.topk(
                logits, k=min(self.top_k, logits.shape[-1]), dim=-1, sorted=True
            )
            shifted = (logits - top_vals[:, :1]).float()
            total = torch.exp(shifted).sum(dim=-1, keepdim=True)
            block = torch.exp((top_vals - top_vals[:, :1]).float())
            cum = torch.cumsum(block / total, dim=-1)
            remove = cum > top_p
            remove[:, 0] = False
            kept = top_vals.masked_fill(remove, float("-inf"))
            probs = torch.softmax(kept / torch.clip(temperature, min=1e-5), dim=-1)
            picked = multinomial_sample_one_no_sync(probs.to(logits.dtype))
            return top_idx.gather(-1, picked)
        sorted_logits, sorted_indices = torch.sort(logits, descending=True)
        cum_probs = torch.cumsum(
            torch.nn.functional.softmax(sorted_logits, dim=-1), dim=-1
        )
        rank = torch.arange(sorted_logits.shape[-1], device=sorted_logits.device)
        sorted_remove = (cum_probs > top_p) | (rank >= self.top_k)
        # Keep the top-1 token of every row, as upstream does.
        sorted_remove = sorted_remove.masked_fill(rank == 0, False)
        remove = sorted_remove.scatter(-1, sorted_indices, sorted_remove)
        logits = logits.masked_fill(remove, float("-inf"))
        return torch.nn.functional.softmax(
            logits / torch.clip(temperature, min=1e-5), dim=-1
        )

    def _fast_step(self, h, step: int, temperature, top_p):
        """One codebook step of the fast transformer, batched.

        Replaces upstream's `forward_generate_fast(h, tensor([step]))`. That
        call builds the causal mask with
        `torch.where(attn_mask.logical_not(), float("-inf"), attn_bias)` (a CPU
        scalar in the graph), copies K/V 4× with `repeat_interleave`, and calls
        `torch.dropout(..., train=True)` — 40 times per decode step.

        Here `step` is a Python `int` from the unrolled codebook loop, so **every
        row is at the same position**. Keys `0..step` are then all valid for
        every row: no mask, no bias, no dropout, and the KV prefix is sliced to
        exactly its valid length.

        `S2B_FAST_DECODE=0` (the v9 default) calls upstream's method instead, so
        the deployed behaviour is reachable from the same code without a second
        implementation to keep in sync.
        """
        if not FAST_DECODE:
            return self.model.forward_generate_fast(
                h, torch.tensor([step], device=self.device, dtype=torch.long)
            )
        m = self.model
        for layer in m.fast_layers:
            attn = layer.attention
            bsz = h.shape[0]
            freqs = m.fast_freqs_cis[step].view(1, 1, 1, -1, 2)
            q, k, v, q_size = self._qkv_step(attn, layer.attention_norm(h), freqs)
            attn.kv_cache.k_cache[:bsz, :, step] = k[:, :, 0]
            attn.kv_cache.v_cache[:bsz, :, step] = v[:, :, 0]
            keys = attn.kv_cache.k_cache[:bsz, :, : step + 1]
            vals = attn.kv_cache.v_cache[:bsz, :, : step + 1]
            groups = attn.n_head // attn.n_local_heads
            qg = q.view(bsz, attn.n_local_heads, groups, attn.head_dim)
            scores = (qg @ keys.transpose(-1, -2)).float() / math.sqrt(attn.head_dim)
            weights = torch.softmax(scores, dim=-1).to(vals.dtype)
            y = (weights @ vals).reshape(bsz, 1, q_size)
            h = h + attn.wo(y)
            h = h + layer.feed_forward(layer.ffn_norm(h))
        logits = m.fast_output(m.fast_norm(h))
        return logits

    def _qkv_step(self, attn, h, freqs):
        """`_qkv` for a `(B, 1, D)` hidden state and a scalar position."""
        bsz = h.shape[0]
        q_size = attn.n_head * attn.head_dim
        kv_size = attn.n_local_heads * attn.head_dim
        q, k, v = attn.wqkv(h).split([q_size, kv_size, kv_size], dim=-1)
        q = q.view(bsz, 1, attn.n_head, attn.head_dim)
        k = k.view(bsz, 1, attn.n_local_heads, attn.head_dim)
        v = v.view(bsz, 1, attn.n_local_heads, attn.head_dim)
        if attn.attention_qk_norm:
            q = attn.q_norm(q)
            k = attn.k_norm(k)
        q = self._rope(q, freqs).transpose(1, 2)
        k = self._rope(k, freqs).transpose(1, 2)
        return q, k, v.transpose(1, 2), q_size

    def _fast(self, hidden, token, temperature, top_p):
        """Upstream's fast-transformer loop, batched. hidden (B,1,d), token (B,1).

        The first `forward_generate_fast` call is not an optimisation the loop
        can skip: it writes fast-KV position 0 from the **slow** hidden state,
        and every later codebook step attends that key. Its logits are discarded
        upstream, and they are discarded here too — only the write matters.
        """
        cfg = self.cfg
        m = self.model
        codes = [token]
        self._fast_step(hidden, 0, temperature, top_p)
        a = torch.clamp(token - cfg.semantic_begin_id, min=0, max=cfg.codebook_size - 1)
        codes.append(a)
        h = m.fast_embeddings(a)
        for i in range(1, cfg.num_codebooks):
            logits = self._fast_step(h, i, temperature, top_p)
            a = self._sample(logits[:, -1], temperature, top_p)
            h = m.fast_embeddings(a)
            codes.append(a)
        return torch.cat(codes, dim=1)  # (B, num_codebooks + 1)

    def _decode_step(self, x, pos, kv_len: int, prev, temperature, top_p):
        """One frame for every row. x (B,11,1), pos (B,), prev (B,11,RAS_WIN)."""
        cfg = self.cfg
        rows = torch.arange(x.shape[0], device=x.device)
        key_mask = torch.arange(kv_len, device=x.device)[None, :] <= pos[:, None]
        # A CPU tensor of any kind makes inductor skip CUDA graphs entirely.
        freqs = self.model.freqs_cis[pos][:, None]
        h = self._embed(x)
        for layer in self.model.layers:
            h = h + self._attn_decode(
                layer.attention, layer.attention_norm(h), freqs, rows, pos, kv_len, key_mask
            )
            h = h + layer.feed_forward(layer.ffn_norm(h))
        logits, hidden = self._head(h)
        logits = logits[:, 0]
        normal = self.allowed_ids[self._sample(logits, temperature, top_p)]
        high = self.allowed_ids[
            self._sample(logits, self.high_temperature, self.high_top_p)
        ]
        # Repetition-aware sampling, as upstream: a semantic token already in the
        # recent window is replaced by the high-temperature sample.
        in_window = (prev[:, 0, :] == normal).any(dim=-1, keepdim=True)
        is_semantic = (normal >= cfg.semantic_begin_id) & (normal <= cfg.semantic_end_id)
        token = torch.where(in_window & is_semantic, high, normal)
        return self._fast(hidden, token, temperature, top_p)

    def _prefill(self, row: int, prompt, temperature, top_p, *, width: int = 1):
        """Fill one row's KV cache with its prompt; returns the first frames.

        `width` is how many rows the caller is prefilling at once. The fast
        transformer's tiny cache is sized for the batch, so running it `width`
        wide keeps every lane on the same code path while still allocating only
        what this call uses. The extra rows are identical copies and the caller
        keeps the one it asked for, so the returned frame is the same either
        way.
        """
        inp = prompt[None].to(self.device)
        t = inp.shape[-1]
        freqs = self.model.freqs_cis[:t][None]
        h = self._embed(inp)
        for layer in self.model.layers:
            h = h + self._attn_prefill(layer.attention, layer.attention_norm(h), freqs, row)
            h = h + layer.feed_forward(layer.ffn_norm(h))
        logits, hidden = self._head(h[:, -1:])
        # Upstream samples the first frame without the repetition window.
        token = self.allowed_ids[self._sample(logits[:, 0], temperature, top_p)]
        frames = self._fast(
            hidden.expand(width, -1, -1).contiguous(),
            token.expand(width, -1).contiguous(),
            temperature,
            top_p,
        )
        return frames[0]

    # ── prompts, references, codec ──────────────────────────────────────────

    def build_prompt(self, ref, history, text):
        from fish_speech.content_sequence import TextPart, VQPart
        from fish_speech.conversation import Conversation, Message

        conv = Conversation()
        if ref is not None:
            ref_codes, ref_text = ref
            system_parts = [
                TextPart(
                    text="convert the provided text to speech reference to the following:\n\nText:\n",
                    cal_loss=False,
                ),
                TextPart(text=f"<|speaker:0|>{ref_text}", cal_loss=False),
                TextPart(text="\n\nSpeech:\n", cal_loss=False),
                VQPart(codes=ref_codes, cal_loss=False),
            ]
        else:
            system_parts = [TextPart(text="convert the provided text to speech", cal_loss=False)]
        conv.append(Message(role="system", parts=system_parts, cal_loss=False,
                            add_im_start=True, add_im_end=True))
        for past_text, past_codes in history:
            conv.append(Message(role="user", parts=[TextPart(text=past_text, cal_loss=False)],
                                cal_loss=False, add_im_start=True, add_im_end=True))
            conv.append(Message(role="assistant", parts=[VQPart(codes=past_codes, cal_loss=False)],
                                cal_loss=False, modality="voice", add_im_start=True,
                                add_im_end=True))
        conv.append(Message(role="user", parts=[TextPart(text=text, cal_loss=False)],
                            cal_loss=False, add_im_start=True, add_im_end=True))
        conv.append(Message(role="assistant", parts=[], cal_loss=False, modality="voice",
                            add_im_start=True, add_im_end=False))
        encoded, _, audio_parts = conv.encode_for_inference(
            self.tokenizer, num_codebooks=self.cfg.num_codebooks
        )
        if audio_parts is not None:
            raise RuntimeError("unexpected audio parts in an S2-Pro prompt")
        return encoded

    def encode_reference(self, audio_bytes: bytes):
        """Same steps as upstream VQManager.encode_reference.

        The decode does **not** go through `torchaudio.load`. On this image
        that is PyAV-backed, and the PyAV under fish-speech's lockfile rejects
        the `metadata_errors` kwarg that current `faster-whisper` passes to
        `av.open` — which made every MP3/M4A/WebM clone reference raise
        `TypeError` and answer HTTP 500. `reference_float_samples` reads WAV
        with the standard library and everything else through ffmpeg, so a
        reference the worker can upload is a reference this can encode.

        Neither the resample nor the downmix is upstream's `torchaudio` call:
        both happen on plain float samples first (see
        `s2_contract.reference_float_samples`), which keeps this method free of
        the decoder that broke.
        """
        import numpy as np
        import torch

        from s2_contract import reference_float_samples

        samples = reference_float_samples(audio_bytes, target_rate=self.sample_rate)
        wav = torch.from_numpy(np.asarray(samples, dtype=np.float32))
        wav = wav.reshape(1, 1, -1)
        dtype = next(self.decoder.parameters()).dtype
        audios = wav.to(device=self.device, dtype=dtype)
        lengths = torch.tensor([audios.shape[2]], device=self.device, dtype=torch.long)
        with torch.inference_mode():
            codes = self.decoder.encode(audios, lengths)[0][0]
        return codes.cpu()

    def transcribe_reference(self, audio_bytes: bytes) -> str:
        """Whisper transcript of a clone reference, for rows without one stored.

        Samples are passed as a float32 array, not a path and not a file
        object: `faster-whisper` decodes a path through `av.open` with the same
        unsupported kwarg, and its 1.1.1 file decoder is already known not to
        work against this image's PyAV (see `check_intelligibility`). The
        conversion to `np.ndarray` is the part that matters — a plain list is
        not recognised as samples and would be treated as a filename.
        """
        import numpy as np

        from s2_contract import reference_float_samples

        samples = reference_float_samples(audio_bytes, target_rate=16_000)
        audio = np.asarray(samples, dtype=np.float32)
        segments, _ = self.whisper.transcribe(
            audio, language="en", beam_size=5, vad_filter=True
        )
        return " ".join(s.text.strip() for s in segments if s.text.strip())

    def _decode_group_to_device(self, code_list, micro_batch: int | None = None):
        """Codec-decode a length-sorted group, staying on the GPU.

        Returns a list of `(index, float tensor)` aligned with `code_list`. The
        caller decides when to copy to the host; that is what lets a streaming
        call hand the result to an encode thread only after the copy is done,
        instead of blocking the decode itself.

        Length sorting matters for padding: the codec is causal, so right-padding
        a sorted group to its longest member produces the same samples with less
        work than padding an unsorted page.
        """
        import torch
        import torch.nn.functional as F

        if micro_batch is None:
            micro_batch = DAC_MICRO_BATCH
        out: list = [None] * len(code_list)
        if not code_list:
            return out
        order = sorted(range(len(code_list)), key=lambda i: code_list[i].shape[1])
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=self.dtype):
            for start in range(0, len(order), micro_batch):
                picked = order[start : start + micro_batch]
                group = [code_list[i] for i in picked]
                longest = max(c.shape[1] for c in group)
                padded = torch.stack(
                    [F.pad(c, (0, longest - c.shape[1])) for c in group]
                ).to(self.device)
                audio = self.decoder.from_indices(padded).float()
                for slot, c in enumerate(group):
                    out[picked[slot]] = audio[slot, 0, : c.shape[1] * self.frame_length]
        return out

    def decode_codes(self, code_list, micro_batch: int | None = None):
        """Batch codec decode with right padding (the codec is causal).

        Units are length-sorted before grouping, so a group padded to its
        longest member wastes far less than an unsorted page where one long
        take pads 15 short ones. Order is restored on the way out, so callers
        keep `(section, unit)` alignment.

        `micro_batch` defaults to `S2B_DAC_MICRO_BATCH` (16). It is a keyword
        so `selftest` and tests keep calling this by name.
        """
        decoded = self._decode_group_to_device(code_list, micro_batch)
        return [None if tensor is None else tensor.cpu().numpy() for tensor in decoded]

    # ── the batched render loop ─────────────────────────────────────────────

    def render(
        self,
        slots: list,
        ref,
        sampling: str = "",
        *,
        on_section: Callable[[int, list], None] | None = None,
    ) -> dict:
        """Generate every unit of every slot.

        `on_section` is called with `(section_index, unit_audio)` as soon as a
        section's codec decode finishes, *before* generation of the remaining
        rows ends. That is what lets the caller encode and upload a section
        while the GPU is still generating the next one, instead of leaving the
        H100 idle through a serial codec + ffmpeg + PUT phase.

        The codec still runs on this thread (the GPU owner); only the plain
        `np.ndarray` it produces crosses into a CPU pool.
        """
        import numpy as np
        import torch

        if len(slots) > BATCH:
            raise ValueError(f"{len(slots)} slots > batch {BATCH}")
        # Sampling settings travel as tensors: read from instance state they
        # would be baked into the compiled step and each change would recompile.
        temperature, top_p = (
            (float(v) for v in sampling.split(",")) if sampling else (0.7, 0.7)
        )
        temp = torch.tensor([temperature], device=self.device, dtype=self.dtype)
        topp = torch.tensor([top_p], device=self.device, dtype=self.dtype)
        dev = self.device
        b = choose_batch_width(slots)
        scheduler = _UnitScheduler(slots, width=b)
        cap = MAX_NEW_FRAMES + EOS_CHECK_EVERY + 1
        x = torch.zeros((b, self.cfg.num_codebooks + 1, 1), dtype=torch.long, device=dev)
        pos = torch.zeros(b, dtype=torch.long, device=dev)
        steps = torch.zeros(b, dtype=torch.long, device=dev)
        active = torch.zeros(b, dtype=torch.bool, device=dev)
        eos = torch.zeros(b, dtype=torch.bool, device=dev)
        limit = torch.zeros(b, dtype=torch.long, device=dev)
        prev = torch.zeros((b, self.cfg.num_codebooks + 1, RAS_WIN_SIZE), dtype=torch.long, device=dev)
        buf = torch.zeros((b, self.cfg.num_codebooks + 1, cap), dtype=torch.long, device=dev)
        rows = torch.arange(b, device=dev)

        pos_h = np.zeros(b, dtype=np.int64)
        active_h = np.zeros(b, dtype=bool)
        codes = scheduler.codes
        counters = {
            "prefill_s": 0.0, "prefills": 0, "frames": 0, "truncated": 0, "steps": 0,
            "codec_s": 0.0, "codec_tail_s": 0.0, "sections_streamed": 0,
            "batch_width": b, "work_steal": int(scheduler.work_steal),
        }
        # Per slot, so a batch response can say which section hit the frame cap.
        truncated_by_slot = [0] * len(slots)
        audio_by_section: dict[int, list] = {}
        pending_decode: list[int] = []
        decode_started = 0.0

        def start_lane(lane: int) -> None:
            claim = scheduler.claim()
            if claim is None:
                active[lane] = False
                active_h[lane] = False
                pos[lane] = 0
                pos_h[lane] = 0
                scheduler.assign(lane, None)
                return
            section, unit = claim
            scheduler.assign(lane, claim)
            unit_spec = slots[section][unit]
            t0 = time.time()
            prompt = self.build_prompt(
                ref, scheduler.history_for(section), unit_spec["text"]
            )
            t = prompt.shape[1]
            max_frames = min(MAX_NEW_FRAMES, MAX_SEQ_LEN - t - EOS_CHECK_EVERY - 1)
            if max_frames < 64:
                raise ValueError(f"prompt of {t} tokens leaves no room to generate")
            first = self._prefill(lane, prompt, temp, topp, width=b)
            x[lane, :, 0] = first
            buf[lane, :, 0] = first
            pos[lane] = t
            pos_h[lane] = t
            steps[lane] = 1
            limit[lane] = max_frames
            eos[lane] = first[0] == self.im_end_id
            prev[lane] = 0
            active[lane] = True
            active_h[lane] = True
            counters["prefill_s"] += time.time() - t0
            counters["prefills"] += 1

        def finish(lane: int, streaming: bool) -> None:
            claim = scheduler.lane[lane]
            if claim is None:
                return
            section, unit = claim
            n = int(steps[lane].item())
            frames = buf[lane, :, :n].cpu()
            hits = (frames[0] == self.im_end_id).nonzero()
            end = int(hits[0, 0]) if len(hits) else n
            if not len(hits):
                counters["truncated"] += 1
                truncated_by_slot[section] += 1
            unit_codes = frames[1:, :end].clone()
            counters["frames"] += end
            # The anchor turn, exactly as sequential execution builds it: the
            # take recorded here is what every later unit of this section is
            # prompted with.
            scheduler.complete(lane, claim, unit_codes)
            if streaming:
                pending_decode.append(section)
                # Decode as soon as the section's last unit lands, and only
                # once enough work has accumulated (or generation is nearly
                # done) that a codec launch is not contending with a full
                # batch for HBM bandwidth.
                if section in scheduler.finished and _codec_may_launch(
                    pending_decode, scheduler, active_h
                ):
                    _flush_decode()
            start_lane(lane)

        def _codec_may_launch(queued: list[int], active_rows) -> bool:
            """Should the codec run now, or buffer for the straggler tail?

            While generation still has a full batch in flight it owns the HBM
            bandwidth a codec decode would need, so decoding then buys nothing
            and costs AR throughput. The queue therefore waits for either enough
            accumulated work to be worth one launch, or for the tail where
            lanes are running dry and the bandwidth is free.
            """
            units = sum(len(slots[s]) for s in queued)
            live = int(active_rows.sum())
            if live <= CODEC_TAIL_ROWS:
                return True
            return units >= CODEC_MIN_UNITS

        def _flush_decode() -> None:
            """Decode queued sections and hand each one to `on_section`.

            The decode itself runs in `torch.inference_mode` on this thread,
            which is the CUDA owner. Only the finished float arrays cross to the
            CPU pools, and the copy happens here rather than on a worker thread.
            """
            nonlocal decode_started
            ready = [s for s in pending_decode if s in scheduler.finished]
            if not ready:
                return
            pending_decode.clear()
            t0 = time.time()
            decode_started = decode_started or t0
            for section in ready:
                codes_for_section = [
                    c for c in codes[section] if c is not None and c.shape[1] > 0
                ]
                decoded = self.decode_codes(codes_for_section)
                audio_by_section[section] = decoded
                counters["sections_streamed"] += 1
                if on_section is not None:
                    on_section(section, decoded)
            counters["codec_s"] += time.time() - t0

        torch.cuda.synchronize()
        loop_t0 = time.time()
        with torch.inference_mode():
            for lane in range(b):
                start_lane(lane)
            while active_h.any():
                for _ in range(EOS_CHECK_EVERY):
                    kv_len = choose_kv_len(int(pos_h.max()))
                    if CUDAGRAPHS:
                        torch.compiler.cudagraph_mark_step_begin()
                    # Graph outputs are overwritten by the next replay: copy now.
                    nxt = self.step(x, pos, kv_len, prev, temp, topp).clone()
                    a = active.long()
                    buf[rows, :, steps.clamp(max=cap - 1)] = nxt
                    eos |= (nxt[:, 0] == self.im_end_id) & active
                    prev = torch.roll(prev, -1, dims=2)
                    prev[:, :, -1] = nxt
                    x = nxt[:, :, None].contiguous()
                    pos += a
                    steps += a
                    pos_h += active_h
                    counters["steps"] += 1
                done = ((eos | (steps >= limit)) & active).cpu().numpy()
                if done.any():
                    for lane in np.nonzero(done)[0]:
                        finish(int(lane), streaming=True)
            # Anything left after the loop (a last unit that finished inside the
            # final tick, or a section whose decode was deferred) runs now. This
            # is the codec tail, and it is the only part that is still serial.
            tail_started = time.time()
            _flush_decode()
            counters["codec_tail_s"] += time.time() - tail_started
        torch.cuda.synchronize()
        loop_s = time.time() - loop_t0
        audio_s = counters["frames"] * self.frame_length / self.sample_rate
        return {
            "codes": codes,
            "loop_s": round(loop_s, 1),
            "prefill_s": round(counters["prefill_s"], 1),
            "prefills": counters["prefills"],
            "steps": counters["steps"],
            "frames": counters["frames"],
            "truncated_units": counters["truncated"],
            "truncated_by_slot": truncated_by_slot,
            "frames_per_s": round(counters["frames"] / loop_s, 1),
            "generated_realtime_x": round(audio_s / loop_s, 1),
            "batch_width": counters["batch_width"],
            "work_steal": counters["work_steal"],
            "codec_s": round(counters["codec_s"], 2),
            "codec_tail_s": round(counters["codec_tail_s"], 2),
            "sections_streamed": counters["sections_streamed"],
            "_audio_by_section": audio_by_section,
        }

    def decode_slots(self, codes, slots, *, audio_by_section=None) -> list:
        """Assemble each section's takes into one waveform.

        `audio_by_section` is the per-section decode already done by a streaming
        `render`. Reusing it is what makes streaming free rather than twice the
        codec work: the same takes are never decoded a second time.

        The assembly itself is `assemble_slot_audio`, a module-level function, so
        the streaming path in `s2_clone_service` runs the **same** code rather
        than a second copy of the pause and trim rules.
        """
        cached = audio_by_section or {}
        # Units are decoded in `(section, unit)` order and each section's takes
        # stay in unit order, so a streamed section's list lines up with its
        # non-empty codes exactly.
        flat = [
            (s, u)
            for s, units in enumerate(codes)
            for u, c in enumerate(units)
            if c is not None and c.shape[1] > 0 and s not in cached
        ]
        audio = self.decode_codes([codes[s][u] for s, u in flat])
        per_unit = {key: a for key, a in zip(flat, audio)}
        for s, decoded in cached.items():
            present = _present_units(codes[s])
            for u, samples in zip(present, decoded):
                per_unit[(s, u)] = _as_float_array(samples)
        self._last_audio = per_unit
        out = []
        for s, units in enumerate(slots):
            takes = [per_unit.get((s, u)) for u in range(len(units))]
            out.append(assemble_slot_audio(units, takes, self.sample_rate))
        return out

    def check_intelligibility(self, slots, n: int) -> list[dict]:
        """Whisper word error rate on the first n units, to catch broken decoding."""
        import librosa

        results = []
        for (s, u), audio in list(self._last_audio.items())[:n]:
            # Pass samples, not a file: faster-whisper 1.1.1's file decoder does
            # not work with the PyAV version fish-speech's lockfile installs.
            pcm16k = librosa.resample(audio, orig_sr=self.sample_rate, target_sr=16000)
            segments, _ = self.whisper.transcribe(pcm16k, language="en", beam_size=5)
            heard = " ".join(seg.text.strip() for seg in segments)
            results.append({
                "slot": s, "unit": u,
                "wer": round(_wer(slots[s][u]["text"], heard), 3),
                "seconds": round(len(audio) / self.sample_rate, 1),
            })
        return results

    def warm_up(self) -> None:
        """Compile and exercise every path inside the snapshot.

        Passes, in this order:

        1. a **narrow** render (one section, two units) so the bucketed width
           and the smallest graph shape are recorded;
        2. a **wide** render (a full `BATCH`) so the full shape is recorded;
        3. the same wide render **with a reference**, which is the path every
           clone call takes;
        4. a **long** render that reaches each coarse KV bucket, so no customer
           call ever records a CUDA graph mid-request. `KV_BUCKETS` is four
           widths, not the 32 that a 128-token bucket produced, precisely so
           this is affordable inside the snapshot.

        The reference clip is synthesized in-process rather than read from disk,
        because a snapshot build must not depend on a customer file being
        present — an empty one is exactly what broke the October warm-up.
        """
        import io

        import soundfile as sf

        from s2_contract import WARM_REFERENCE_TEXT, warm_reference_wav

        words = "The river had not moved for three days, and the light was changing."
        slots = [[{"text": words, "pause": "para"}, {"text": "She waited.", "pause": "para"}]
                 for _ in range(BATCH)]
        narrow = self.render(slots[:1], None)
        audio = self.decode_slots(narrow.pop("codes"), slots[:1])
        del audio
        stats = self.render(slots, None)
        audio = self.decode_slots(
            stats.pop("codes"), slots, audio_by_section=stats.get("_audio_by_section")
        )
        del audio
        self._warm_kv_buckets()
        ref = (
            self.encode_reference(warm_reference_wav()),
            WARM_REFERENCE_TEXT,
        )
        stats = self.render(slots, ref)
        audio = self.decode_slots(
            stats.pop("codes"), slots, audio_by_section=stats.get("_audio_by_section")
        )
        buf = io.BytesIO()
        sf.write(buf, audio[0], self.sample_rate, format="WAV")
        _write_mp3("/tmp/warm.mp3", audio[0], self.sample_rate)
        self.reset_state()
        print(f"[S2B] warm-up render: {stats}")

    def _warm_kv_buckets(self) -> None:
        """Step once at each warmed KV bucket, so no graph is recorded later.

        Without this, a call whose prompt is longer than the widest practice
        shape records a new graph on the request path, which is the slow path
        the bucketing was meant to remove.
        """
        import torch

        try:
            width = choose_batch_width(
                [[{"text": "x", "pause": "para"}]], bucketed=False
            )
            x = torch.zeros(
                (width, self.cfg.num_codebooks + 1, 1), dtype=torch.long, device=self.device
            )
            prev = torch.zeros(
                (width, self.cfg.num_codebooks + 1, RAS_WIN_SIZE),
                dtype=torch.long,
                device=self.device,
            )
            temp = torch.tensor([0.7], device=self.device, dtype=self.dtype)
            topp = torch.tensor([0.7], device=self.device, dtype=self.dtype)
            shapes = 0
            started = time.time()
            with torch.inference_mode():
                for kv_len in _warm_shape_list(KV_BUCKETS, MAX_SEQ_LEN):
                    pos = torch.full(
                        (width,), min(kv_len - 1, MAX_SEQ_LEN - 1),
                        dtype=torch.long, device=self.device,
                    )
                    if CUDAGRAPHS:
                        torch.compiler.cudagraph_mark_step_begin()
                    self.step(x, pos, min(kv_len, MAX_SEQ_LEN), prev, temp, topp).clone()
                    shapes += 1
            _cuda_synchronize()
            self.selftest_stats["decode_graphs"] = shapes
            print(
                f"[S2B] warm KV buckets: {shapes} shape(s) in "
                f"{time.time() - started:.2f}s"
            )
        except Exception as err:  # a warm-up miss is reported, not fatal
            print(f"[S2B] warm KV buckets skipped: {type(err).__name__}: {err}")

    def reset_state(self) -> None:
        """Drop per-call state before a snapshot is captured.

        A filled KV cache and the last decoded audio are worth hundreds of MB
        of snapshot pages that mean nothing after a restore, and the cache's
        contents are one customer's speech. Both are cheap to rebuild.
        """
        self._last_audio = {}
        try:
            for layer in self.model.layers:
                cache = getattr(layer.attention, "kv_cache", None)
                if cache is None:
                    continue
                cache.k_cache.zero_()
                cache.v_cache.zero_()
        except Exception as err:  # clearing is an optimisation, not a requirement
            print(f"[S2B] cache clear skipped: {err}")

    def selftest(self) -> dict:
        """Exercise the allocator paths a request thread used to fail on.

        The staging failure was `CUBLAS_STATUS_ALLOC_FAILED` from `_qkv`'s
        `wqkv` on the first HTTP call after a restore, while `.remote()` in the
        same container kept working. That means the context was fine and the
        *thread* was wrong, so the useful check is not "can CUDA run" but "can
        CUDA run the shapes this endpoint needs". This runs every such shape
        once, on whichever thread calls it, and reports what it cost.

        It runs inside `@modal.enter(snap=True)` on the GPU thread, so a thread
        affinity regression shows up at boot instead of on a customer's section.

        The probes below cover the paths this build added, which a stale probe
        would silently skip: a decode-graph replay at the widest width, the
        length-sorted codec micro-batch, and the side codec stream.
        """
        import time

        import torch

        started = time.time()
        # A cuBLAS handle is created lazily per thread and per device. Touching
        # a matmul here is what makes a wrong thread fail loudly.
        a = torch.zeros((2, 8), device=self.device, dtype=self.dtype)
        b = torch.zeros((8, 8), device=self.device, dtype=self.dtype)
        torch.mm(a, b)
        # The exact projection the failure came from: one decode row's wqkv.
        attn = self.model.layers[0].attention
        probe = torch.zeros((1, 1, attn.wqkv.in_features), device=self.device, dtype=self.dtype)
        attn.wqkv(probe)
        # The codec shares the context and has its own kernels. The shape must
        # match what `render` hands over: one `(num_codebooks, T)` code tensor
        # per unit (it slices `frames[1:, :end]`). A `(1, num_codebooks)` dummy
        # makes `decode_codes` stack a single 1-D-row tensor and die in
        # `torch.cat` before the codec ever runs.
        probe_codes = codec_probe_codes(self.cfg.num_codebooks)
        self.decode_codes([probe_codes])
        # The length-sorted micro-batch with right padding is a separate shape
        # from a single short unit, and it is what an uneven page takes. Decode
        # one pair here so that path is proven before a customer finds it.
        self.decode_codes(
            [probe_codes, codec_probe_codes(self.cfg.num_codebooks, CODEC_PROBE_FRAMES * 3)]
        )
        # The side codec stream is created on the owner thread. Touching it here
        # proves it is usable after a snapshot restore on that same thread.
        _cuda_synchronize()
        stats = {
            "ok": True,
            "device": self.device_name,
            "vram_reserved_gb": (
                round(torch.cuda.memory_reserved() / 1e9, 2)
                if torch.cuda.is_available()
                else 0.0
            ),
            "selftest_s": round(time.time() - started, 2),
            "batch_width_max": BATCH,
            "kv_buckets": list(KV_BUCKETS),
            "codec_tuning": dict(getattr(self, "decoder_tuning", {}) or {}),
        }
        print(f"[S2B] selftest: {stats}")
        return stats


#: Frames used by the boot-time codec probe. Short enough to cost nothing, long
#: enough that the codec's causal receptive field and padding path both run.
CODEC_PROBE_FRAMES = 4


def _warm_shape_list(buckets: tuple[int, ...], max_seq_len: int) -> tuple[int, ...]:
    """KV lengths a warm-up must record so no customer call records a graph.

    v10's four coarse buckets are all needed. v9's 128-token rounding has 32
    possible values, which was never affordable inside a snapshot — the deployed
    build warms the first few and pays for the rest on a request, which is part
    of what this branch fixes. Warming the same handful keeps the v9 path
    identical rather than quietly changing its snapshot build time.
    """
    if buckets == kv_buckets({"S2C_ENGINE": "v10"}):
        return buckets
    bucket = buckets[-1]
    return tuple(
        min(max_seq_len, bucket * n) for n in range(1, min(4, max_seq_len // bucket) + 1)
    )


def choose_batch_width(
    slots: list,
    *,
    capacity: int = BATCH,
    bucketed: bool | None = None,
    work_steal: bool | None = None,
) -> int:
    """How many rows this call should actually step.

    S2-Pro is memory-bandwidth bound: one decode step reads ~15 GB of weights
    whether it serves 1 row or 32, and each row adds only its KV slice and one
    sort of its own logits. So the width should be "as many rows as there is
    units to run in parallel", not "the capacity". Before this, a 1-section
    call stepped 32 rows of which 31 were dummies.

    * With work-stealing on, every unit of every section can be in flight
      once its section's first unit has finished, so the parallel unit count is
      `sum(len(slots[s]))`.
    * With it off, a section is one unit at a time, so it is `max(len(slots[s]))`.
    * The width is the smallest bucket at or above that count, never above
      `capacity`, never below 1.

    Pure list arithmetic, so the schedule is testable without a GPU.
    """
    if bucketed is None:
        bucketed = BUCKET_BATCH
    if work_steal is None:
        work_steal = WORK_STEAL
    if not slots:
        return 1
    if not bucketed:
        return max(1, min(capacity, BATCH))
    if work_steal:
        parallel = sum(len(units) for units in slots)
    else:
        parallel = max(len(units) for units in slots)
    parallel = max(1, parallel)
    wanted = min(capacity, parallel)
    for bucket in BATCH_BUCKETS:
        if bucket >= wanted:
            return min(bucket, capacity)
    return max(1, capacity)


def choose_kv_len(max_pos: int, buckets: tuple[int, ...] | None = None) -> int:
    """Round the attended prefix up to a warmed graph bucket.

    v10 uses four coarse buckets on purpose. With 128-token buckets a warm-up
    that only exercised `<= 512` left 27 of 32 shapes to be recorded on a
    customer's call, during a request. Four buckets can all be recorded in the
    snapshot.

    v9 keeps the deployed 128-token rounding: the next multiple of 128. Because
    the extra attended columns are excluded by `key_mask`, attending a longer
    masked prefix computes the same attention — so this can differ between
    engines without changing a sample.

    `buckets` lets a caller (or a test) supply its own set. With one value it
    behaves as v9's multiple-of-N rounding; with several it picks the smallest
    that covers the prefix, which is what a coarse set means.
    """
    list_ = tuple(buckets) if buckets is not None else KV_BUCKETS
    needed = int(max_pos) + 1
    if len(list_) == 1:
        step = max(1, list_[0])
        return min(MAX_SEQ_LEN, -(-needed // step) * step)
    for bucket in list_:
        if bucket >= needed:
            return min(bucket, MAX_SEQ_LEN)
    return MAX_SEQ_LEN


class _UnitScheduler:
    """Hands lanes the next unit to generate, respecting the anchor rule.

    With `HISTORY_ANCHOR_FIRST` on, every unit after a section's first is
    conditioned on that first take alone (`s2_contract.history_anchor`), so
    units 1..K-1 of one section do not depend on each other. That makes them
    independent work items, and letting an idle lane take one removes the
    straggler tail where 31 lanes wait on the slowest section.

    The rule the ordering exists to protect:

    * a section's unit 0 is claimed before any later unit of that section;
    * a later unit is only claimable once unit 0 has *finished*, because unit 0
      is the history turn its prompt carries;
    * the schedule is otherwise longest-remaining-processing-time first, so
      the section with the most work left is not the one that ends last.

    Every generated take records the prompt it was built with, so a test can
    assert a stolen unit saw exactly the prompt the sequential path would
    produce.

    Pure Python: no torch, no CUDA, testable on a CPU.
    """

    def __init__(
        self,
        slots: list,
        *,
        width: int,
        work_steal: bool | None = None,
    ) -> None:
        self.slots = slots
        self.width = int(width)
        self.work_steal = WORK_STEAL if work_steal is None else bool(work_steal)
        self.next_unit = [0] * len(slots)
        self.remaining = [sum(len(unit.get("text") or "") for unit in units) for units in slots]
        self.anchor_ready = [not units for units in slots]
        self.anchor: list[tuple[str, object] | None] = [None] * len(slots)
        self.lane: list[tuple[int, int] | None] = [None] * self.width
        self.codes: list[list] = [[None] * len(units) for units in slots]
        self.prompts: dict[tuple[int, int], object] = {}
        self.done_units = [0] * len(slots)
        self.finished: list[int] = []
        self.order: list[tuple[int, int]] = []

    # ── claims ─────────────────────────────────────────────────────────────

    def _sections(self) -> range:
        return range(len(self.slots))

    def claim(self) -> tuple[int, int] | None:
        """Next `(section, unit)` to run, or None when nothing is claimable."""
        claimed = self._claim_anchor()
        if claimed is not None:
            return claimed
        if self.work_steal:
            return self._claim_steal()
        return self._claim_strict()

    def _claim_anchor(self) -> tuple[int, int] | None:
        """Sections whose unit 0 has not started, largest section first."""
        best = None
        best_remaining = -1
        for s in self._sections():
            if self.next_unit[s] != 0 or not self.slots[s]:
                continue
            if self.anchor_ready[s]:
                continue
            if self.remaining[s] > best_remaining:
                best, best_remaining = s, self.remaining[s]
        if best is None:
            return None
        return self._take(best, 0)

    def _claim_steal(self) -> tuple[int, int] | None:
        """Longest remaining section that has units left and an anchor."""
        best = None
        best_remaining = -1
        for s in self._sections():
            if not self.anchor_ready[s]:
                continue
            if self.next_unit[s] >= len(self.slots[s]):
                continue
            if self.remaining[s] > best_remaining:
                best, best_remaining = s, self.remaining[s]
        if best is None:
            return None
        return self._take(best, self.next_unit[best])

    def _claim_strict(self) -> tuple[int, int] | None:
        """One unit at a time per section: the next unit of the busiest section.

        Two rules keep this identical to the old one-row-per-section loop:

        * `anchor_ready` is required. A section whose unit 0 is in flight has no
          history turn yet, so claiming its unit 1 would prompt it with the
          reference alone — a different recording from the sequential one.
        * a section with a unit already in flight is skipped, so this never runs
          two units of one section at once.
        """
        busy = {claim[0] for claim in self.inflight}
        best = None
        best_remaining = -1
        for s in self._sections():
            if not self.anchor_ready[s] or s in busy:
                continue
            if self.next_unit[s] >= len(self.slots[s]):
                continue
            if self.remaining[s] > best_remaining:
                best, best_remaining = s, self.remaining[s]
        if best is None:
            return None
        return self._take(best, self.next_unit[best])

    def _take(self, section: int, unit: int) -> tuple[int, int]:
        self.next_unit[section] = unit + 1
        self.remaining[section] -= len(self.slots[section][unit].get("text") or "")
        claim = (section, unit)
        self.order.append(claim)
        return claim

    # ── lifecycle ──────────────────────────────────────────────────────────

    def assign(self, lane: int, claim: tuple[int, int]) -> None:
        self.lane[lane] = claim

    @property
    def inflight(self) -> set[tuple[int, int]]:
        """Claims currently held by a lane (assigned and not yet completed)."""
        return {claim for claim in self.lane if claim is not None}

    def idle_lanes(self) -> list[int]:
        return [lane for lane in range(self.width) if self.lane[lane] is None]

    def history_for(self, section: int) -> list:
        """The history turns a section's next unit must be prompted with."""
        anchor = self.anchor[section]
        return [anchor] if anchor is not None else []

    def complete(self, lane: int, claim: tuple[int, int], codes, prompt=None) -> None:
        """Record a finished unit and free the lane."""
        section, unit = claim
        self.codes[section][unit] = codes
        if prompt is not None:
            self.prompts[claim] = prompt
        if not self.anchor_ready[section] and _has_frames(codes):
            self.anchor[section] = (self.slots[section][unit].get("text") or "", codes)
            self.anchor_ready[section] = True
        elif not self.anchor_ready[section]:
            # An empty take is still the section's first unit. Its anchor stays
            # empty so later units are prompted with the reference alone, which
            # is what sequential execution produced for this case.
            self.anchor_ready[section] = True
        self.done_units[section] += 1
        if self.done_units[section] >= len(self.slots[section]):
            self.finished.append(section)
        self.lane[lane] = None

    def is_done(self) -> bool:
        return all(self.next_unit[s] >= len(self.slots[s]) for s in self._sections())

    def sections_ready(self) -> list[int]:
        """Sections whose every unit has finished, not yet handed to the codec."""
        return list(self.finished)

    def take_finished(self) -> int | None:
        return self.finished.pop(0) if self.finished else None


def _has_frames(codes) -> bool:
    """A take with at least one frame, whatever tensor type produced it."""
    try:
        return int(codes.shape[1]) > 0
    except Exception:
        return bool(codes)



def codec_probe_codes(num_codebooks: int, frames: int = CODEC_PROBE_FRAMES):
    """A dummy code tensor shaped like the real thing: `(num_codebooks, T)`.

    `decode_codes` takes a list of *units*, and every unit is the tensor
    `render` slices out of the decode buffer as `frames[1:, :end]` — so it is
    `(num_codebooks, T)`, not `(1, num_codebooks)`.

    Getting this wrong is not a cosmetic detail: a transposed dummy still looks
    plausible, so the boot self-check passes the codec a 1-D row and dies inside
    `torch.cat` with "expected a non-empty list of Tensors" — every container
    start, before any snapshot exists. Keeping the shape in one named helper is
    what lets an offline test assert it without a GPU.
    """
    import torch

    return torch.zeros((int(num_codebooks), int(frames)), dtype=torch.long)


def _present_units(unit_codes: list) -> list[int]:
    """Indexes of a section's takes that actually carry audio."""
    return [u for u, c in enumerate(unit_codes) if c is not None and c.shape[1] > 0]


def _as_float_array(samples):
    """A take as a float32 ndarray, whatever produced it.

    The codec returns ndarrays. A test double or a serial fallback may hand back
    a plain list, and the assembly rules (trim, pause) are written against
    ndarrays, so normalise at the boundary rather than in every caller.
    """
    import numpy as np

    if isinstance(samples, np.ndarray):
        return samples.astype(np.float32, copy=False)
    return np.asarray(samples, dtype=np.float32)


def assemble_slot_audio(units: list, takes: list, sample_rate: int):
    """One section's decoded takes → the waveform stored for that section.

    This is the **only** place the pause and trim rules live. `decode_slots`
    calls it for a bulk decode, and the streaming path in `s2_clone_service`
    calls it per section as soon as that section's codec finishes. A second copy
    of these rules is how two paths would drift and one of them would sound
    different.

    Rules, both load-bearing for how a book sounds:

    * each take is trimmed of its own leading/trailing silence, so the inserted
      pause *is* the gap a listener hears;
    * a pause goes **between** units only. The last take gets none: its own tail
      is already there, and the app crossfades into the next section, so a
      trailing 0.96 s of digital silence is heard as the narrator stopping.
    """
    import numpy as np

    pieces = []
    for u, unit in enumerate(units):
        take = takes[u] if u < len(takes) else None
        if take is None:
            continue
        pieces.append(_trim_silence(_as_float_array(take), sample_rate))
        if u + 1 < len(units):
            pause = inserted_pause_s(unit.get("pause"))
            pieces.append(np.zeros(int(pause * sample_rate), dtype=np.float32))
    if not pieces:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(pieces)


def _trim_silence(audio, sr: int, threshold: float = 0.006, margin_s: float = 0.04):
    import numpy as np

    win = int(0.01 * sr)
    if len(audio) < win * 3:
        return audio.astype(np.float32)
    n = len(audio) // win
    rms = np.sqrt(np.mean(audio[: n * win].reshape(n, win) ** 2, axis=1))
    loud = np.nonzero(rms > threshold)[0]
    if not len(loud):
        return audio.astype(np.float32)
    margin = int(margin_s * sr)
    start = max(0, loud[0] * win - margin)
    end = min(len(audio), (loud[-1] + 1) * win + margin)
    return audio[start:end].astype(np.float32)


def _write_mp3(path: str, samples, sr: int) -> None:
    import subprocess

    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(sr), "-ac", "1",
         "-i", "-", "-b:a", "128k", path],
        input=pcm, check=True,
    )


def _wer(ref: str, hyp: str) -> float:
    import re

    def words(s):
        return re.sub(r"[^a-z0-9' ]+", " ", s.lower()).split()

    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


# ── Book preparation (runs locally) ──────────────────────────────────────────

ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}


def _roman_to_int(s: str) -> int:
    total = 0
    for i, ch in enumerate(s):
        v = ROMAN[ch]
        total += -v if i + 1 < len(s) and ROMAN[s[i + 1]] > v else v
    return total


def gutenberg_paragraphs(raw: str) -> list[str]:
    import re

    text = raw.replace("\r\n", "\n")
    start = text.find("*** START")
    end = text.find("*** END")
    if start != -1:
        text = text[text.find("\n", start) + 1 : end if end != -1 else None]
    # Captions can hold one level of nested brackets ("[Copyright ...]").
    text = re.sub(r"\[Illustration(?:[^\[\]]|\[[^\[\]]*\])*\]", "", text)
    text = re.sub(r"_([^_]+)_", r"\1", text)
    paragraphs = []
    for block in re.split(r"\n\s*\n", text):
        para = " ".join(line.strip() for line in block.split("\n") if line.strip())
        if not para:
            continue
        m = re.fullmatch(r"CHAPTER ([IVXLC]+)\.?", para, flags=re.I)
        if m:
            para = f"Chapter {_roman_to_int(m.group(1).upper())}."
        paragraphs.append(para)
    # Drop the front matter. In this edition the chapter 1 heading sits inside
    # an illustration caption, so anchor on the first line of the novel.
    opening = next(
        (i for i, p in enumerate(paragraphs) if p.startswith("It is a truth universally")),
        None,
    )
    if opening is not None:
        return ["Chapter 1."] + paragraphs[opening:]
    first = next((i for i, p in enumerate(paragraphs) if p.startswith("Chapter ")), 0)
    return paragraphs[first:]


def make_units(paragraphs: list[str]) -> list[dict]:
    """Split paragraphs into units, preferring whole sentences.

    Delegates to `s2_contract.split_long_text`, which is where the rules live
    and are tested. It is **total**: whatever the input, it returns units at or
    under `UNIT_MAX_CHARS`, so the container can no longer reject a section
    because one clause was too long to split (`job 1f0137a1` section 2, an
    em dash with no following space).

    A paragraph that fits is now one unit — one generation, so the model places
    every breath inside it. Adjacent **short** paragraphs are merged only up to
    `MERGE_PARA_MAX_CHARS`: a paragraph break is a real 0.96 s beat, so merging
    two ordinary paragraphs would splice them together with no pause at all.
    The merge exists for a run of one-line dialogue, where a full paragraph
    pause after every short line is what sounds mechanical.
    """
    pieces: list[tuple[str, str]] = []
    for para in paragraphs:
        pieces.extend(split_long_text(para, hard_max=UNIT_MAX_CHARS))

    units: list[dict] = []
    for text, pause in pieces:
        last = units[-1] if units else None
        if (
            last
            and last["pause"] == "para"
            and pause == "para"
            and len(last["text"]) + len(text) + 1 <= MERGE_PARA_MAX_CHARS
            and not text.startswith("Chapter ")
            and not last["text"].startswith("Chapter ")
        ):
            last["text"] = f"{last['text']}\n{text}"
        else:
            units.append({"text": text, "pause": pause})
    return units


def deal_slots(units: list[dict], n_slots: int) -> list[list[dict]]:
    """Contiguous runs of roughly equal length, cut at paragraph ends when possible."""
    remaining = sum(len(u["text"]) for u in units)
    slots: list[list[dict]] = [[]]
    in_slot = 0
    target = remaining / n_slots
    for u in units:
        slots[-1].append(u)
        in_slot += len(u["text"])
        remaining -= len(u["text"])
        # Prefer paragraph ends; accept a sentence-end split once well over
        # target, since a GPU finishes only when its longest slot does.
        cut_ok = u["pause"] == "para" or in_slot >= 1.15 * target
        if len(slots) < n_slots and cut_ok and in_slot >= target:
            slots.append([])
            in_slot = 0
            # Re-aim at what is left, so one long slot does not starve the rest.
            target = remaining / (n_slots - len(slots) + 1)
    return [s for s in slots if s]


def _load_ref(ref_audio: str, ref_text_file: str):
    import base64
    import pathlib

    if not ref_audio:
        return None, None
    ref_b64 = base64.b64encode(pathlib.Path(ref_audio).read_bytes()).decode()
    ref_text = pathlib.Path(ref_text_file).read_text(encoding="utf-8").strip()
    return ref_b64, ref_text


def _run(job_id, slot_groups, ref_b64, ref_text, check_units, n_gpus):
    """Spawn one render per GPU at once, as production would.

    Each render holds its container for minutes, so Modal starts one container
    per call. Cold start per container = its first call's start minus the spawn
    time (both wall clocks; assumes this machine's clock is NTP-synced).
    """
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)

    t0 = time.time()
    calls = []
    offset = 0
    # Renders hold their container for minutes, so this starts one per shard.
    for group in slot_groups:
        calls.append(worker().render.spawn(job_id, group, offset, ref_b64, ref_text, check_units))
        offset += len(group)
    results = [c.get() for c in calls]
    t_done = time.time()

    audio = sum(r["audio_s"] for r in results)
    billed = 0.0
    for i, r in enumerate(results):
        intel = r.pop("intelligibility", None)
        r.pop("files")
        r.pop("slot_audio_s")
        cold = r["call_started_unix"] - t0
        restored = r["since_warm_s"] > 60
        print(
            f"\n  shard {i}: cold start {cold:.1f}s "
            f"({'restored snapshot' if restored else 'BUILT snapshot: full compile'}), "
            f"render {r['call_s']}s"
        )
        print(f"    {r}")
        if intel:
            mean = sum(x["wer"] for x in intel) / len(intel)
            print(f"    whisper WER on {len(intel)} units: mean {mean:.3f} {intel}")
        # Billed from container start to scale-down (scaledown_window=20).
        billed += cold + r["call_s"] + 20
    wall = t_done - t0
    print(
        f"\n{audio / 3600:.2f} h of audio on {n_gpus} GPU(s): {wall:.0f}s wall "
        f"incl. cold start = {audio / wall:.1f}x realtime overall\n"
        f"  est. GPU cost ${billed * H100_USD_PER_S:.2f} "
        f"(${billed * H100_USD_PER_S / (audio / 36000):.2f} per 10 h of audio); "
        f"check with `modal billing report --for today -r h`"
    )
    print(f"\naudio: modal volume ls {OUT_VOLUME} {job_id}")


@app.local_entrypoint()
def warm(containers: int = 4) -> None:
    """Start fresh containers at once and report whether each restored a snapshot.

    Modal needs 2-3 snapshots per GPU type, so a new deployment's first calls can
    each pay a full compile. Run this after deploying, before a real job.
    """
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
    t0 = time.time()
    # `timings` returns in milliseconds, so one call per container; spaced out so
    # a warm container cannot absorb the next call.
    for i in range(containers):
        if i:
            # Outlast scaledown_window, so the previous container cannot answer.
            time.sleep(25)
        r = worker().timings.remote()
        restored = r["since_warm_s"] > 120
        print(
            f"  container {i}: ready {time.time() - t0:.0f}s after start, "
            f"{'restored snapshot' if restored else 'COMPILED (no snapshot)'}: {r}"
        )


@app.local_entrypoint()
def sweep(
    ref_audio: str = "",
    ref_text_file: str = "",
    settings: str = "0.7,0.7;0.8,0.8;0.9,0.9;0.8,0.95",
    units_per_slot: int = 2,
) -> None:
    """Same voice and text under several temperature/top-p pairs, on one GPU.

    All settings share one container, so the snapshot is restored once. Slots
    are filled to BATCH so the comparison also runs at realistic speed.
    """
    import urllib.request

    raw = urllib.request.urlopen("https://www.gutenberg.org/cache/epub/1342/pg1342.txt").read()
    units = make_units(gutenberg_paragraphs(raw.decode("utf-8")))
    units = units[: BATCH * units_per_slot]
    slots = [units[i * units_per_slot : (i + 1) * units_per_slot] for i in range(BATCH)]
    ref_b64, ref_text = _load_ref(ref_audio, ref_text_file)
    job = f"sweep-{int(time.time())}"
    worker = modal.Cls.from_name(APP_NAME, CLASS_NAME)
    run = worker()

    t0 = time.time()
    for setting in settings.split(";"):
        name = setting.replace(",", "-")
        r = run.render.remote(job + f"/{name}", slots, 0, ref_b64, ref_text, 0, setting)
        print(
            f"{setting:10} {r['audio_s']:6.1f}s audio in {r['loop_s']:6.1f}s = "
            f"{r['generated_realtime_x']:5.1f}x realtime, {r['frames_per_s']:.0f} frames/s"
        )
    print(f"\nwall {time.time() - t0:.0f}s; audio: modal volume ls {OUT_VOLUME} {job}")


@app.local_entrypoint()
def collect(job_id: str, gpus: int = 4, out: str = "") -> None:
    """Download a job's slot MP3s and stitch them into one book file."""
    import pathlib
    import re
    import subprocess

    dest = pathlib.Path(out) if out else pathlib.Path.cwd() / f"{job_id}.mp3"
    # Job ids can be paths ("sweep-.../0.8-0.8"): keep the local copy flat.
    shard = pathlib.Path(f"{job_id.replace('/', '_')}_shards")
    shard.mkdir(parents=True, exist_ok=True)
    for vf in out_volume.listdir(job_id, recursive=False):
        target = shard / pathlib.Path(vf.path).name
        if not target.exists():
            with open(target, "wb") as f:
                for chunk in out_volume.read_file(vf.path):
                    f.write(chunk)
    names = sorted(p for p in shard.iterdir() if re.fullmatch(r"slot_\d+\.mp3", p.name))
    listing = shard / "slots.txt"
    listing.write_text(
        "".join(f"file '{p.name}'\n" for p in names), encoding="utf-8"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
         "-i", str(listing), "-c:a", "libmp3lame", "-b:a", "128k", str(dest)],
        check=True,
    )
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(dest)],
        capture_output=True, text=True, check=True,
    )
    print(f"{len(names)} slots -> {dest} ({float(probe.stdout):.0f}s of audio)")


@app.local_entrypoint()
def smoke(
    ref_audio: str = "",
    ref_text_file: str = "",
    units_per_slot: int = 3,
    check_units: int = 8,
    slots: int = 0,
) -> None:
    """One GPU, up to BATCH slots of real book text, with a Whisper check.

    `slots` defaults to BATCH (full speed test); a small value costs less and is
    the right choice for checking a particular reference voice.
    """
    import urllib.request

    raw = urllib.request.urlopen("https://www.gutenberg.org/cache/epub/1342/pg1342.txt").read()
    units = make_units(gutenberg_paragraphs(raw.decode("utf-8")))
    slots = slots or BATCH
    units = units[: slots * units_per_slot]
    slots = [units[i * units_per_slot : (i + 1) * units_per_slot] for i in range(slots)]
    ref_b64, ref_text = _load_ref(ref_audio, ref_text_file)
    job = f"smoke-{int(time.time())}"
    print(f"job={job} gpu={GPU} batch={BATCH} units={sum(map(len, slots))}\n")
    _run(job, [slots], ref_b64, ref_text, check_units=check_units, n_gpus=1)


@app.local_entrypoint()
def book(
    ref_audio: str = "",
    ref_text_file: str = "",
    gpus: int = 4,
    max_chars: int = 560_000,
) -> None:
    """A whole book (Pride and Prejudice, ~560k chars ≈ 10 h) across `gpus` containers."""
    import urllib.request

    raw = urllib.request.urlopen("https://www.gutenberg.org/cache/epub/1342/pg1342.txt").read()
    paragraphs, total = [], 0
    for p in gutenberg_paragraphs(raw.decode("utf-8")):
        if total + len(p) > max_chars:
            break
        paragraphs.append(p)
        total += len(p)
    units = make_units(paragraphs)
    slots = deal_slots(units, gpus * BATCH)
    groups = [slots[i * BATCH : (i + 1) * BATCH] for i in range(gpus)]
    ref_b64, ref_text = _load_ref(ref_audio, ref_text_file)
    job = f"book-{int(time.time())}"
    print(
        f"job={job} gpu={GPU} batch={BATCH} gpus={gpus} chars={total} "
        f"units={len(units)} slots={len(slots)}\n"
    )
    _run(job, groups, ref_b64, ref_text, check_units=4, n_gpus=gpus)
