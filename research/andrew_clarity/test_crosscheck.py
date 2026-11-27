"""Cross-check the losses and gates against each other on synthetic signals.

The two modules are meant to agree about what "worse" means. This is the guard that
stops them drifting apart: if someone retunes one and not the other, the correlation
here breaks.

The real-audio version of this check lives in `analyze_samples.py`; it cannot run in CI
because the samples are a customer hold-out.
"""
from __future__ import annotations

import numpy as np
import torch

import pytest

from research.andrew_clarity.clarity_gate import Frames, consonant_retention, hf_balance_db
from research.andrew_clarity.losses import high_band_loss, voicing_balance_loss

SR = 24000


def speech(n_syll=8, fric_gain=0.35, voiced_fric=0.0, hf_on_vowel=0.0, seed=0):
    """Alternating vowel and fricative, which is the smallest thing that has consonants.

    `voiced_fric` mixes a harmonic tone into the fricative slot — that is the measured
    failure (partial voicing), as opposed to simply making the fricative quiet.
    """
    g = torch.Generator().manual_seed(seed)
    parts = []
    for i in range(n_syll):
        t = torch.arange(int(0.35 * SR)) / SR
        f0 = 110 + 6 * i
        v = torch.sin(2 * torch.pi * f0 * t) + 0.3 * torch.sin(4 * torch.pi * f0 * t)
        if hf_on_vowel:
            v = v + hf_on_vowel * torch.randn(len(t), generator=g)
        parts.append(0.3 * v)
        f = torch.diff(torch.randn(int(0.12 * SR), generator=g), prepend=torch.zeros(1))
        f = fric_gain * f / f.abs().max()
        if voiced_fric:
            tf = torch.arange(len(f)) / SR
            f = f + voiced_fric * torch.sin(2 * torch.pi * f0 * tf)
        parts.append(f)
    return torch.cat(parts).float()


def as_np(x: torch.Tensor) -> np.ndarray:
    return x.numpy().astype(np.float64)


def test_both_modules_agree_that_a_partly_voiced_fricative_is_worse():
    """The measured failure: the fricative keeps its spectrum but gains a harmonic."""
    clean = speech(fric_gain=0.35)
    slurred = speech(fric_gain=0.35, voiced_fric=0.25)
    assert float(voicing_balance_loss(slurred, clean)) > float(voicing_balance_loss(clean, clean))
    assert consonant_retention(as_np(slurred), as_np(clean)) < 0.8


def test_both_modules_agree_that_a_dull_top_octave_is_worse():
    from research.andrew_clarity.losses import mr_stft_loss

    clean = speech()
    dull = torch.fft.irfft(
        torch.fft.rfft(clean).masked_fill(
            torch.fft.rfftfreq(clean.shape[-1], 1 / SR) > 5000, 0), clean.shape[-1])
    # the same direction from both modules, and a large gate effect
    assert float(high_band_loss(dull, clean)) > 1.0
    assert float(mr_stft_loss(dull, clean)) > float(mr_stft_loss(clean, clean))
    assert hf_balance_db(as_np(dull), as_np(clean)) < -3.0


def test_gates_and_losses_both_ignore_a_pure_gain_change():
    clean = speech()
    quieter = clean * 0.2
    assert float(voicing_balance_loss(quieter, clean)) == pytest.approx(
        float(voicing_balance_loss(clean, clean)), abs=1e-4)
    assert hf_balance_db(as_np(quieter), as_np(clean)) == pytest.approx(0.0, abs=0.02)


def test_frames_helper_agrees_with_the_gate_about_speech():
    x = np.concatenate([np.zeros(SR // 4), as_np(speech(n_syll=2)), np.zeros(SR // 4)])
    f = Frames(x)
    assert f.speech[SR // 4 // 256:].mean() > 0.5
    assert f.speech.mean() < 0.95
