"""Losses for a clean Andrew, and why each one is here.

The step150 run trained with `MelLoss` from `train.py`: mean log-mel L1 over three
resolutions and nothing else on the waveform. Measured on the held-out passage, that
objective prefers a stock Kokoro render over the real Edge reference (see
docs/research/andrew-clarity.md §5), so it cannot steer towards clarity. These losses
are the replacement.

Design constraints, all of them forced by the budget and by the failure modes already
observed in this project:

* **No discriminator in the default path.** The old teacher reached ECAPA 0.919 and
  sounded rough; the retrain's own history shows ripple climbing from 1.12 to 1.74 once
  the decoder was free. A GAN is the wrong first move at $6.80: it is the least stable
  thing in the toolbox and needs many more steps than a budget run can afford. The
  multi-resolution STFT term below already supplies the phase-sensitive, high-band
  pressure that the mel-only objective lacks, without a second network to train.
* **Everything is phase-aware where it matters.** Log-mel throws away phase, so it
  cannot distinguish a clean consonant burst from a smeared one. STFT losses keep it.
* **Every term is scale-aware but level-invariant.** The target audio and the frozen
  decoder's output are not at the same gain, and a loss that chases absolute gain wastes
  the run on an LUFS mismatch the app fixes later anyway.
* **Cheap.** These run on a 40-frame crop at batch 16 on an L4; the whole tick already
  spends most of its wall clock in the decoder, and two or three extra STFTs of the
  same 40-frame window are noise next to that.
"""
from __future__ import annotations

import torch
import torch.nn.functional as F


def _stft_mag(x: torch.Tensor, n_fft: int) -> torch.Tensor:
    win = torch.hann_window(n_fft, device=x.device, dtype=x.dtype)
    return torch.stft(x, n_fft, n_fft // 4, window=win, return_complex=True).abs()


def mr_stft_loss(pred: torch.Tensor, target: torch.Tensor,
                 sizes: tuple[int, ...] = (512, 1024, 2048)) -> torch.Tensor:
    """Multi-resolution spectral convergence + log-magnitude L1.

    Two terms per resolution, because they fail in different directions:

    * spectral convergence `||Y - X|| / ||Y||` is relative, so it keeps pushing on a
      quiet high band that a plain L1 would stop caring about — that is the 6-8 kHz
      deficit this run is trying to fix.
    * log-magnitude L1 `|log Y - log X|` is what stops the model from buying spectral
      convergence by adding broadband noise: noise raises the numerator and denominator
      together, and the log term punishes the resulting flat spectrum.

    Sizes go down to 512 (21 ms at 24 kHz), which is short enough to see a plosive
    burst. The mel loss in `train.py` used a 240-sample hop at its finest and could not.
    """
    n = min(pred.shape[-1], target.shape[-1])
    pred, target = pred[..., :n], target[..., :n]
    total = pred.new_zeros(())
    for size in sizes:
        p = _stft_mag(pred, size)
        t = _stft_mag(target, size)
        # One gain correction for both terms. Applying it to the spectral-convergence
        # term only would leave the log term chasing the frozen decoder's output gain,
        # which is not something a loss should spend a run on.
        scale = t.norm() / p.norm().clamp_min(1e-8)
        ps = p * scale
        sc = (t - ps).norm() / t.norm().clamp_min(1e-8)
        lm = F.l1_loss(torch.log(ps.clamp_min(1e-5)), torch.log(t.clamp_min(1e-5)))
        total = total + sc + lm
    return total / len(sizes)


def high_band_loss(pred: torch.Tensor, target: torch.Tensor, n_fft: int = 1024,
                   bands: tuple[tuple[float, float], ...] = ((4000.0, 6000.0), (6000.0, 8000.0)),
                   anchor: tuple[float, float] = (1000.0, 4000.0), sr: int = 24000) -> torch.Tensor:
    """Match each upper band's energy *relative to* a 1-4 kHz anchor, in dB.

    The measured failure is concentrated at 6-8 kHz: step150 sits ~4-6 dB above the
    reference there and a stock pack 7-11 dB above, while the mel-scale objective has
    most of its bins below 4 kHz and no reason to care about the shape of the top
    octaves.

    The comparison is a *balance* against an anchor band, not an absolute level:

    * a uniform gain change cancels, so the loss is not chasing the frozen decoder's
      output gain;
    * a change confined to the low end cannot move it. This is the confound that makes
      the shipped `hi_band` gate (6-8 kHz / 100-300 Hz) report a low-end shelf as
      "darker": measured, +3 dB below 200 Hz moves that gate by 3.3 dB while changing
      nothing above 1 kHz. Anchoring at 1-4 kHz instead means the same perturbation
      moves this loss by 0.06;
    * a genuinely missing top octave still moves it by tens of dB, because a quiet band
      has to be reported as a large negative ratio.
    """
    n = min(pred.shape[-1], target.shape[-1])
    pred, target = pred[..., :n], target[..., :n]
    p = _stft_mag(pred, n_fft).pow(2)
    t = _stft_mag(target, n_fft).pow(2)
    freqs = torch.linspace(0, sr / 2, p.shape[1], device=p.device)

    def balance(x: torch.Tensor) -> torch.Tensor:
        a = x[:, (freqs >= anchor[0]) & (freqs < anchor[1])].sum(1).clamp_min(1e-12)
        out = []
        for lo, hi in bands:
            b = x[:, (freqs >= lo) & (freqs < hi)].sum(1).clamp_min(1e-12)
            out.append(10 * torch.log10(b / a))
        return torch.stack(out)

    return F.l1_loss(balance(p), balance(t))


def voicing_balance_loss(pred: torch.Tensor, target: torch.Tensor, n_fft: int = 512,
                         sr: int = 24000, lo: float = 3500.0, hi: float = 8000.0) -> torch.Tensor:
    """Match how much of the high band is *noise-like* rather than harmonic.

    This is the term aimed squarely at the top-ranked cause. In the reference, almost all
    3.5-8 kHz energy sits in frames whose excitation is aperiodic — fricatives and bursts.
    step150 still puts its high-band energy in the right *places* (measured: -0.48 dB of
    total against the reference's -0.49), but 41% of the frames where Edge has a fricative
    come back periodic. The consonant keeps its spectrum and loses its voicing, which is
    what a listener hears as slurring.

    It is a *statistic*, not a per-sample target: it compares the fraction of high-band
    energy that is spectrally flat, so a different but equally plausible fricative still
    scores well. That is deliberate — the point is to restore the voicing distinction, not
    to copy the reference's noise realisation.
    """
    n = min(pred.shape[-1], target.shape[-1])
    if n < n_fft * 2:
        return pred.new_zeros(())
    pred, target = pred[..., :n], target[..., :n]
    # The trainer passes [B, T]; the tests and any single-file use pass [T]. Normalise to
    # 2-D here so the mean over frames is always dimension -1.
    squeeze = pred.dim() == 1
    if squeeze:
        pred, target = pred[None], target[None]
    out = []
    for x in (pred, target):
        mag = _stft_mag(x, n_fft)
        power = mag ** 2
        freqs = torch.linspace(0, sr / 2, power.shape[1], device=power.device)
        band = (freqs >= lo) & (freqs < hi)
        P = power[:, band].clamp_min(1e-12)
        # spectral flatness per frame, then the energy-weighted mean over frames
        flat = torch.exp(torch.log(P).mean(1)) / P.mean(1).clamp_min(1e-12)
        frame_e = P.sum(1)
        w = frame_e / frame_e.sum(-1, keepdim=True).clamp_min(1e-12)
        out.append((flat * w).sum(-1))
    return F.l1_loss(torch.log(out[0].clamp_min(1e-6)), torch.log(out[1].clamp_min(1e-6)))


def silence_floor_loss(pred: torch.Tensor, target: torch.Tensor, frame: int = 256,
                       rel_db: float = -40.0) -> torch.Tensor:
    """Push the candidate's quietest frames down to the target's level, in dB.

    The measured gap between 09 and real Edge is 81.7 dB versus 68.8 dB of dynamic range:
    the generator never fully returns to silence, so the quiet parts of a phrase carry a
    low-level residue. That residue is one half of "buzz at the ends of sentences" —
    it is what a listener hears as a tail that will not stop.

    Only frames the *target* marks as quiet are compared, so this cannot be satisfied by
    turning the whole take down.
    """
    n = min(pred.shape[-1], target.shape[-1])
    if n < frame * 4:
        return pred.new_zeros(())
    pred, target = pred[..., :n], target[..., :n]
    k = n // frame
    p = pred[..., :k * frame].reshape(*pred.shape[:-1], k, frame).pow(2).mean(-1).clamp_min(1e-12)
    t = target[..., :k * frame].reshape(*target.shape[:-1], k, frame).pow(2).mean(-1).clamp_min(1e-12)
    t_db = 10 * torch.log10(t)
    quiet = t_db < (t_db.max(dim=-1, keepdim=True).values + rel_db)
    if not quiet.any():
        return pred.new_zeros(())
    return F.l1_loss(10 * torch.log10(p)[quiet], t_db[quiet])


class ClarityLoss(torch.nn.Module):
    """Weighted sum of the terms above, on top of the existing mel loss.

    Defaults are deliberately conservative: the mel term stays dominant so the run does
    not trade away the likeness (ECAPA) it already has. Raise `w_mr` first if the first
    gate comes back with `hf_balance_db` still positive; raise `w_voice` if
    `consonant_retention` is still below ~0.8.

    `w_hi` and `w_silence` default to small non-zero values rather than zero so the very
    first scored checkpoint already reports whether they help; a stage that sets them to
    0 reproduces the old objective exactly, which is what the ablation needs.
    """

    def __init__(self, w_mel: float = 5.0, w_mr: float = 2.0, w_hi: float = 1.0,
                 w_voice: float = 0.5, w_silence: float = 0.5):
        super().__init__()
        self.w_mel, self.w_mr, self.w_hi = w_mel, w_mr, w_hi
        self.w_voice, self.w_silence = w_voice, w_silence

    def forward(self, pred: torch.Tensor, target: torch.Tensor, mel: torch.Tensor) -> tuple[torch.Tensor, dict[str, float]]:
        mr = mr_stft_loss(pred, target)
        hi = high_band_loss(pred, target)
        voice = voicing_balance_loss(pred, target)
        sil = silence_floor_loss(pred, target)
        total = self.w_mel * mel + self.w_mr * mr + self.w_hi * hi + self.w_voice * voice + self.w_silence * sil
        return total, {
            "mel": float(mel.detach()),
            "mr": float(mr.detach()),
            "hi": float(hi.detach()),
            "voice": float(voice.detach()),
            "silence": float(sil.detach()),
        }
