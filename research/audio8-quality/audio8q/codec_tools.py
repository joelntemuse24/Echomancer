"""Codec-side diagnostics: where do the HF ticks actually come from?

The earlier trial attributed the ticks to "the codec decode". These helpers test
that instead of assuming it, because the two possibilities need different fixes:

  A. decoder defect  - the decoder emits a burst for *any* frame, so even the
     codec's own digital-silence codes would tick.
  B. latent defect   - the decoder is fine and the *latent* the AR chose for the
     pause is a breath/noise frame, whose HF frication lands once per 46.4 ms
     frame and reads as a tick train.

`silence_table` encodes true digital silence, which gives the set of latents the
encoder itself uses for "nothing". `causality_report` decodes those latents and
the model's own pause latents and compares their HF crest. If A holds, both tick;
if B holds, only the model's latents do.

`replace_pause_frames` is the decode-side counterpart: it swaps pause latents for
encoder-silence latents and, via `speech_frame_hf_delta`, reports how far the edit
leaks into neighbouring speech. The codec's post module is a causal window
transformer over 128 frames, so an edit is never fully local; that number is what
says whether a decode-side patch is safe or whether the AR has to be fixed.

`repair_pairs` builds the training data for the optional decoder fine-tune: the
same latents, decoded twice - once as the model wrote them, once with the pause
runs replaced - so the decoder can learn the difference without the AR changing.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch

from .frames import HOP, SAMPLE_RATE, frame_db, quiet_mask, speech_level_db
from .probes import hf_crest_db, quiet_hf_crest_db

_SILENCE_SECONDS = 2


@dataclass
class CodecContext:
    codec: torch.nn.Module
    sample_rate: int = SAMPLE_RATE

    @property
    def device(self):
        return next(self.codec.parameters()).device

    def encode(self, wav: np.ndarray) -> np.ndarray:
        wav = np.asarray(wav, dtype=np.float32)
        codes, lengths = self.codec.encode(torch.from_numpy(wav)[None, None].to(self.device))
        return codes[0, :, : int(lengths[0])].cpu().numpy()

    def decode(self, codes: np.ndarray) -> np.ndarray:
        t = torch.from_numpy(np.asarray(codes, dtype=np.int64)).to(self.device)
        return self.codec.decode(t[None])[0, 0].detach().float().cpu().numpy()

    def decode_trainable(self, codes: torch.Tensor) -> torch.Tensor:
        """Differentiable decode, bypassing `ArkttsCodec.decode`.

        `ArkttsCodec.decode` carries `@torch.inference_mode()`, which detaches
        everything: a fine-tune through it raises "element 0 of tensors does not
        require grad". Its two submodules do not have that decorator, so calling
        them directly gives the same arithmetic with a live graph. This is the
        only way to fine-tune the decoder at all, and it is why the training path
        lives here rather than in `jobs.py`.
        """
        return self.codec.decoder(self.codec.quantizer.decode(codes.long()))


def codec_context(model) -> CodecContext:
    """Load the codec that ships inside the checkpoint, on the model's device."""
    return CodecContext(codec=model.load_codec(device=model.device))


def silence_table(ctx: CodecContext, seconds: int = _SILENCE_SECONDS) -> np.ndarray:
    """Distinct latents the encoder produces for digital silence, shape [10, K].

    Digital silence is not one frame - the encoder dithers over a few dozen - so
    the table keeps all of them and callers cycle through.
    """
    codes = ctx.encode(np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32))
    seen: dict[tuple[int, ...], None] = {}
    for i in range(codes.shape[1]):
        seen.setdefault(tuple(int(v) for v in codes[:, i]), None)
    return np.array(sorted(seen), dtype=np.int64).T


def _frame_hf_crest(x: np.ndarray) -> np.ndarray:
    from .probes import band_limit

    h = band_limit(x)
    n = len(h) // HOP
    return np.array([20.0 * np.log10(np.abs(h[i * HOP:(i + 1) * HOP]).max() + 1e-12) for i in range(n)])


def causality_report(ctx: CodecContext, pause_frames: np.ndarray, repeats: int = 12) -> dict:
    """Decode encoder-silence latents and the model's own pause latents.

    `pause_frames` is [10, T] of the model's latents for a pause. Each frame is
    repeated `repeats` times so the decoder sees a stationary input: any HF burst
    then belongs to that latent rather than to a transition between latents.
    """
    table = silence_table(ctx)
    silence_codes = np.tile(table[:, : min(6, table.shape[1])], (1, 4))
    model_codes = np.repeat(np.asarray(pause_frames, dtype=np.int64), repeats, axis=1)

    silent_audio = ctx.decode(silence_codes)
    pause_audio = ctx.decode(model_codes)

    per_frame = _frame_hf_crest(pause_audio)
    table_frames = _frame_hf_crest(silent_audio)
    per_latent = []
    for i in range(pause_frames.shape[1]):
        one = ctx.decode(np.repeat(pause_frames[:, i:i + 1], repeats, axis=1))
        per_latent.append(round(float(np.percentile(_frame_hf_crest(one)[2:], 95)), 1))

    return dict(
        silence_table_size=int(table.shape[1]),
        encoder_silence=dict(
            hf_crest_db=round(hf_crest_db(silent_audio), 1),
            frame_crest_p95=round(float(np.percentile(table_frames, 95)), 1),
            rms_db=round(float(np.mean(frame_db(silent_audio))), 1),
        ),
        model_pause=dict(
            hf_crest_db=round(hf_crest_db(pause_audio), 1),
            frame_crest_p95=round(float(np.percentile(per_frame, 95)), 1),
            rms_db=round(float(np.mean(frame_db(pause_audio))), 1),
        ),
        per_latent_frame_crest_p95=per_latent,
        verdict=_verdict(table_frames, per_frame),
    )


def _verdict(silence_crest: np.ndarray, model_crest: np.ndarray) -> str:
    s95 = float(np.percentile(silence_crest, 95))
    m95 = float(np.percentile(model_crest, 95))
    if s95 > -55.0 and m95 > -55.0:
        return "decoder-defect: both the encoder's own silence latents and the model's pause latents tick"
    if m95 > -58.0:
        return "latent-defect: the decoder is clean on silence latents; the model's pause latents carry the HF content"
    return "clean: neither the silence latents nor the model's pause latents carry HF bursts"


def pause_runs(codes: np.ndarray, audio: np.ndarray, below_speech_db: float = 38.0, min_frames: int = 3) -> list[slice]:
    """Slices of consecutive quiet frames, at least `min_frames` long."""
    quiet = quiet_mask(audio, below_speech_db)
    runs: list[slice] = []
    i = 0
    while i < len(quiet):
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < len(quiet) and quiet[j]:
            j += 1
        if j - i >= min_frames:
            runs.append(slice(i, min(j, codes.shape[1])))
        i = j
    return runs


def _substitute(
    ctx: CodecContext,
    codes: np.ndarray,
    audio: np.ndarray,
    *,
    below_speech_db: float,
    min_frames: int,
    ramp_frames: int,
    keep_first: int,
    keep_last: int,
) -> tuple[np.ndarray, list[tuple[int, int]], int, list[slice]]:
    """Core of the substitution: returns (blended audio, spans, frames edited, runs)."""
    table = silence_table(ctx)
    out = np.asarray(codes, dtype=np.int64).copy()
    runs = pause_runs(codes, audio, below_speech_db, min_frames)
    spans: list[tuple[int, int]] = []
    edited = 0
    for run in runs:
        start = run.start + keep_first
        stop = run.stop - keep_last
        if stop - start <= 0:
            continue
        for k, i in enumerate(range(start, stop)):
            out[:, i] = table[:, k % table.shape[1]]
            edited += 1
        spans.append((start * HOP, stop * HOP))

    decoded = ctx.decode(out)
    original = np.asarray(audio, dtype=np.float32)
    n = min(len(decoded), len(original))
    decoded, original = decoded[:n].astype(np.float32), original[:n]
    blended = original.copy()
    ramp = max(1, ramp_frames * HOP)
    for lo, hi in spans:
        lo, hi = max(0, lo), min(n, hi)
        if hi <= lo:
            continue
        blended[lo:hi] = decoded[lo:hi]
        head = min(ramp, hi - lo)
        ramp_up = np.linspace(0.0, 1.0, head, dtype=np.float32)
        blended[lo:lo + head] = decoded[lo:lo + head] * ramp_up + original[lo:lo + head] * (1.0 - ramp_up)
        tail = min(ramp, hi - lo)
        ramp_down = np.linspace(1.0, 0.0, tail, dtype=np.float32)
        blended[hi - tail:hi] = decoded[hi - tail:hi] * ramp_down + original[hi - tail:hi] * (1.0 - ramp_down)
    return blended, spans, edited, runs


def replace_pause_frames(
    ctx: CodecContext,
    codes: np.ndarray,
    audio: np.ndarray,
    *,
    below_speech_db: float = 42.0,
    min_frames: int = 2,
    ramp_frames: int = 2,
    keep_first: int = 1,
    keep_last: int = 1,
) -> tuple[np.ndarray, dict]:
    """Swap quiet-run latents for encoder-silence latents, then decode.

    The first and last `keep_*` frames of each run are left alone so a stop
    consonant or a word tail is not cut, and each edited span is crossfaded into
    the unedited decode over `ramp_frames` frames at both ends, so the
    substitution cannot click. The crossfade is applied to the decoded pair, not
    by mixing the edited audio with a delayed copy of itself: mixing with itself
    is what leaves the original burst in place.

    This is a measurement control, not a shipping fix.
    """
    blended, spans, edited, runs = _substitute(
        ctx, codes, audio,
        below_speech_db=below_speech_db, min_frames=min_frames, ramp_frames=ramp_frames,
        keep_first=keep_first, keep_last=keep_last,
    )
    original = np.asarray(audio, dtype=np.float32)[: len(blended)]
    # Measure inside the edited spans only. A whole-file HF crest is dominated by
    # sibilants in loud speech, so it cannot move by design and would make a
    # working substitution look like a no-op.
    edited_hf_before = _span_hf_crest(original, spans)
    edited_hf_after = _span_hf_crest(blended, spans)
    stats = dict(
        pause_runs=len(runs),
        frames_replaced=edited,
        frames_total=int(codes.shape[1]),
        edited_seconds=round(sum(b - a for a, b in spans) / SAMPLE_RATE, 2),
        edited_hf_crest_before_db=round(edited_hf_before, 1),
        edited_hf_crest_after_db=round(edited_hf_after, 1),
        hf_crest_before_db=round(hf_crest_db(original), 1),
        hf_crest_after_db=round(hf_crest_db(blended), 1),
        quiet_hf_crest_before_db=round(quiet_hf_crest_db(original), 1),
        quiet_hf_crest_after_db=round(quiet_hf_crest_db(blended), 1),
    )
    return blended, stats


def _span_hf_crest(x: np.ndarray, spans: list[tuple[int, int]]) -> float:
    """Loudest 5-14 kHz sample across the given sample spans."""
    from .probes import band_limit

    if not spans or len(x) == 0:
        return -200.0
    h = band_limit(np.asarray(x, dtype=np.float64))
    best = -200.0
    for lo, hi in spans:
        lo, hi = max(0, int(lo)), min(len(h), int(hi))
        if hi > lo:
            best = max(best, float(20.0 * np.log10(np.abs(h[lo:hi]).max() + 1e-12)))
    return best


def speech_frame_hf_delta(
    ctx: CodecContext,
    codes: np.ndarray,
    audio: np.ndarray,
    *,
    below_speech_db: float = 42.0,
) -> dict:
    """How far a pause-frame substitution leaks into neighbouring speech.

    The codec's post module is a causal window transformer, so editing a latent
    does change its neighbours. Anything above about a dB here means the
    substitution is not seam-safe and must not be shipped as a decode tweak.
    """
    replaced, stats = replace_pause_frames(ctx, codes, audio, below_speech_db=below_speech_db)
    levels_before = frame_db(np.asarray(audio, dtype=np.float32))
    levels_after = frame_db(replaced)
    n = min(len(levels_before), len(levels_after))
    quiet = quiet_mask(np.asarray(audio, dtype=np.float32), below_speech_db)[:n]
    loud = ~quiet
    delta = np.abs(levels_after[:n] - levels_before[:n])
    p95 = round(float(np.percentile(delta[loud], 95)), 2) if loud.any() else 0.0
    return dict(
        stats,
        speech_frame_rms_delta_db_p95=p95,
        speech_frame_rms_delta_db_max=round(float(delta[loud].max()), 2) if loud.any() else 0.0,
        speech_untouched=p95 < 1.0,
    )


def repair_pairs(
    ctx: CodecContext,
    takes: list[tuple[np.ndarray, np.ndarray]],
    *,
    below_speech_db: float = 42.0,
    max_frames: int = 512,
) -> list[dict]:
    """Training pairs for the optional decoder fine-tune.

    For each generated take, the *same* latents are decoded twice: once as the
    model wrote them, and once with pause runs replaced. The pair says "these
    latents should have decoded as that", which is a well-posed target the
    decoder can learn, unlike a penalty on its own output with no reference.

    Each pair also carries a real-speech anchor (a clip the encoder produced
    itself), so the fine-tune cannot drift the decoder away from speech.
    """
    pairs: list[dict] = []
    for codes, audio in takes:
        codes = np.asarray(codes, dtype=np.int64)[:, :max_frames]
        audio = np.asarray(audio, dtype=np.float32)
        original = ctx.decode(codes)
        n = min(len(original), len(audio))
        original, audio = original[:n], audio[:n]
        blended, spans, edited, _ = _substitute(
            ctx, codes, audio,
            below_speech_db=below_speech_db, min_frames=2, ramp_frames=2, keep_first=1, keep_last=1,
        )
        if not spans:
            continue
        pairs.append(
            dict(
                codes=torch.from_numpy(codes),
                as_written=torch.from_numpy(original),
                as_intended=torch.from_numpy(blended),
                spans=[(int(a), int(b)) for a, b in spans],
                edited_frames=edited,
            )
        )
    return pairs
