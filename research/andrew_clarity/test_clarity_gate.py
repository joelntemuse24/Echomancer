"""Tests for the clarity gate.

The gate itself has no fixtures in git (the samples are a customer hold-out), so
everything here is synthesised: a periodic "vowel", a noise "fricative", and mixtures
with known amounts of each. That is enough to pin the behaviour the research doc
relies on — in particular that `consonant_retention` falls when fricatives are
vocalised, and that `hf_balance_db` is level-invariant.
"""
from __future__ import annotations

import numpy as np
import pytest

from research.andrew_clarity.clarity_gate import (
    SAMPLE_RATE,
    align,
    band_balance,
    consonant_retention,
    gap_snr_p5,
    hf_balance_db,
    hf_from_noise_ratio,
    score,
    tail_periodicity,
    _frames,
    Frames,
)

RNG = np.random.RandomState(0)


def vowel(seconds=2.0, f0=110.0, hf=0.0):
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    y = np.sin(2 * np.pi * f0 * t) + 0.3 * np.sin(2 * np.pi * 2 * f0 * t)
    y += 0.1 * np.sin(2 * np.pi * 3 * f0 * t)
    if hf:
        y = y + hf * RNG.randn(len(t))
    return (y * 0.3).astype(np.float64)


def fricative(seconds=0.2, highpass=True):
    n = int(seconds * SAMPLE_RATE)
    y = RNG.randn(n)
    if highpass:
        # crude high-pass: first difference tilts energy upward
        y = np.diff(y, prepend=y[0])
    return (0.3 * y / np.abs(y).max()).astype(np.float64)


def speech_like(n_syllables=6):
    """Alternating vowel and fricative, which is what gives a reference aperiodic frames."""
    parts = []
    for _ in range(n_syllables):
        parts.append(vowel(0.4))
        parts.append(fricative(0.15))
    return np.concatenate(parts)


def test_frames_are_centred_and_counted():
    x = vowel(0.5)
    f = _frames(x, frame=1024, hop=256)
    assert f.shape[0] == 1 + (len(x) - 1) // 256


def test_periodic_audio_is_voiced_and_noise_is_not():
    v = Frames(vowel(2.0))
    n = Frames(RNG.randn(2 * SAMPLE_RATE).astype(np.float64))
    assert np.median(v.periodicity[v.speech]) > 0.6
    assert np.median(n.periodicity[n.speech]) < 0.2
    assert v.aperiodic.sum() < n.aperiodic.sum()


def test_noise_is_declared_speech_when_it_is_the_only_content():
    """A file of pure noise has no silence, so all of it is speech and all of it aperiodic."""
    n = Frames(RNG.randn(2 * SAMPLE_RATE).astype(np.float64))
    assert n.speech.mean() > 0.9
    assert n.aperiodic.mean() > 0.9


def test_consonant_retention_is_one_for_identity():
    ref = speech_like()
    assert Frames(ref).aperiodic.sum() > 10
    assert consonant_retention(ref, ref) == pytest.approx(1.0)


def test_consonant_retention_falls_when_the_fricative_is_vocalised():
    ref = speech_like()
    # same timeline, every fricative replaced by a voiced continuation: the "slur" failure mode
    slurred = np.concatenate([vowel(0.5, hf=0.03) if i % 2 == 0 else vowel(0.2, hf=0.03)
                              for i in range(6)])
    retained = consonant_retention(slurred, ref)
    assert retained < 0.5, retained


def test_hf_balance_is_level_invariant():
    """Scaling the whole signal must not move a level-matched band ratio."""
    x = vowel(2.0, hf=0.05)
    assert hf_balance_db(x, x) == pytest.approx(0.0, abs=1e-6)
    assert hf_balance_db(x * 0.1, x) == pytest.approx(0.0, abs=1e-3)
    assert hf_balance_db(x * 10.0, x) == pytest.approx(0.0, abs=1e-3)


def test_hf_balance_sees_a_real_high_band_loss():
    x = vowel(2.0, hf=0.05)
    # remove the top octave by differencing-free smoothing: keep only 0-5 kHz
    f = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1 / SAMPLE_RATE)
    f[freqs > 5000] = 0
    dull = np.fft.irfft(f, len(x))
    assert hf_balance_db(dull, x) < -6


def test_gap_snr_drops_when_the_gaps_are_filled():
    quiet = np.concatenate([vowel(1.0), np.zeros(SAMPLE_RATE // 2), vowel(1.0)])
    loud = np.concatenate([vowel(1.0), 0.05 * RNG.randn(SAMPLE_RATE // 2), vowel(1.0)])
    assert gap_snr_p5(Frames(loud)) < gap_snr_p5(Frames(quiet)) - 20


def test_hf_from_noise_is_high_for_alternating_vowel_and_fricative():
    """Where the high band exists only in the fricative, all of it is 'from noise'."""
    parts = []
    for _ in range(6):
        parts.append(vowel(0.4, hf=0.0))
        parts.append(fricative(0.15))
    x = np.concatenate(parts)
    r = hf_from_noise_ratio(Frames(x))
    assert r > 0.8, r


def test_tail_periodicity_separates_held_tone_from_release():
    held = vowel(1.0)
    released = np.concatenate([vowel(0.6), 0.05 * RNG.randn(int(0.4 * SAMPLE_RATE))])
    a = tail_periodicity(held, [1.0], ms=250)
    b = tail_periodicity(released, [1.0], ms=250)
    assert a > 0.6
    assert b < a


def test_align_is_monotone():
    a = vowel(1.0)
    b = vowel(1.0, f0=120.0)
    p = align(b, a)
    assert len(p) == _frames(a).shape[0]
    assert np.all(np.diff(p) >= 0)


def test_score_returns_every_documented_metric():
    x = vowel(1.5, hf=0.02)
    s = score(x, phrase_count=1)
    assert set(s) == {"gap_snr_p5", "env_modulation", "hf_from_noise", "tail_periodicity", "aperiodic_frac"}
    assert all(np.isfinite(v) or np.isnan(v) for v in s.values())


def test_band_balance_keys_are_stable():
    b = band_balance(Frames(vowel(1.0)))
    assert list(b) == ["800-1600", "1600-2500", "3500-5500", "5500-8000"]


def test_silence_only_input_does_not_crash():
    s = score(np.zeros(SAMPLE_RATE), phrase_count=1)
    assert np.isnan(s["env_modulation"]) or np.isfinite(s["env_modulation"])
