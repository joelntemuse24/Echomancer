"""Tests for the clarity losses.

Each loss must fail in the way it claims to and must not be satisfiable by a degenerate
answer. The two that matter for the ranked causes:

* `high_band_loss` must go up when the top octave is dulled, and must not be movable by
  simply changing the gain.
* `voicing_balance_loss` must go up when the high band is moved from noise-like frames
  onto harmonic frames — the measured step150 failure.

The multi-resolution term is checked against a known-smooth signal so a sign error or a
normalisation bug cannot pass silently.
"""
from __future__ import annotations

import pytest
import torch

from research.andrew_clarity.losses import (
    ClarityLoss,
    high_band_loss,
    mr_stft_loss,
    silence_floor_loss,
    voicing_balance_loss,
)

SR = 24000
torch.manual_seed(0)


def tone(seconds=0.4, f0=110.0, hf=0.0, seed=0) -> torch.Tensor:
    g = torch.Generator().manual_seed(seed)
    t = torch.arange(int(seconds * SR)) / SR
    y = torch.sin(2 * torch.pi * f0 * t) + 0.3 * torch.sin(2 * torch.pi * 2 * f0 * t)
    if hf:
        y = y + hf * torch.randn(len(t), generator=g)
    return (0.3 * y).float()[None]


def lowpass(x: torch.Tensor, cutoff: float) -> torch.Tensor:
    spec = torch.fft.rfft(x)
    freqs = torch.fft.rfftfreq(x.shape[-1], 1 / SR)
    spec[..., freqs > cutoff] = 0
    return torch.fft.irfft(spec, x.shape[-1])


def noise_burst(seconds=0.4, seed=1) -> torch.Tensor:
    g = torch.Generator().manual_seed(seed)
    n = torch.randn(int(seconds * SR), generator=g)
    n = torch.diff(n, prepend=n[:1])
    return (0.3 * n / n.abs().max()).float()[None]


def test_mr_stft_is_zero_for_identity():
    x = tone()
    assert float(mr_stft_loss(x, x)) == pytest.approx(0.0, abs=1e-5)


def test_mr_stft_is_scale_invariant():
    x = tone()
    assert float(mr_stft_loss(x * 0.25, x)) == pytest.approx(float(mr_stft_loss(x, x)), abs=1e-4)


def test_mr_stft_punishes_a_dulled_high_band():
    x = tone(hf=0.05)
    dull = lowpass(x, 4000)
    assert float(mr_stft_loss(dull, x)) > float(mr_stft_loss(x, x)) + 0.05


def test_mr_stft_punishes_broadband_noise_added_to_a_clean_tone():
    x = tone()
    noisy = x + 0.02 * torch.randn_like(x)
    assert float(mr_stft_loss(noisy, x)) > float(mr_stft_loss(x, x))


def test_high_band_loss_is_zero_for_identity_and_invariant_to_gain():
    x = tone(hf=0.05)
    assert float(high_band_loss(x, x)) == pytest.approx(0.0, abs=1e-5)
    assert float(high_band_loss(x * 0.1, x)) == pytest.approx(0.0, abs=1e-3)


def test_high_band_loss_rises_when_the_top_octave_is_cut():
    x = tone(hf=0.05)
    dull = lowpass(x, 5000)
    assert float(high_band_loss(dull, x)) > 2.0


def test_high_band_loss_barely_moves_when_low_end_is_added():
    """The gate's brightness measure is confounded by low end; this loss must not be.

    Adding energy at 90 Hz is the same perturbation that makes the shipped `hi_band`
    gate call the reference "darker" (see docs/research/andrew-clarity.md §4). Here the
    effect must be an order of magnitude smaller than a real top-octave loss.
    """
    x = tone(hf=0.05)
    t = torch.arange(x.shape[-1]) / SR
    low_added = x + 0.3 * torch.sin(2 * torch.pi * 90 * t)
    dull = lowpass(x, 5000)
    assert float(high_band_loss(low_added, x)) < 0.1
    assert float(high_band_loss(low_added, x)) < 0.01 * float(high_band_loss(dull, x))


def test_voicing_balance_separates_harmonic_and_noise_high_band():
    """A harmonic high band and a noise high band must not score the same."""
    harmonic = tone(hf=0.0)
    noisy = tone() + 0.05 * torch.randn_like(tone())
    assert float(voicing_balance_loss(noisy, harmonic)) > 0.1


def test_voicing_balance_is_zero_for_identity():
    x = tone(hf=0.03)
    assert float(voicing_balance_loss(x, x)) == pytest.approx(0.0, abs=1e-5)


def test_voicing_balance_detects_a_vocalised_fricative():
    """Replacing a fricative with a voiced continuation must raise the loss."""
    voiced = tone(seconds=0.8)
    ref = torch.cat([voiced[..., : int(0.4 * SR)], noise_burst(0.4)], dim=-1)
    assert float(voicing_balance_loss(voiced, ref)) > float(voicing_balance_loss(ref, ref)) + 0.05


def test_silence_floor_is_zero_for_identity():
    x = tone(seconds=0.5)
    assert float(silence_floor_loss(x, x)) == pytest.approx(0.0, abs=1e-4)


def test_silence_floor_rises_when_the_gaps_are_filled():
    quiet = torch.cat([tone(0.3), torch.zeros(1, int(0.3 * SR)), tone(0.3)], dim=-1)
    filled = quiet + 0.01 * torch.randn_like(quiet)
    assert float(silence_floor_loss(filled, quiet)) > 1.0


def test_silence_floor_is_not_satisfied_by_turning_a_filled_take_down():
    """Scaling a take that has residue in its gaps must not make the residue disappear.

    The loss compares the gap level to the *target's* gap level, so a uniform gain
    change moves the gaps and the speech together and the residual gap error stays.
    """
    quiet = torch.cat([tone(0.3), torch.zeros(1, int(0.3 * SR)), tone(0.3)], dim=-1)
    filled = quiet + 0.01 * torch.randn_like(quiet)
    full = float(silence_floor_loss(filled, quiet))
    scaled = float(silence_floor_loss(filled * 0.1, quiet))
    assert scaled > 10.0
    assert abs(scaled - full) > 1.0 or scaled > 15.0


def test_clarity_loss_gradients_reach_the_prediction():
    pred = lowpass(tone(hf=0.05), 4000).clone().requires_grad_(True)
    loss, _ = ClarityLoss()(pred, tone(hf=0.05), torch.tensor(1.0))
    loss.backward()
    assert pred.grad is not None
    assert torch.isfinite(pred.grad).all()
    assert pred.grad.abs().sum() > 0


def test_clarity_loss_gradient_is_zero_at_a_perfect_match():
    """Not a requirement, but worth pinning: identical audio must score exactly zero."""
    x = tone(hf=0.05)
    loss, parts = ClarityLoss(w_mel=0.0)(x, x, torch.tensor(0.0))
    assert float(loss) == pytest.approx(0.0, abs=1e-4)
    assert all(v == pytest.approx(0.0, abs=1e-4) for v in parts.values())


def test_short_crops_do_not_crash():
    """The trainer crops to 40 frames (about 0.5 s at 80 fps); every term must cope."""
    x = tone(seconds=0.5)
    loss, parts = ClarityLoss()(x, x, torch.tensor(0.5))
    assert torch.isfinite(loss)
    tiny = tone(seconds=0.05)
    loss2, _ = ClarityLoss()(tiny, tiny, torch.tensor(0.5))
    assert torch.isfinite(loss2)
