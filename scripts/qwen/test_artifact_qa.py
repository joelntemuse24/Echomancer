"""Unit tests for artifact_qa.py on synthetic signals.

    python3 -m pytest scripts/qwen/test_artifact_qa.py

Set QWEN_QA_CLIPS to a folder holding the study clips (for example
baseline_chapter_wolfe_first40.mp3) to also check the published numbers.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import artifact_qa as q  # noqa: E402

SR = q.SR


def speechlike(seconds: float = 20.0, seed: int = 1, floor_db: float = -60.0) -> np.ndarray:
    """Voiced pulse train with a gliding pitch, shaped into ~4 Hz syllables
    with smooth onsets and decays, over a continuous noise floor."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f0 = 120 + 15 * np.sin(2 * np.pi * 0.3 * t)
    phase = 2 * np.pi * np.cumsum(f0) / SR
    voiced = sum(np.sin(k * phase) / k for k in range(1, 30))
    env = (np.clip(np.sin(2 * np.pi * 2.0 * t) + 0.4, 0, None) / 1.4) ** 1.5
    y = 0.2 * voiced * env
    y += 10 ** (floor_db / 20) * rng.standard_normal(n)
    return y


def test_fixed_line_rises_with_a_1215_hz_tone():
    base = speechlike()
    t = np.arange(len(base)) / SR
    env = np.abs(base) > 0.01
    tone = base + 0.02 * np.sin(2 * np.pi * 1215 * t) * env
    clean = q.fixed_line(base)
    marked = q.fixed_line(tone)
    assert marked["line_db"] > clean["line_db"] + 3
    assert abs(marked["line_hz"] - 1215) < 15


def test_continuous_floor_has_no_cuts():
    g = q.gating(speechlike())
    assert g["cuts_per_min"] == 0
    assert g["digital_silence_pct"] == 0
    assert g["steep_decays_per_min"] == 0


def test_hard_gating_is_counted():
    y = speechlike()
    # Switch to digital zero 30 ms into every syllable's decay.
    period = SR // 2
    for a in range(0, len(y) - period, period):
        y[a + int(0.22 * SR): a + period] = 0.0
    g = q.gating(y)
    assert g["cut_offs"] >= 30
    assert g["digital_silence_pct"] > 10
    assert g["steep_decays_per_min"] > 60


def test_steep_decay_still_counts_over_a_noise_bed():
    y = speechlike(floor_db=-70)
    rng = np.random.default_rng(7)
    period = SR // 2
    for a in range(0, len(y) - period, period):
        s = a + int(0.22 * SR)
        y[s: a + period] = 10 ** (-66 / 20) * 0.2 * rng.standard_normal(a + period - s)
    g = q.gating(y)
    assert g["cuts_per_min"] < 5
    assert g["steep_decays_per_min"] > 60


def test_harm_badness_is_zero_at_baseline_and_rises_away_from_it():
    clean = {k: med for k, (med, _mad, _s) in q.CLEAN_BASELINE.items()}
    assert q.harm_badness(clean) == 0.0
    worse = dict(clean)
    worse["hnr_db"] -= 2 * q.CLEAN_BASELINE["hnr_db"][1]
    worse["shimmer_pct"] += 2 * q.CLEAN_BASELINE["shimmer_pct"][1]
    assert q.harm_badness(worse) == pytest.approx(4 / 7)
    # Better than clean in the "good" direction never adds badness.
    better = dict(clean)
    better["hnr_db"] += 10
    assert q.harm_badness(better) == 0.0
    better["cpp_db"] = float("nan")
    assert q.harm_badness(better) == 0.0


def test_window_metrics_and_onset_split():
    rep = q.analyze(speechlike(seconds=30), window_s=4, harmonic=False)
    assert len(rep.windows) == 8  # 7 full windows + a 2 s tail (half a window)
    split = q.onset_vs_rest(rep.windows, 20)
    assert split["cuts_per_min"]["first"] == 0
    assert "low_confidence_short_take" not in rep.flags


def test_short_take_is_low_confidence():
    rep = q.analyze(speechlike(seconds=8), harmonic=False)
    assert "low_confidence_short_take" in rep.flags


def test_flags_follow_thresholds():
    flags = q.flags_for({"line_db": 5.0}, {"cuts_per_min": 40}, {"harm_badness_median": 0.9, "hf_flutter_db": 2.8})
    assert flags == ["metallic_line", "hard_gating", "smeared_harmonics", "hf_flutter"]
    assert q.flags_for({"line_db": 2.0}, {"cuts_per_min": 0}, {"harm_badness_median": 0.3, "hf_flutter_db": 2.0}) == []


@pytest.mark.skipif(not q.HAS_PRAAT, reason="praat-parselmouth not installed")
def test_harmonic_timeline_is_shift_stable():
    y = speechlike(seconds=12)
    a = q.harmonic_timeline(y)
    b = q.harmonic_timeline(np.r_[np.zeros(120), y])  # half a 10 ms hop
    assert len(a) >= 8 and len(b) >= 8
    ma = np.median([r["harm_badness"] for r in a])
    mb = np.median([r["harm_badness"] for r in b])
    assert abs(ma - mb) < 0.1


CLIPS = os.environ.get("QWEN_QA_CLIPS")
# line_db, cuts_per_min, digital_silence_pct as published by the study.
PUBLISHED = {
    "baseline_chapter_wolfe_first40.mp3": (4.81, 51.0, 21.3),
    "baseline_chapter_vdh_first40.mp3": (5.32, 19.5, 15.9),
    "bwolfe_ref15_t4_long.mp3": (4.02, 38.4, 16.0),
}


@pytest.mark.skipif(not CLIPS, reason="set QWEN_QA_CLIPS to the study clip folder")
@pytest.mark.parametrize("name", sorted(PUBLISHED))
def test_study_clips_reproduce(name):
    path = os.path.join(CLIPS or "", name)
    if not os.path.exists(path):
        pytest.skip(f"{name} not in QWEN_QA_CLIPS")
    rep = q.analyze(path, harmonic=False)
    line, cuts, dig = PUBLISHED[name]
    assert rep.line["line_db"] == pytest.approx(line, abs=0.05)
    assert rep.gating["cuts_per_min"] == pytest.approx(cuts, abs=0.5)
    assert rep.gating["digital_silence_pct"] == pytest.approx(dig, abs=0.3)
