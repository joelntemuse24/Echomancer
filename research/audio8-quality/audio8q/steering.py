"""Activation steering for the slow AR: find the "breath" direction and clamp it.

Why this is not a filter
------------------------
The model writes one semantic token per 46.4 ms frame through a single LM head
over the whole 155k vocabulary. A frame is a breath when that head picks a latent
whose decoded content is unvoiced frication instead of silence or a syllable.

Measuring the codec on its own latents shows the decoder is not at fault: the
encoder's digital-silence latents decode at -88 dBFS HF crest, while the model's
pause latents decode at -39 dBFS. So both reported artifacts - the audible
breaths and the periodic "ticks" - are the slow AR spending pause frames on
breathy latents. The "tick" is the breathing latent's HF frication re-excited
once per codec frame, which is exactly why it repeats every 46-51 ms.

Steering changes that decision at its source: the direction in the residual
stream that precedes a breathy frame is estimated from contrast frames, and it is
projected out (or clamped below a threshold) as the hidden state leaves the last
block, before the LM head. Weights are untouched, so a LoRA-free rollback is one
flag.

Design notes
------------
* The direction lives in the *normalised* hidden state, because that is what the
  LM head actually reads (`model.norm(hidden)` then `F.linear(., embeddings)`).
* Contrast pairs are (breathy frame, clean-silence frame) and (breathy frame,
  speech frame); the direction is the normalised difference of class means, which
  is the LDA axis for two classes and needs no training.
* Clamping (subtract only when the projection is above a percentile learned from
  clean pauses) is preferred to blanket projection: blanket projection moves
  every speech frame a little, clamping leaves speech nearly untouched.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import torch


@dataclass
class FrameLabels:
    """Per-frame class for one take, on the codec frame grid."""

    labels: np.ndarray  # array of str: speech | silent | breathy | other
    rms: np.ndarray
    hf_crest: np.ndarray
    voiced: np.ndarray

    def counts(self) -> dict:
        return {k: int((self.labels == k).sum()) for k in ("speech", "silent", "breathy", "other")}


def label_frames(
    audio: np.ndarray,
    *,
    hop: int = 2048,
    speech_below_db: float = 20.0,
    pause_below_db: float = 26.0,
    breath_hf_crest_db: float = -70.0,
    speech_hf_crest_db: float = -40.0,
) -> FrameLabels:
    """Classify each decoded frame as speech / silent / breathy / other.

    The discriminator that matters here is not voicing but *where the frame sits
    in level and how much 5-14 kHz it holds*:

      speech  - within `speech_below_db` of the take's speech level, or carrying
                an HF crest above `speech_hf_crest_db` (a sibilant is speech).
      breathy - at least `pause_below_db` below speech and an HF crest at or
                above `breath_hf_crest_db`. A decoded breath and a decoded tick
                both land here: the tick is the HF part of a breathy latent.
      silent  - at least `pause_below_db` below speech and a crest below
                `breath_hf_crest_db`. -70 dBFS is well under any audible speech,
                so this does not label a soft consonant as silence.

    `breath_hf_crest_db` is absolute on purpose: the encoder's own digital
    silence decodes at about -88 dBFS HF crest in this checkpoint, so -70 sits
    comfortably between "nothing" and "something breathy".
    """
    from .frames import frame_db, speech_level_db, voiced_mask
    from .probes import band_limit

    hf = band_limit(np.asarray(audio, dtype=np.float64))
    n = min(len(audio) // hop, len(hf) // hop)
    rms = frame_db(audio)[:n]
    crest = np.array(
        [20.0 * np.log10(np.abs(hf[i * hop:(i + 1) * hop]).max() + 1e-12) for i in range(n)]
    )
    voiced = voiced_mask(audio)[:n]
    speech = speech_level_db(audio)

    labels = np.array(["other"] * n, dtype=object)
    labels[(rms > speech - speech_below_db) | (crest > speech_hf_crest_db)] = "speech"
    quiet = (rms <= speech - pause_below_db) & (labels != "speech")
    labels[quiet & (crest >= breath_hf_crest_db)] = "breathy"
    labels[quiet & (crest < breath_hf_crest_db)] = "silent"
    return FrameLabels(labels=labels, rms=rms, hf_crest=crest, voiced=voiced)


@dataclass
class BreathDirection:
    vector: np.ndarray  # unit length, dim 896
    threshold: float  # projection value above which a frame is "breathy"
    stats: dict = field(default_factory=dict)

    def save(self, path: str) -> None:
        np.savez(path, vector=self.vector, threshold=np.float64(self.threshold), **{})

    @classmethod
    def load(cls, path: str) -> "BreathDirection":
        z = np.load(path)
        return cls(vector=z["vector"], threshold=float(z["threshold"]), stats={})


def contrast_direction(
    hidden: np.ndarray,
    labels: np.ndarray,
    *,
    positive: str = "breathy",
    negative: tuple[str, ...] = ("silent",),
    min_frames: int = 6,
    threshold_percentile: float = 97.5,
) -> tuple[np.ndarray, dict]:
    """Normalised difference of class means; unit vector pointing at `positive`.

    `hidden` is [T, D] of the LM head's input per frame, `labels` is [T].

    The negative class defaults to `silent` alone -- clean pause frames -- and not
    to "everything that is not a breath". A breath and a syllable are both
    produced from the same state region, so mixing speech into the negative class
    widens it and pushes the threshold up until the clamp does almost nothing.
    Contrasting against clean pauses asks the narrower and more useful question:
    what distinguishes a pause that breathes from one that does not?

    The clamp threshold is a high percentile of the *negative* projections, so a
    normal pause and normal speech both pass through untouched.
    """
    pos_mask = labels == positive
    neg_mask = np.isin(labels, list(negative))
    if pos_mask.sum() < min_frames or neg_mask.sum() < min_frames:
        raise ValueError(
            f"not enough frames for a contrast: {positive}={int(pos_mask.sum())}, "
            f"{negative}={int(neg_mask.sum())} (need {min_frames} each)"
        )
    pos = hidden[pos_mask].mean(axis=0)
    neg = hidden[neg_mask].mean(axis=0)
    d = pos - neg
    norm = float(np.linalg.norm(d))
    if norm < 1e-8:
        raise ValueError("degenerate contrast: positive and negative means coincide")
    d = d / norm
    proj = hidden @ d
    threshold = float(np.percentile(proj[neg_mask], threshold_percentile))
    other = ~(pos_mask | neg_mask)
    return d.astype(np.float32), dict(
        positive=positive,
        negative=list(negative),
        positive_frames=int(pos_mask.sum()),
        negative_frames=int(neg_mask.sum()),
        positive_proj_mean=round(float(proj[pos_mask].mean()), 2),
        negative_proj_mean=round(float(proj[neg_mask].mean()), 2),
        other_proj_mean=round(float(proj[other].mean()), 2) if other.any() else None,
        threshold=round(threshold, 2),
        threshold_percentile=threshold_percentile,
        above_threshold_fraction_negative=round(float((proj[neg_mask] > threshold).mean()), 4),
        above_threshold_fraction_positive=round(float((proj[pos_mask] > threshold).mean()), 4),
        separation_std=round(
            float((proj[pos_mask].mean() - proj[neg_mask].mean()) / (proj[neg_mask].std() + 1e-9)), 2
        ),
    )


class SteeringHook:
    """Project out (or clamp) the breath direction as the hidden state leaves
    the last block, i.e. on the tensor the LM head and the fast AR both read.

    mode="clamp"  subtract `alpha * (proj - threshold) * d` only where the
                  projection exceeds the learned threshold. Default, because it
                  leaves speech frames where they were.
    mode="project" subtract `alpha * proj * d` everywhere.
    """

    def __init__(
        self,
        direction: np.ndarray,
        alpha: float = 1.0,
        mode: str = "clamp",
        threshold: float | None = None,
    ):
        if mode not in ("clamp", "project"):
            raise ValueError(f"unknown mode {mode!r}")
        self.d = torch.tensor(np.asarray(direction, dtype=np.float32))
        self.alpha = float(alpha)
        self.mode = mode
        self.threshold = float(threshold) if threshold is not None else 0.0
        self.records: list[float] = []

    def __call__(self, module, inputs, output):
        d = self.d.to(device=output.device, dtype=output.dtype)
        proj = output @ d  # [B, T]
        self.records.append(float(proj.mean().item()))
        if self.mode == "project":
            amount = proj
        else:
            amount = torch.clamp(proj - self.threshold, min=0.0)
        return output - (self.alpha * amount)[..., None] * d

    def attach(self, model):
        return model.norm.register_forward_hook(self)

    def reset(self) -> None:
        self.records.clear()

    def summary(self) -> dict:
        if not self.records:
            return dict(steps=0)
        r = np.array(self.records)
        return dict(steps=int(r.size), mean_proj=round(float(r.mean()), 2), max_proj=round(float(r.max()), 2))


def capture_lm_head_input(
    model,
    texts,
    processor,
    reference_codes,
    reference_text,
    sampling: dict,
    hook=None,
):
    """Generate while recording the LM head's input per step and the codes.

    Returns (audio, codes [10, T], hidden [T, D]) for a single text. The capture
    hook fires once per slow step, so row i of `hidden` is the state that chose
    frame i. An optional `steering hook` can be attached at the same time, which
    is how the self-test checks that steering changes the output while still
    producing a usable hidden trace.
    """
    captured: list[np.ndarray] = []

    def capture(module, inputs, output):
        captured.append(output.detach().float().cpu().numpy()[0, -1])

    handles = [model.norm.register_forward_hook(capture)]
    if hook is not None:
        handles.append(hook.attach(model))
    device = next(model.parameters()).device
    try:
        torch.manual_seed(int(sampling.get("seed", 1234)))
        inputs = processor(
            text=[texts],
            reference_codes=[reference_codes],
            reference_text=[reference_text],
            return_tensors="pt",
        )
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.inference_mode():
            out = model.generate(
                **inputs,
                max_new_tokens=int(sampling.get("max_new_tokens", 1024)),
                temperature=float(sampling.get("temperature", 0.8)),
                top_p=float(sampling.get("top_p", 0.8)),
                top_k=int(sampling.get("top_k", 30)),
                do_sample=True,
                return_dict_in_generate=True,
            )
            waveform, lengths = model.decode_audio(out.codes)
    finally:
        for handle in handles:
            handle.remove()

    codes = out.codes[0].cpu().numpy()
    audio = waveform[0, : int(lengths[0])].float().cpu().numpy()
    hidden = np.stack(captured[: codes.shape[1]])
    return audio, codes, hidden
