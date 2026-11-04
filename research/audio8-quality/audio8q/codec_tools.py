"""Codec-side diagnostics: where do the HF ticks actually come from?

The trial's working theory was "the codec decoder leaves ticks". These helpers
test that instead of assuming it, because the two possibilities need different
fixes:

  A. decoder defect  - the decoder emits a burst for *any* frame, so even the
     codec's own digital-silence codes would tick.
  B. latent defect   - the decoder is fine and the *latent* the AR chose for the
     pause is a breath/noise frame, whose HF frication lands once per 46.4 ms
     frame and reads as a tick train.

`silence_table` encodes true digital silence, which gives the set of latents the
encoder itself uses for "nothing". `causality_report` decodes those latents and
a run of the model's own pause latents and compares their HF crest. If A holds,
both are loud; if B holds, only the model's latents are.

`replace_pause_frames` is the decode-side counterpart: it swaps pause latents
for encoder-silence latents. It is only a measurement tool here, because the
goal is a model-level fix; it exists so a take can be scored with the artifact
removed to see what is left.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch

from .frames import HOP, SAMPLE_RATE, frame_db, speech_level_db, quiet_mask
from .probes import hf_crest_db, quiet_hf_crest_db

# Codebook-0 entries the encoder picks for digital silence in this checkpoint.
# They are only used to *label* frames; nothing downstream depends on the exact
# values, because `silence_table` re-derives them from the codec each run.
_SILENCE_FRAME_SAMPLES = SAMPLE_RATE * 2


@dataclass
class CodecContext:
    codec: torch.nn.Module
    sample_rate: int = SAMPLE_RATE

    @property
    def device(self):
        return next(self.codec.parameters()).device

    def encode(self, wav: np.ndarray) -> np.ndarray:
        wav = np.asarray(wav, dtype=np.float32)
        t = torch.from_numpy(wav)[None, None].to(self.device)
        codes, lengths = self.codec.encode(t)
        return codes[0, :, : int(lengths[0])].cpu().numpy()

    def decode(self, codes: np.ndarray) -> np.ndarray:
        t = torch.from_numpy(np.asarray(codes, dtype=np.int64)).to(self.device)
        return self.codec.decode(t[None])[0, 0].detach().float().cpu().numpy()


def codec_context(model) -> CodecContext:
    """Load the codec that ships inside the checkpoint, on the model's device."""
    codec = model.load_codec(device=model.device)
    return CodecContext(codec=codec)


def silence_table(ctx: CodecContext, seconds: int = 2) -> np.ndarray:
    """Distinct latents the encoder produces for digital silence.

    Shape [10, K]. Digital silence is not a single frame - the encoder dithers
    over a few dozen - so the table keeps all of them and callers cycle through.
    """
    codes = ctx.encode(np.zeros(_SILENCE_FRAME_SAMPLES * seconds // 2, dtype=np.float32))
    seen: dict[tuple[int, ...], None] = {}
    for i in range(codes.shape[1]):
        seen.setdefault(tuple(int(v) for v in codes[:, i]), None)
    return np.array(sorted(seen), dtype=np.int64).T


def _frame_hf_crest(x: np.ndarray) -> np.ndarray:
    from .probes import band_limit

    h = band_limit(x)
    n = len(h) // HOP
    return np.array(
        [20.0 * np.log10(np.abs(h[i * HOP:(i + 1) * HOP]).max() + 1e-12) for i in range(n)]
    )


def causality_report(
    ctx: CodecContext,
    pause_frames: np.ndarray,
    repeats: int = 12,
) -> dict:
    """Decode encoder-silence latents and the model's own pause latents.

    `pause_frames` is [10, T] of the model's latents for a pause. Each frame is
    repeated `repeats` times so the decoder is given a stationary input at that
    latent: any HF burst then belongs to that latent, not to a transition.
    """
    table = silence_table(ctx)
    silence_codes = np.tile(table[:, : min(6, table.shape[1])], (1, 4))
    model_codes = np.repeat(np.asarray(pause_frames, dtype=np.int64), repeats, axis=1)

    silent_audio = ctx.decode(silence_codes)
    pause_audio = ctx.decode(model_codes)

    per_frame = _frame_hf_crest(pause_audio)
    table_frames = _frame_hf_crest(silent_audio)
    model_per_latent = []
    for i in range(pause_frames.shape[1]):
        one = ctx.decode(np.repeat(pause_frames[:, i:i + 1], repeats, axis=1))
        crest = _frame_hf_crest(one)
        model_per_latent.append(round(float(np.percentile(crest[2:], 95)), 1))

    return dict(
        silence_table_size=int(table.shape[1]),
        encoder_silence=dict(
            hf_crest_db=round(hf_crest_db(silent_audio), 1),
            frame_crest_p95=round(float(np.percentile(table_frames, 95)), 1),
            rms_db=round(float(np.mean(frame_db(silent_audio))), 1),
        ),
        model_pause=dict(
            hf_crest_db=round(hf_crest_db(pause_audio), 1),
            quiet_hf_crest_db=round(quiet_hf_crest_db(pause_audio), 1),
            frame_crest_p95=round(float(np.percentile(per_frame, 95)), 1),
            rms_db=round(float(np.mean(frame_db(pause_audio))), 1),
        ),
        per_latent_frame_crest_p95=model_per_latent,
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


def pause_runs(
    codes: np.ndarray,
    audio: np.ndarray,
    below_speech_db: float = 38.0,
    min_frames: int = 3,
) -> list[slice]:
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
    the unedited decode over `ramp_frames` frames at both ends so the
    substitution cannot click. This is a measurement tool: it shows how much of
    the artifact is the pause latent, not a shipping fix.

    The crossfade is applied on the *decoded* pair (edited span over original),
    not by mixing the edited audio with a delayed copy of itself: mixing with
    itself is what leaves the original burst in place.
    """
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

    stats = dict(
        pause_runs=len(runs),
        frames_replaced=edited,
        frames_total=int(codes.shape[1]),
        hf_crest_before_db=round(hf_crest_db(original), 1),
        hf_crest_after_db=round(hf_crest_db(blended), 1),
        quiet_hf_crest_before_db=round(quiet_hf_crest_db(original), 1),
        quiet_hf_crest_after_db=round(quiet_hf_crest_db(blended), 1),
    )
    return blended, stats


def speech_frame_hf_delta(
    ctx: CodecContext,
    codes: np.ndarray,
    audio: np.ndarray,
    *,
    below_speech_db: float = 42.0,
) -> dict:
    """How far a pause-frame substitution leaks into neighbouring speech.

    The codec's post-module is a causal window transformer, so editing a latent
    does change its neighbours. Anything above a couple of dB here means the
    substitution is not seam-safe and must not be shipped as a decode tweak.
    """
    replaced, stats = replace_pause_frames(ctx, codes, audio, below_speech_db=below_speech_db)
    levels_before = frame_db(np.asarray(audio, dtype=np.float32))
    levels_after = frame_db(replaced)
    n = min(len(levels_before), len(levels_after))
    quiet = quiet_mask(np.asarray(audio, dtype=np.float32), below_speech_db)[:n]
    loud = ~quiet
    delta = np.abs(levels_after[:n] - levels_before[:n])
    return dict(
        stats,
        speech_frame_rms_delta_db_p95=round(float(np.percentile(delta[loud], 95)), 2) if loud.any() else 0.0,
        speech_frame_rms_delta_db_max=round(float(delta[loud].max()), 2) if loud.any() else 0.0,
        speech_band_balance_unaffected=bool(np.percentile(delta[loud], 95) < 1.0) if loud.any() else True,
    )
