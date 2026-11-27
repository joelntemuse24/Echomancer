"""Clarity gates for Kokoro/Andrew retraining.

Six metrics that measure what a listener hears as "not as clean as real Edge Andrew",
to sit beside the existing likeness (ECAPA), WER, brightness, ripple and pace gates.

They are deliberately *relative* where they can be, scored against the real Edge Andrew
reference on the same text, because an absolute threshold on one take does not survive a
change of voice, text or level.

    consonant_retention   fraction of the reference's aperiodic (unvoiced) frames that are
                          still aperiodic in the candidate. Primary slurring metric: when
                          fricatives and plosive bursts are vocalised they merge into the
                          vowel and the words run together.
    onset_recall          fraction of the reference's syllable onsets whose energy rise
                          survives DTW warping. Temporal articulation.
    hf_balance_db         mean 3.5-8 kHz energy against the reference, level-matched at
                          300-3000 Hz. Negative = darker. Level-invariant by construction.
    hf_from_noise         share of the candidate's own 3.5-8 kHz energy that sits on
                          aperiodic frames. Real speech puts nearly all of it there;
                          voiced-only high band is generator buzz, not articulation.
    gap_snr_p5            90th percentile frame level minus 5th percentile, in dB. A small
                          value means the take never returns to silence.
    tail_periodicity      median autocorrelation peak over the last 250 ms of a phrase.
                          Too high = a held note instead of a release.
    env_modulation        std of the 500-4000 Hz log envelope over speech frames (syllable
                          depth). Low = flat, smeared delivery.

Two notes on why these are shaped the way they are:

* The speech mask is *relative* (within 35 dB of the 95th percentile frame), not an
  absolute floor. A percentile floor silently redefines "speech" when a take contains more
  or less silence than its neighbour, which is exactly the confound that makes the shipped
  `rolloff`/`hi_band` gate report a low-end shelf as "darker" (see the research doc §4).
* Nothing here is a neural metric. ECAPA already covers likeness; the point of these is to
  be cheap, deterministic, and explainable, so a gate failure points at a mechanism.
"""
from __future__ import annotations

import math

import numpy as np

SAMPLE_RATE = 24000
HOP = 256
FRAME = 1024
#: A frame counts as speech when it is within this many dB of the loud frames.
SPEECH_RANGE_DB = 35.0
#: Autocorrelation peak above this is treated as periodic (voiced).
VOICED_AC = 0.45


def _frames(x: np.ndarray, frame: int = FRAME, hop: int = HOP, window: bool = True) -> np.ndarray:
    if len(x) < frame:
        x = np.pad(x, (0, frame - len(x)))
    pad = frame // 2
    xp = np.pad(np.asarray(x, dtype=np.float64), (pad, pad))
    n = 1 + (len(x) - 1) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    out = xp[idx]
    return out * np.hanning(frame) if window else out


def _periodicity(fr: np.ndarray) -> np.ndarray:
    """Normalised autocorrelation peak per frame, searched over plausible pitch lags."""
    lo, hi = int(SAMPLE_RATE / 350), min(int(SAMPLE_RATE / 60) + 1, fr.shape[1])
    out = np.zeros(fr.shape[0])
    for i, f in enumerate(fr):
        e = float((f ** 2).sum())
        if e <= 0:
            continue
        ac = np.correlate(f, f, "full")[fr.shape[1] - 1:]
        ac = ac / (ac[0] + 1e-20)
        if hi > lo:
            out[i] = float(ac[lo:hi].max())
    return out


def _band_energy(power: np.ndarray, freqs: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return power[:, (freqs >= lo) & (freqs < hi)].sum(1)


class Frames:
    """One signal, analysed once. Every metric reads from here."""

    __slots__ = ("power", "freqs", "rms", "periodicity", "speech", "n")

    def __init__(self, x: np.ndarray):
        fr = _frames(x)
        self.n = fr.shape[0]
        spec = np.abs(np.fft.rfft(fr, axis=1))
        self.power = spec ** 2
        self.freqs = np.fft.rfftfreq(fr.shape[1], 1 / SAMPLE_RATE)
        self.rms = np.sqrt((fr ** 2).mean(1)) + 1e-12
        self.periodicity = _periodicity(fr)
        db = 20 * np.log10(self.rms + 1e-12)
        self.speech = db > (float(np.percentile(db, 95)) - SPEECH_RANGE_DB)

    @property
    def aperiodic(self) -> np.ndarray:
        return self.speech & (self.periodicity < VOICED_AC)

    def hf(self, lo=3500.0, hi=8000.0) -> np.ndarray:
        return _band_energy(self.power, self.freqs, lo, hi) + 1e-20


def gap_snr_p5(f: Frames) -> float:
    db = 20 * np.log10(f.rms + 1e-12)
    return float(np.percentile(db, 90) - np.percentile(db, 5))


def env_modulation(f: Frames, lo=500.0, hi=4000.0) -> float:
    """Std of the log envelope over speech frames — how deep the syllable swings are."""
    e = 20 * np.log10(_band_energy(f.power, f.freqs, lo, hi) + 1e-20)
    sel = e[f.speech]
    return float(np.std(sel)) if len(sel) > 4 else float("nan")


def hf_from_noise_ratio(f: Frames) -> float:
    """Share of 3.5-8 kHz energy that sits on aperiodic frames. 1.0 = all articulation."""
    hf = f.hf()
    sp = f.speech
    if not sp.any():
        return float("nan")
    tot = float(hf[sp].sum())
    ap = f.aperiodic
    return float(hf[ap].sum() / tot) if tot > 0 else float("nan")


def tail_periodicity(x: np.ndarray, phrase_ends: list[float], ms: int = 250) -> float:
    """Median autocorrelation peak in the last `ms` of each phrase."""
    n = int(ms / 1000 * SAMPLE_RATE)
    vals = []
    for end in phrase_ends:
        e = int(end * SAMPLE_RATE)
        seg = x[max(0, e - n):e]
        if len(seg) < n // 2:
            continue
        f = Frames(seg)
        vals.append(float(np.median(f.periodicity[f.speech])) if f.speech.any() else float("nan"))
    vals = [v for v in vals if math.isfinite(v)]
    return float(np.median(vals)) if vals else float("nan")


ANCHOR = (300.0, 3000.0)
BANDS = ((800.0, 1600.0), (1600.0, 2500.0), (3500.0, 5500.0), (5500.0, 8000.0))


def band_balance(f: Frames) -> dict[str, float]:
    """Band energy relative to the 300-3000 Hz anchor, in dB, on speech frames only.

    Level-matching on an anchor band rather than on total RMS is what makes the number
    comparable between systems and independent of the loudness of a take.
    """
    sp = f.speech
    if not sp.any():
        return {f"{int(lo)}-{int(hi)}": float("nan") for lo, hi in BANDS}
    anchor = float(_band_energy(f.power[sp], f.freqs, *ANCHOR).sum()) + 1e-20
    return {
        f"{int(lo)}-{int(hi)}": float(10 * np.log10(_band_energy(f.power[sp], f.freqs, lo, hi).sum() / anchor + 1e-20))
        for lo, hi in BANDS
    }


def hf_balance_db(candidate: np.ndarray, reference: np.ndarray) -> float:
    """Mean 3.5-8 kHz deficit against the reference, in dB, level-matched at 300-3000 Hz."""
    bc, br = band_balance(Frames(candidate)), band_balance(Frames(reference))
    keys = [k for k in bc if k.startswith(("3500", "5500"))]
    vals = [bc[k] - br[k] for k in keys if math.isfinite(bc[k]) and math.isfinite(br[k])]
    return float(np.mean(vals)) if vals else float("nan")


def _mfcc(x: np.ndarray, n: int = 20) -> np.ndarray:
    f = _frames(x, frame=FRAME, hop=HOP)
    spec = np.abs(np.fft.rfft(f, axis=1)) ** 2
    freqs = np.fft.rfftfreq(f.shape[1], 1 / SAMPLE_RATE)
    mel = lambda hz: 2595 * np.log10(1 + hz / 700)
    pts = np.linspace(mel(60), mel(7000), 28)
    hz = 700 * (10 ** (pts / 2595) - 1)
    fb = np.zeros((len(hz) - 2, len(freqs)))
    for i in range(len(hz) - 2):
        a, b, c = hz[i], hz[i + 1], hz[i + 2]
        fb[i] = np.clip(np.minimum((freqs - a) / (b - a), (c - freqs) / (c - b)), 0, None)
    logmel = np.log(spec @ fb.T + 1e-10)
    dct = np.cos(np.pi / len(fb) * (np.arange(len(fb)) + 0.5)[None, :] * np.arange(n)[:, None])
    return (logmel @ dct.T).T


def _dtw_path(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Greedy diagonal DTW; returns, per frame of `a`, the matching frame of `b`.

    Hand-rolled rather than librosa so the research gate adds no dependency. It only needs
    to be monotone and roughly right: the metrics above average over dozens of onsets, so a
    one-frame error does not move the number.
    """
    na, nb = a.shape[1], b.shape[1]
    cost = np.full((na + 1, nb + 1), np.inf)
    cost[0, 0] = 0.0
    for i in range(1, na + 1):
        d = np.abs(a[:, i - 1][:, None] - b[:, :]).sum(0)
        for j in range(1, nb + 1):
            cost[i, j] = d[j - 1] + min(cost[i - 1, j - 1], cost[i - 1, j], cost[i, j - 1])
    i, j = na, nb
    path = np.zeros(na, dtype=np.int64)
    while i > 0 and j > 0:
        path[i - 1] = j - 1
        step = int(np.argmin([cost[i - 1, j - 1], cost[i - 1, j], cost[i, j - 1]]))
        if step == 0:
            i, j = i - 1, j - 1
        elif step == 1:
            i -= 1
        else:
            j -= 1
    return path


def align(candidate: np.ndarray, reference: np.ndarray) -> np.ndarray:
    return _dtw_path(_mfcc(reference), _mfcc(candidate))


def phrase_ends_from_energy(x: np.ndarray, count: int) -> list[float]:
    """Locate the `count` longest internal silences and return their midpoints.

    The held-out passages are read with sentence pauses; this finds them without the text,
    so it also works on a real Edge reference.
    """
    f = Frames(x)
    db = 20 * np.log10(f.rms + 1e-12)
    thr = np.percentile(db, 8)
    quiet = db < thr
    runs, i = [], 0
    while i < len(quiet):
        if quiet[i]:
            j = i
            while j < len(quiet) and quiet[j]:
                j += 1
            if (j - i) * HOP / SAMPLE_RATE >= 0.08:
                runs.append(((i + j) // 2, (j - i) * HOP / SAMPLE_RATE))
            i = j
        else:
            i += 1
    runs.sort(key=lambda r: -r[1])
    keep = sorted(r[0] for r in runs[:count])
    return [k * HOP / SAMPLE_RATE for k in keep]


def onset_recall(candidate: np.ndarray, reference: np.ndarray, path: np.ndarray | None = None) -> float:
    """Fraction of the reference's onsets whose energy rise survives in the candidate."""
    if path is None:
        path = align(candidate, reference)
    fr, fc = Frames(reference), Frames(candidate)
    er = 20 * np.log10(_band_energy(fr.power, fr.freqs, 500, 4000) + 1e-20)
    ec = 20 * np.log10(_band_energy(fc.power, fc.freqs, 500, 4000) + 1e-20)
    dr, dc = np.diff(er), np.diff(ec)
    thr = np.percentile(dr, 95)
    onsets = [i for i in range(1, len(dr) - 1) if dr[i] > thr and dr[i] >= dr[i - 1] and dr[i] > dr[i + 1]]
    if not onsets:
        return float("nan")
    hit = 0
    for i in onsets:
        j = int(path[min(i, len(path) - 1)])
        w = dc[max(0, j - 2):j + 3]
        if len(w) and w.max() > np.percentile(dc, 80):
            hit += 1
    return hit / len(onsets)


def consonant_retention(candidate: np.ndarray, reference: np.ndarray, path: np.ndarray | None = None) -> float:
    """Fraction of the reference's aperiodic frames that the candidate also has aperiodic."""
    if path is None:
        path = align(candidate, reference)
    fr, fc = Frames(reference), Frames(candidate)
    n = min(len(path), fr.n)
    ref_ap = fr.aperiodic[:n]
    if ref_ap.sum() < 10:
        return float("nan")
    idx = np.clip(path[:n], 0, fc.n - 1)
    return float(np.mean(fc.periodicity[idx][ref_ap] < VOICED_AC))


def score(x: np.ndarray, phrase_count: int = 3) -> dict[str, float]:
    """Absolute metrics: no reference needed, so this is the per-candidate gate."""
    f = Frames(x)
    return {
        "gap_snr_p5": gap_snr_p5(f),
        "env_modulation": env_modulation(f),
        "hf_from_noise": hf_from_noise_ratio(f),
        "tail_periodicity": tail_periodicity(x, phrase_ends_from_energy(x, phrase_count)),
        "aperiodic_frac": float(f.aperiodic.sum() / max(f.speech.sum(), 1)),
    }


def score_pair(candidate: np.ndarray, reference: np.ndarray, phrase_count: int = 3) -> dict[str, float]:
    """Everything above, plus the reference-relative articulation and band metrics."""
    out = score(candidate, phrase_count)
    path = align(candidate, reference)
    out["consonant_retention"] = consonant_retention(candidate, reference, path)
    out["onset_recall"] = onset_recall(candidate, reference, path)
    out["hf_balance_db"] = hf_balance_db(candidate, reference)
    return out
