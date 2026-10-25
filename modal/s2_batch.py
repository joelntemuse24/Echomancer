"""Batched Fish Speech S2-Pro on Modal: many passages per GPU, several GPUs per book.

EVALUATION ONLY. S2-Pro weights are under the Fish Audio Research License,
which forbids commercial use without a separate agreement.

Why batching: upstream decodes one sequence at a time, and each audio frame reads
~16 GB of weights, so a GPU is memory-bandwidth bound and mostly idle. Decoding
BATCH rows per step reads the weights once for all of them. `s2_server.py` is
the single-stream baseline this is measured against.

How it works:
  * A book is split into units (whole paragraphs packed to ~UNIT_TARGET_CHARS;
    long paragraphs split at sentence ends). Units are dealt out as contiguous
    runs, one run per batch row ("slot"), so each slot narrates a continuous
    stretch of the book.
  * Each unit is one upstream-style conversation: the reference clip, then the
    slot's previous HISTORY_TURNS units (text + generated audio codes), then the
    new text. Carrying the previous unit keeps pace and tone continuous.
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
    S2B_BATCH        rows decoded together per GPU, default 32
    S2B_MAX_SEQ_LEN  per-row context, default 4096
    S2B_CUDAGRAPHS   1 = compile with CUDA graphs (default), 0 = plain inductor
"""

from __future__ import annotations

import math
import os
import re
import time

import modal

GPU = os.environ.get("S2B_GPU", "H100!")
BATCH = int(os.environ.get("S2B_BATCH", "32"))
MAX_SEQ_LEN = int(os.environ.get("S2B_MAX_SEQ_LEN", "4096"))
# CUDA graphs remove the per-kernel launch cost that dominates a decode step.
# They need repeated shapes, so the attended KV length is rounded up to KV_BUCKET.
CUDAGRAPHS = os.environ.get("S2B_CUDAGRAPHS", "1") == "1"
KV_BUCKET = 128

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
MAX_NEW_FRAMES = 1024  # upstream DEFAULT_MAX_NEW_TOKENS (~47 s of audio)
EOS_CHECK_EVERY = 8  # host sync interval; a finished row idles at most this many steps
RAS_WIN_SIZE = 10
UNIT_TARGET_CHARS = 400
UNIT_MAX_CHARS = 600
PARAGRAPH_PAUSE_S = 0.6
SPLIT_PAUSE_S = 0.25
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
    cpu=4,
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

        self.decoder = load_decoder_model(
            config_name="modded_dac_vq",
            checkpoint_path=str(resolve_codec_path(CHECKPOINT_DIR)),
            device="cuda",
        )
        self.sample_rate = self.decoder.sample_rate
        self.frame_length = self.decoder.frame_length

        if CUDAGRAPHS:
            # At most MAX_SEQ_LEN / KV_BUCKET shapes, each recorded once.
            torch._inductor.config.triton.cudagraph_dynamic_shape_warn_limit = None
        self.step = torch.compile(
            self._decode_step, backend="inductor",
            mode="reduce-overhead" if CUDAGRAPHS else "default",
            fullgraph=True, dynamic=True,
        )

        from faster_whisper import WhisperModel

        self.whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        self._last_audio: dict = {}

    # ── model math ──────────────────────────────────────────────────────────

    def _embed(self, inp):

        cfg = self.cfg
        m = self.model
        offsets = torch.arange(cfg.num_codebooks, device=inp.device) * cfg.codebook_size
        vq = m.codebook_embeddings(inp[:, 1:] + offsets[None, :, None]).sum(dim=1)
        is_vq = (inp[:, 0] >= cfg.semantic_begin_id) & (inp[:, 0] <= cfg.semantic_end_id)
        x = m.embeddings(inp[:, 0]) + torch.where(is_vq[..., None], vq, 0)
        if cfg.scale_codebook_embeddings:
            x = torch.where(is_vq[..., None], x / math.sqrt(cfg.num_codebooks + 1), x)
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

        q, k, v, q_size = self._qkv(attn, x, freqs)  # (B, H, 1, D)
        cache = attn.kv_cache
        cache.k_cache[rows, :, pos] = k[:, :, 0]
        cache.v_cache[rows, :, pos] = v[:, :, 0]
        keys = cache.k_cache[:, :, :kv_len]
        vals = cache.v_cache[:, :, :kv_len]
        bsz = x.shape[0]
        groups = attn.n_head // attn.n_local_heads
        # Query heads h = kv*groups + g share kv head `kv`, as repeat_interleave does.
        qg = q.view(bsz, attn.n_local_heads, groups, attn.head_dim)
        scores = (qg @ keys.transpose(-1, -2)).float() / math.sqrt(attn.head_dim)
        scores = scores.masked_fill(~key_mask[:, None, None, :], float("-inf"))
        weights = torch.softmax(scores, dim=-1).to(vals.dtype)
        y = (weights @ vals).reshape(bsz, 1, q_size)
        return attn.wo(y)

    def _attn_prefill(self, attn, x, freqs, row):

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

        probs = logits_to_probs(logits, temperature=temperature, top_p=top_p, top_k=self.top_k)
        return multinomial_sample_one_no_sync(probs).long()  # (B, 1)

    def _fast(self, hidden, token, temperature, top_p):
        """Upstream's fast-transformer loop, batched. hidden (B,1,d), token (B,1)."""
        cfg = self.cfg
        m = self.model
        codes = [token]
        # `torch.tensor([i])` here would be constant-folded to a CPU tensor, and
        # one CPU argument makes inductor skip CUDA graphs for the whole step.
        m.forward_generate_fast(hidden, self.fast_pos[0:1])
        a = torch.clamp(token - cfg.semantic_begin_id, min=0, max=cfg.codebook_size - 1)
        codes.append(a)
        h = m.fast_embeddings(a)
        for i in range(1, cfg.num_codebooks):
            logits = m.forward_generate_fast(h, self.fast_pos[i : i + 1])
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

    def _prefill(self, row: int, prompt, temperature, top_p):
        """Fill one row's KV cache with its prompt; returns the first frame (11,)."""
        import torch

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
        # The fast transformer's tiny cache is sized for BATCH rows; run all rows
        # with the same input and keep the first. It holds no state between frames.
        frames = self._fast(
            hidden.expand(BATCH, -1, -1).contiguous(),
            token.expand(BATCH, -1).contiguous(),
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
        """Same steps as upstream VQManager.encode_reference."""
        import io

        import torch
        import torchaudio

        wav, sr = torchaudio.load(io.BytesIO(audio_bytes))
        if wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
        if sr != self.sample_rate:
            wav = torchaudio.functional.resample(wav, sr, self.sample_rate)
        dtype = next(self.decoder.parameters()).dtype
        audios = wav.squeeze()[None, None].to(device=self.device, dtype=dtype)
        lengths = torch.tensor([audios.shape[2]], device=self.device, dtype=torch.long)
        with torch.inference_mode():
            codes = self.decoder.encode(audios, lengths)[0][0]
        return codes.cpu()

    def transcribe_reference(self, audio_bytes: bytes) -> str:
        """Whisper transcript of a clone reference, for rows without one stored."""
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".audio") as f:
            f.write(audio_bytes)
            f.flush()
            segments, _ = self.whisper.transcribe(
                f.name, language="en", beam_size=5, vad_filter=True
            )
            return " ".join(s.text.strip() for s in segments if s.text.strip())

    def decode_codes(self, code_list, micro_batch: int = 8):
        """Batch codec decode with right padding (the codec is causal)."""
        import torch
        import torch.nn.functional as F

        out = []
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=self.dtype):
            for i in range(0, len(code_list), micro_batch):
                group = code_list[i : i + micro_batch]
                longest = max(c.shape[1] for c in group)
                padded = torch.stack(
                    [F.pad(c, (0, longest - c.shape[1])) for c in group]
                ).to(self.device)
                audio = self.decoder.from_indices(padded).float().cpu()
                for j, c in enumerate(group):
                    out.append(audio[j, 0, : c.shape[1] * self.frame_length].numpy())
        return out

    # ── the batched render loop ─────────────────────────────────────────────

    def render(self, slots: list, ref, sampling: str = "") -> dict:
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
        b = BATCH
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
        next_unit = [0] * b
        history: list[list] = [[] for _ in range(b)]
        codes: list[list] = [[None] * len(s) for s in slots]
        counters = {"prefill_s": 0.0, "prefills": 0, "frames": 0, "truncated": 0, "steps": 0}

        def start(r: int) -> None:
            if r >= len(slots) or next_unit[r] >= len(slots[r]):
                active[r] = False
                active_h[r] = False
                pos[r] = 0
                pos_h[r] = 0
                return
            unit = slots[r][next_unit[r]]
            t0 = time.time()
            prompt = self.build_prompt(ref, history[r][-HISTORY_TURNS:], unit["text"])
            t = prompt.shape[1]
            max_frames = min(MAX_NEW_FRAMES, MAX_SEQ_LEN - t - EOS_CHECK_EVERY - 1)
            if max_frames < 64:
                raise ValueError(f"prompt of {t} tokens leaves no room to generate")
            first = self._prefill(r, prompt, temp, topp)
            x[r, :, 0] = first
            buf[r, :, 0] = first
            pos[r] = t
            pos_h[r] = t
            steps[r] = 1
            limit[r] = max_frames
            eos[r] = first[0] == self.im_end_id
            prev[r] = 0
            active[r] = True
            active_h[r] = True
            counters["prefill_s"] += time.time() - t0
            counters["prefills"] += 1

        def finish(r: int) -> None:
            n = int(steps[r].item())
            frames = buf[r, :, :n].cpu()
            hits = (frames[0] == self.im_end_id).nonzero()
            end = int(hits[0, 0]) if len(hits) else n
            if not len(hits):
                counters["truncated"] += 1
            unit_codes = frames[1:, :end].clone()
            counters["frames"] += end
            codes[r][next_unit[r]] = unit_codes
            if end > 0:
                history[r].append((slots[r][next_unit[r]]["text"], unit_codes))
                history[r] = history[r][-HISTORY_TURNS:]
            next_unit[r] += 1
            start(r)

        torch.cuda.synchronize()
        loop_t0 = time.time()
        with torch.inference_mode():
            for r in range(b):
                start(r)
            while active_h.any():
                for _ in range(EOS_CHECK_EVERY):
                    kv_len = min(
                        MAX_SEQ_LEN, -(-(int(pos_h.max()) + 1) // KV_BUCKET) * KV_BUCKET
                    )
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
                for r in np.nonzero(done)[0]:
                    finish(int(r))
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
            "frames_per_s": round(counters["frames"] / loop_s, 1),
            "generated_realtime_x": round(audio_s / loop_s, 1),
        }

    def decode_slots(self, codes, slots) -> list:
        import numpy as np

        flat = [(s, u) for s, units in enumerate(codes) for u, c in enumerate(units)
                if c is not None and c.shape[1] > 0]
        audio = self.decode_codes([codes[s][u] for s, u in flat])
        per_unit = {key: a for key, a in zip(flat, audio)}
        self._last_audio = per_unit
        out = []
        for s, units in enumerate(slots):
            pieces = []
            for u, unit in enumerate(units):
                a = per_unit.get((s, u))
                if a is None:
                    continue
                pieces.append(_trim_silence(a, self.sample_rate))
                pause = PARAGRAPH_PAUSE_S if unit.get("pause") == "para" else SPLIT_PAUSE_S
                pieces.append(np.zeros(int(pause * self.sample_rate), dtype=np.float32))
            out.append(np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32))
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
        """Compile and exercise every path inside the snapshot."""
        import base64
        import io

        import soundfile as sf

        words = "The river had not moved for three days, and the light was changing."
        slots = [[{"text": words, "pause": "para"}, {"text": "She waited.", "pause": "para"}]
                 for _ in range(BATCH)]
        stats = self.render(slots, None)
        audio = self.decode_slots(stats.pop("codes"), slots)
        buf = io.BytesIO()
        sf.write(buf, audio[0], self.sample_rate, format="WAV")
        ref = (self.encode_reference(buf.getvalue()), words + " She waited.")
        stats = self.render(slots, ref)
        audio = self.decode_slots(stats.pop("codes"), slots)
        _write_mp3("/tmp/warm.mp3", audio[0], self.sample_rate)
        print(f"[S2B] warm-up render: {stats}")


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


_SENTENCE_END = re.compile(
    r"(?<=[.!?;])(?<!Mr\.)(?<!Mrs\.)(?<!Ms\.)(?<!Dr\.)(?<!St\.)\s+"
)
_CLAUSE_END = re.compile(r"(?<=[,:—])\s+")


def _pack(parts: list[str], target: int) -> list[str]:
    out, current = [], ""
    for part in parts:
        if current and len(current) + len(part) + 1 > target:
            out.append(current)
            current = part
        else:
            current = f"{current} {part}".strip()
    if current:
        out.append(current)
    return out


def make_units(paragraphs: list[str]) -> list[dict]:
    """Whole paragraphs packed to ~UNIT_TARGET_CHARS; long ones split at sentence
    ends, and sentences longer than UNIT_MAX_CHARS at clause ends."""
    pieces: list[tuple[str, str]] = []  # (text, pause after)
    for para in paragraphs:
        if len(para) <= UNIT_MAX_CHARS:
            pieces.append((para, "para"))
            continue
        sentences = []
        for sentence in _SENTENCE_END.split(para):
            if len(sentence) > UNIT_MAX_CHARS:
                sentences.extend(_pack(_CLAUSE_END.split(sentence), UNIT_TARGET_CHARS))
            else:
                sentences.append(sentence)
        packed = _pack(sentences, UNIT_TARGET_CHARS)
        pieces.extend((p, "split") for p in packed[:-1])
        pieces.append((packed[-1], "para"))

    units: list[dict] = []
    for text, pause in pieces:
        last = units[-1] if units else None
        if (last and last["pause"] == "para" and pause == "para"
                and len(last["text"]) + len(text) + 1 <= UNIT_TARGET_CHARS
                and not text.startswith("Chapter ") and not last["text"].startswith("Chapter ")):
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
