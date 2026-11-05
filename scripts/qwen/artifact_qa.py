#!/usr/bin/env python3
"""Signal-level artifact checks for neural TTS renders (CPU only).

Three detectors that separate Qwen 3.1 Flash output from clean studio
references, human narration and other TTS engines. The standard MOS
predictors (DNSMOS, UTMOSv2, Audiobox Aesthetics, NISQA overall) rate these
renders as good as the references and cannot be used as a gate.

  fixed line   median (log spectrum - local envelope) over speech frames.
               Qwen sits +4.5..+5.6 dB at ~1.21 kHz; clean speech +0.4..+2.5.
               Heard as "robotic / metallic".
  gating       speech switched to / from digital silence within 10 ms.
               Qwen 20..105 cuts/min; clean recordings 0. Heard as "patchy".
               steep_decays_per_min counts a 30 dB fall within 10 ms from
               speech level whatever it lands on, so a chopped word tail
               still counts after a noise bed has filled the gap.
  harm_badness mean positive robust z of seven harmonic-structure features
               against clean speech. Qwen median 0.80..1.03; clean
               0.16..0.47. Heard as "gurgly". Needs praat-parselmouth;
               without it the harmonic family is reported as null.

Dependencies: numpy, scipy, ffmpeg on PATH (decode), optional
praat-parselmouth. No GPU, no network.

    python3 scripts/qwen/artifact_qa.py take.mp3 [more.mp3 ...]
        [--window 4] [--json out.json] [--csv windows.csv] [--events]
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage as nd
from scipy import signal as ss

try:  # Praat is only needed for the harmonic family.
    import parselmouth  # type: ignore
    from parselmouth.praat import call as praat_call  # type: ignore

    HAS_PRAAT = True
except Exception:  # pragma: no cover - exercised when parselmouth is absent
    parselmouth = None
    praat_call = None
    HAS_PRAAT = False

SR = 24_000

# Fixed-line detector (STFT 8192 / hop 480 at 24 kHz, 300 Hz envelope).
LINE_NFFT = 8192
LINE_HOP = 480
LINE_BAND_HZ = (1150.0, 1270.0)
LINE_ACTIVE_DB = 30.0
LINE_MIN_ACTIVE_FRAMES = 10

# Gating detector: 5 ms RMS frames relative to the 95th-percentile frame.
GATE_FRAME_S = 0.005
GATE_SPEECH_REL_DB = -45.0
GATE_SILENCE_REL_DB = -75.0
DIGITAL_SILENCE_DBFS = -90.0
PAUSE_REL_DB = -60.0
PAUSE_MIN_S = 0.06
STEEP_DROP_DB = 30.0

# Clean-speech baseline for harm_badness: (median, MAD*1.4826, sign), where
# sign +1 means higher is worse. Measured per speech-second on two studio
# references (Wolfe 15 s, VDH) and 112 s of LibriVox human narration, with
# the same feature code as below. Re-deriving it needs those recordings.
CLEAN_BASELINE: dict[str, tuple[float, float, int]] = {
    "mid_per": (0.452, 0.157156, -1),
    "hnr_db": (13.734, 2.52857, -1),
    "cpp_db": (19.645, 1.79024, -1),
    "harm_contrast_db": (12.6375, 2.91479, -1),
    "f0_jump_rate": (0.043, 0.0585627, +1),
    "shimmer_pct": (9.346, 1.74206, +1),
    "if_jitter_hz": (0.0735, 0.0170499, +1),
}
# 95th percentile of per-second harm_badness on that clean set.
CLEAN_HARM_P95 = 1.3508

# Pass/fail thresholds sit between the clean maximum and the Qwen minimum.
THRESHOLDS = {
    "line_db": 3.5,
    "cuts_per_min": 10.0,
    "harm_badness_median": 0.65,
}


# --------------------------------------------------------------------------
# I/O


def ffmpeg_bin() -> str:
    return os.environ.get("FFMPEG_PATH") or os.environ.get("TTS_FFMPEG_PATH") or "ffmpeg"


def load_audio(path: str, sr: int = SR) -> np.ndarray:
    """Decode any ffmpeg-readable file to mono float32 at `sr`."""
    if not shutil.which(ffmpeg_bin()) and not os.path.exists(ffmpeg_bin()):
        raise RuntimeError("ffmpeg is required to decode audio")
    out = subprocess.run(
        [ffmpeg_bin(), "-v", "error", "-nostdin", "-i", path, "-ac", "1",
         "-ar", str(sr), "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(out, dtype="<f4").astype(np.float64)


# --------------------------------------------------------------------------
# Shared DSP


def stft(y: np.ndarray, n_fft: int, hop: int) -> np.ndarray:
    """Centered, zero-padded, periodic-Hann STFT. Shape (n_fft//2+1, frames)."""
    pad = n_fft // 2
    x = np.pad(y, (pad, pad))
    n_frames = 1 + max(0, (len(x) - n_fft) // hop)
    if n_frames <= 0:
        return np.zeros((n_fft // 2 + 1, 0), dtype=complex)
    win = ss.get_window("hann", n_fft, fftbins=True)
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n_frames)[:, None]
    return np.fft.rfft(x[idx] * win, axis=1).T


def fft_freqs(n_fft: int, sr: int = SR) -> np.ndarray:
    return np.fft.rfftfreq(n_fft, 1.0 / sr)


def _r(x, n=3):
    if x is None:
        return None
    x = float(x)
    return None if not math.isfinite(x) else round(x, n)


# --------------------------------------------------------------------------
# 1. Fixed spectral line (metallic)


def _line_stats(R: np.ndarray, fr: np.ndarray, df: float) -> dict:
    lo = (fr >= 300) & (fr <= 3000)
    hi = (fr >= 4000) & (fr <= 8000)
    med = np.median(R, axis=1)
    v = med - nd.median_filter(med, size=81)
    a = v[lo] - v[lo].mean()
    ac = np.correlate(a, a, "full")[len(a) - 1:]
    ac = ac / (ac[0] + 1e-12)
    ks = np.arange(int(150 / df), int(700 / df))
    k = ks[np.argmax(ac[ks])]
    band = (fr > LINE_BAND_HZ[0]) & (fr < LINE_BAND_HZ[1])
    j = int(np.argmax(v[band]))
    return {
        "line_db": float(v[band][j]),
        "line_hz": float(fr[band][j]),
        "comb_index_db": float(np.std(v[lo]) - np.std(v[hi])),
        "ripple_spacing_hz": float(k * df),
        "ripple_autocorr": float(ac[k]),
        "residual": v,
    }


def _line_spectrum(y: np.ndarray, sr: int):
    S = 20 * np.log10(np.abs(stft(y, LINE_NFFT, LINE_HOP)) + 1e-7)
    fr = fft_freqs(LINE_NFFT, sr)
    df = sr / LINE_NFFT
    if S.shape[1] == 0:
        return S, fr, df, np.zeros(0, bool)
    e = S.max(0)
    act = e > np.percentile(e, 95) - LINE_ACTIVE_DB
    return S, fr, df, act


def fixed_line(y: np.ndarray, sr: int = SR, keep_residual: bool = False) -> dict:
    """Stationary spectral line near 1.21 kHz, plus the comb-ripple summary."""
    S, fr, df, act = _line_spectrum(y, sr)
    if act.sum() < LINE_MIN_ACTIVE_FRAMES:
        return {"line_db": None, "line_hz": None, "comb_index_db": None,
                "ripple_spacing_hz": None, "ripple_autocorr": None}
    R = S - nd.uniform_filter1d(S, size=int(300 / df), axis=0)
    st = _line_stats(R[:, act], fr, df)
    out = {k: _r(v, 2) for k, v in st.items() if k != "residual"}
    out["line_hz"] = _r(st["line_hz"], 0)
    if keep_residual:
        out["residual"] = st["residual"]
        out["freqs"] = fr
    return out


# --------------------------------------------------------------------------
# 2. Hard gating (patchy)


def frame_levels_db(y: np.ndarray, sr: int = SR) -> np.ndarray:
    fr = int(GATE_FRAME_S * sr)
    n = len(y) // fr
    if n == 0:
        return np.zeros(0)
    return 20 * np.log10(np.sqrt((y[: n * fr].reshape(n, fr) ** 2).mean(1)) + 1e-12)


def gating(y: np.ndarray, sr: int = SR, events: bool = False) -> dict:
    """Speech chopped to / switched on from digital silence within 10 ms."""
    e = frame_levels_db(y, sr)
    dur = len(y) / sr
    if len(e) < 3 or dur <= 0:
        return {"cut_offs": 0, "cut_ons": 0, "cuts_per_min": 0.0, "steep_decays_per_min": 0.0,
                "digital_silence_pct": 0.0, "pauses": 0, "cuts_per_pause": None}
    pk = np.percentile(e, 95)
    nxt = np.minimum(e[1:-1], e[2:])
    nxt_max = np.maximum(e[1:-1], e[2:])
    cur = e[:-2]
    off = np.where((cur > pk + GATE_SPEECH_REL_DB) & (nxt < pk + GATE_SILENCE_REL_DB))[0]
    on = np.where((cur < pk + GATE_SILENCE_REL_DB) & (nxt_max > pk + GATE_SPEECH_REL_DB))[0]

    quiet = (e < pk + PAUSE_REL_DB).astype(int)
    d = np.diff(np.r_[0, quiet, 0])
    starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
    pauses = int(((ends - starts) * GATE_FRAME_S >= PAUSE_MIN_S).sum())

    # Floor-independent: a fall of STEEP_DROP_DB within 10 ms from speech
    # level, whatever the level it lands on. Still fires when a noise bed
    # fills the gap but the word tail itself was chopped.
    steep = np.where((cur > pk + GATE_SPEECH_REL_DB) & (cur - nxt >= STEEP_DROP_DB))[0]
    if len(steep):
        steep = steep[np.r_[True, np.diff(steep) > 2]]
        steep = steep[steep < len(e) - 20]  # the take simply ending

    n_cuts = len(off) + len(on)
    out = {
        "cut_offs": int(len(off)),
        "cut_ons": int(len(on)),
        "cuts_per_min": round(n_cuts / dur * 60, 1),
        "steep_decays_per_min": round(len(steep) / dur * 60, 1),
        "digital_silence_pct": round(float(np.mean(e < DIGITAL_SILENCE_DBFS) * 100), 1),
        "pauses": pauses,
        "cuts_per_pause": round(n_cuts / pauses, 2) if pauses else None,
    }
    if events:
        ev = [{"t": round((i + 1) * GATE_FRAME_S, 3), "kind": "cut_off",
               "level_rel_db": round(float(e[i] - pk), 1)} for i in off]
        ev += [{"t": round((i + 1) * GATE_FRAME_S, 3), "kind": "cut_on",
                "level_rel_db": round(float(max(e[i + 1], e[i + 2]) - pk), 1)} for i in on]
        out["events"] = sorted(ev, key=lambda x: x["t"])
    return out


# --------------------------------------------------------------------------
# 3. Harmonic structure (gurgly)

_MID_SOS = ss.butter(6, [1000, 4000], "bandpass", fs=SR, output="sos")
_FEAT_NFFT = 1024
_FEAT_HOP = 240  # 10 ms
_HARM_NFFT = 4096


def _periodicity(x: np.ndarray, period: float) -> float:
    best = 0.0
    for lag in range(int(period * 0.95), int(period * 1.05) + 1):
        if lag <= 0 or lag >= len(x):
            continue
        a, b = x[:-lag], x[lag:]
        r = float(np.dot(a, b) / (np.sqrt(np.dot(a, a) * np.dot(b, b)) + 1e-12))
        best = max(best, r)
    return best


def _mid_periodicity_frames(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """1-4 kHz periodicity at the pitch period, Praat pitch every 20 ms."""
    m = ss.sosfiltfilt(_MID_SOS, y)
    pitch = parselmouth.Sound(y, sr).to_pitch_ac(time_step=0.02, pitch_floor=60, pitch_ceiling=400)
    ts, vals = [], []
    w = int(0.04 * sr)
    for t in pitch.xs():
        f0 = pitch.get_value_at_time(t)
        if not f0 or np.isnan(f0):
            continue
        c = int(t * sr)
        if c - w < 0 or c + w > len(y):
            continue
        seg = m[c - w: c + w]
        if np.sqrt(np.mean(seg ** 2)) < 1e-4:
            continue
        ts.append(t)
        vals.append(_periodicity(seg, sr / f0))
    return np.asarray(ts), np.asarray(vals)


def harmonic_timeline(y: np.ndarray, sr: int = SR) -> list[dict]:
    """Per-second harmonic features on speech seconds (speech_frac > 0.5)."""
    if not HAS_PRAAT or sr != SR or len(y) < sr:
        return []
    # Periodicity skips frames by absolute level, so it reads the take as is.
    mid_t, mid_v = _mid_periodicity_frames(y, sr)
    y = y / (np.sqrt(np.mean(y ** 2)) + 1e-9) * 0.05
    X = stft(y, _FEAT_NFFT, _FEAT_HOP)
    S = np.abs(X) ** 2
    nF = S.shape[1]
    t = np.arange(nF) * _FEAT_HOP / sr
    e = 10 * np.log10(S.sum(0) + 1e-12)
    speech = e > np.percentile(e, 95) - 35

    snd = parselmouth.Sound(y, sr)
    pit = snd.to_pitch_ac(time_step=_FEAT_HOP / sr, pitch_floor=60, pitch_ceiling=400)
    f0 = np.array([pit.get_value_at_time(tt) or np.nan for tt in t], dtype=float)
    f0 = np.where(np.isfinite(f0), f0, np.nan)
    voiced = np.isfinite(f0) & speech

    harm = snd.to_harmonicity_cc(time_step=0.01, minimum_pitch=60)
    # Nearest frame, not np.interp: Praat marks unvoiced frames -200 dB, and
    # interpolating across one gives values like -90 dB that pass a < -100
    # filter. The study detector did that, which made harm_badness swing by
    # ~0.15 when the same audio was shifted half a hop.
    hx = harm.xs()
    hv = np.asarray(harm.values[0], dtype=float).copy()
    hv[hv < -100] = np.nan
    if len(hx) > 1:
        k = np.clip(np.round((t - hx[0]) / (hx[1] - hx[0])).astype(int), 0, len(hv) - 1)
        hnr = hv[k]
    else:
        hnr = np.full(nF, np.nan)

    # Cepstral peak prominence over 60-400 Hz quefrencies.
    L = np.log(np.abs(X) + 1e-9)
    C = np.fft.irfft(L, axis=0)
    half = C.shape[0] // 2
    q = np.arange(C.shape[0])[:half] / sr
    Cd = 20 * np.log10(np.abs(C[:half]) + 1e-9)
    sel = np.where((q >= 1 / 400) & (q <= 1 / 60))[0]
    cpp = np.full(nF, np.nan)
    for i in np.where(voiced)[0]:
        c = Cd[:, i]
        k = sel[np.argmax(c[sel])]
        A = np.polyfit(q[sel], c[sel], 1)
        cpp[i] = c[k] - np.polyval(A, q[k])

    # Harmonic peak/valley contrast to 3 kHz and instantaneous-frequency
    # spread of harmonics 2-8.
    Xh = stft(y, _HARM_NFFT, _FEAT_HOP)
    Sh = np.abs(Xh)
    frh = fft_freqs(_HARM_NFFT, sr)
    dph = np.diff(np.angle(Xh), axis=1)
    kk = np.arange(Sh.shape[0])[:, None]
    expected = 2 * np.pi * kk * _FEAT_HOP / _HARM_NFFT
    IF = (expected + np.angle(np.exp(1j * (dph - expected)))) * sr / (2 * np.pi * _FEAT_HOP)
    hc = np.full(nF, np.nan)
    ifj = np.full(nF, np.nan)
    bin_hz = sr / _HARM_NFFT
    for i in np.where(voiced)[0]:
        if i < 1 or i >= Sh.shape[1] - 1:
            continue
        F = f0[i]
        pk, vl, dev = [], [], []
        for h in range(1, int(3000 // F) + 1):
            hb = int(np.argmin(np.abs(frh - h * F)))
            w = max(2, int(0.15 * F / bin_hz))
            lo = max(0, hb - w)
            j = lo + int(np.argmax(Sh[lo: hb + w + 1, i]))
            pk.append(20 * np.log10(Sh[j, i] + 1e-9))
            vb = int(np.argmin(np.abs(frh - (h + 0.5) * F)))
            vl.append(20 * np.log10(Sh[vb, i] + 1e-9))
            if 2 <= h <= 8 and i < IF.shape[1]:
                dev.append(IF[j, i - 1] / h - IF[j, i] / h)
        if len(pk) > 2:
            hc[i] = np.mean(pk[1:]) - np.mean(vl[1:])
        if dev:
            ifj[i] = np.nanstd(dev)

    cents = 1200 * np.log2(f0 / np.nanmedian(f0)) if np.isfinite(f0).any() else f0
    jumps = np.zeros(nF, bool)
    with np.errstate(invalid="ignore"):
        jumps[1:] = voiced[1:] & voiced[:-1] & (np.abs(np.diff(cents)) > 60)

    rows = []
    T = len(y) / sr
    for s in np.arange(0, max(1, math.floor(T)), 1.0):
        m = (t >= s) & (t < s + 1)
        mv = m & voiced
        ms = m & speech
        speech_frac = ms.sum() / max(1, m.sum())
        if speech_frac <= 0.5:
            continue
        seg = y[int(s * sr): int((s + 1) * sr)]
        try:
            sn = parselmouth.Sound(seg, sr)
            pp = praat_call(sn, "To PointProcess (periodic, cc)", 60, 400)
            shimmer = praat_call([sn, pp], "Get shimmer (local)", 0, 0, 0.0001, 0.02, 1.3, 1.6) * 100
        except Exception:
            shimmer = np.nan
        mm = (mid_t >= s) & (mid_t < s + 1)
        nanmean = lambda a: float(np.nanmean(a)) if mv.sum() and np.isfinite(a).any() else np.nan  # noqa: E731
        rows.append({
            "t": float(s),
            "speech_frac": float(speech_frac),
            "mid_per": float(np.median(mid_v[mm])) if mm.any() else np.nan,
            "hnr_db": nanmean(hnr[mv]),
            "cpp_db": nanmean(cpp[mv]),
            "harm_contrast_db": nanmean(hc[mv]),
            "f0_jump_rate": float(jumps[mv].mean()) if mv.sum() else np.nan,
            "shimmer_pct": float(shimmer),
            "if_jitter_hz": float(np.nanmedian(ifj[mv])) if mv.sum() and np.isfinite(ifj[mv]).any() else np.nan,
        })
    for r in rows:
        r["harm_badness"] = harm_badness(r)
    return rows


def harm_badness(features: dict) -> float:
    """Mean positive robust z against clean speech. NaN features count as 0."""
    zs = []
    for name, (med, mad, sign) in CLEAN_BASELINE.items():
        x = features.get(name)
        if x is None or not np.isfinite(x):
            zs.append(0.0)
            continue
        zs.append(max(0.0, sign * (x - med) / mad))
    return float(np.mean(zs))


def summarize_harmonic(rows: list[dict]) -> dict:
    if not rows:
        return {"harm_badness_median": None, "harm_badness_p90": None,
                "harm_flagged_pct": None, "mid_per_median": None, "speech_seconds": 0}
    hb = np.array([r["harm_badness"] for r in rows])
    mp = np.array([r["mid_per"] for r in rows], dtype=float)
    return {
        "harm_badness_median": _r(np.median(hb)),
        "harm_badness_p90": _r(np.quantile(hb, 0.9)),
        "harm_flagged_pct": _r(100 * np.mean(hb > CLEAN_HARM_P95), 1),
        "mid_per_median": _r(np.nanmedian(mp)) if np.isfinite(mp).any() else None,
        "speech_seconds": len(rows),
    }


# --------------------------------------------------------------------------
# Whole-file report


@dataclass
class Report:
    file: str
    duration_s: float
    line: dict
    gating: dict
    harmonic: dict
    windows: list = field(default_factory=list)
    flags: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "file": self.file,
            "duration_s": self.duration_s,
            **{k: v for k, v in self.line.items() if k not in ("residual", "freqs")},
            **{k: v for k, v in self.gating.items() if k != "events"},
            **self.harmonic,
            "flags": self.flags,
            **({"events": self.gating["events"]} if "events" in self.gating else {}),
            **({"windows": self.windows} if self.windows else {}),
        }


def flags_for(line: dict, gate: dict, harm: dict) -> list[str]:
    out = []
    if line.get("line_db") is not None and line["line_db"] > THRESHOLDS["line_db"]:
        out.append("metallic_line")
    if gate.get("cuts_per_min", 0) > THRESHOLDS["cuts_per_min"]:
        out.append("hard_gating")
    hb = harm.get("harm_badness_median")
    if hb is not None and hb > THRESHOLDS["harm_badness_median"]:
        out.append("smeared_harmonics")
    return out


def window_metrics(y: np.ndarray, sr: int, window_s: float, harm_rows: list[dict]) -> list[dict]:
    """Per-window line, gating and harm_badness. A partial last window is
    kept when it holds at least half a window."""
    w = int(window_s * sr)
    rows = []
    for a in range(0, len(y), w):
        seg = y[a: a + w]
        if len(seg) < w // 2:
            break
        t0 = a / sr
        ln = fixed_line(seg, sr)
        gt = gating(seg, sr)
        hb = [r["harm_badness"] for r in harm_rows if t0 <= r["t"] < t0 + window_s]
        rows.append({
            "t0": round(t0, 2),
            "line_db": ln["line_db"],
            "cuts_per_min": gt["cuts_per_min"],
            "cuts": gt["cut_offs"] + gt["cut_ons"],
            "pauses": gt["pauses"],
            "digital_silence_pct": gt["digital_silence_pct"],
            "harm_badness": _r(np.median(hb)) if hb else None,
        })
    return rows


def analyze(path_or_audio, sr: int = SR, window_s: float = 0.0, events: bool = False,
            harmonic: bool = True, name: str | None = None, stable: bool = False) -> Report:
    if isinstance(path_or_audio, str):
        y = load_audio(path_or_audio, sr)
        name = name or os.path.basename(path_or_audio)
    else:
        y = np.asarray(path_or_audio, dtype=np.float64)
        name = name or "<array>"
    line = fixed_line(y, sr)
    gate = gating(y, sr, events=events)
    rows = harmonic_timeline(y, sr) if harmonic else []
    harm = summarize_harmonic(rows) if harmonic and HAS_PRAAT else {
        "harm_badness_median": None, "harm_badness_p90": None,
        "harm_flagged_pct": None, "mid_per_median": None, "speech_seconds": 0}
    if stable and rows:
        harm["harm_badness_stable"] = stable_harm_badness(y, sr, rows)
    rep = Report(file=name, duration_s=round(len(y) / sr, 2), line=line, gating=gate,
                 harmonic=harm, flags=flags_for(line, gate, harm))
    if len(y) / sr < SHORT_TAKE_S:
        # The line and harm medians swing widely under ~15 s (an Edge voice
        # read 3.96 dB on a 6 s preview).
        rep.flags.append("low_confidence_short_take")
    if window_s > 0:
        rep.windows = window_metrics(y, sr, window_s, rows)
    return rep


STABLE_OFFSETS_S = (0.0, 0.25, 0.5, 0.75)
SHORT_TAKE_S = 15.0


def stable_harm_badness(y: np.ndarray, sr: int = SR, rows0: list[dict] | None = None) -> float | None:
    """Mean of the per-second harm_badness median over four segment offsets.

    The per-second median moves by up to ~0.2 when the same audio is shifted
    25 ms (pauses land in different seconds), so comparing two takes on the
    single-offset number is noise below that. Averaging over offsets
    removes most of it."""
    meds = []
    for off in STABLE_OFFSETS_S:
        rows = rows0 if off == 0.0 and rows0 is not None else harmonic_timeline(y[int(off * sr):], sr)
        if rows:
            meds.append(float(np.median([r["harm_badness"] for r in rows])))
    return _r(np.mean(meds)) if meds else None


def onset_vs_rest(windows: list[dict], split_s: float = 20.0) -> dict:
    """Mean of each window metric before / after `split_s` into the take."""
    out = {}
    for key in ("line_db", "cuts_per_min", "harm_badness"):
        early = [w[key] for w in windows if w[key] is not None and w["t0"] < split_s]
        late = [w[key] for w in windows if w[key] is not None and w["t0"] >= split_s]
        out[key] = {
            "first": _r(np.mean(early), 2) if early else None,
            "rest": _r(np.mean(late), 2) if late else None,
        }
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--window", type=float, default=0.0, help="per-window metrics, seconds (e.g. 4)")
    ap.add_argument("--json", help="write the full report list here")
    ap.add_argument("--csv", help="write per-window rows here (needs --window)")
    ap.add_argument("--events", action="store_true", help="include gating event timestamps")
    ap.add_argument("--no-harmonic", action="store_true", help="skip the Praat harmonic family")
    ap.add_argument("--stable-harm", action="store_true",
                    help="also report harm_badness_stable (4 offsets, 4x the harmonic time)")
    a = ap.parse_args(argv)

    reports = []
    for f in a.files:
        rep = analyze(f, window_s=a.window, events=a.events, harmonic=not a.no_harmonic,
                      stable=a.stable_harm)
        d = rep.as_dict()
        if rep.windows:
            d["onset_vs_rest"] = onset_vs_rest(rep.windows)
        reports.append(d)
        brief = {k: d.get(k) for k in ("file", "duration_s", "line_db", "cuts_per_min",
                                       "cuts_per_pause", "steep_decays_per_min", "digital_silence_pct",
                                       "harm_badness_median", "harm_badness_stable", "flags")}
        print(json.dumps(brief), flush=True)
    if not HAS_PRAAT and not a.no_harmonic:
        print("note: praat-parselmouth not installed; harm_badness is null", file=sys.stderr)
    if a.json:
        with open(a.json, "w") as fh:
            json.dump(reports, fh, indent=1)
    if a.csv and a.window:
        with open(a.csv, "w", newline="") as fh:
            wr = csv.DictWriter(fh, fieldnames=["file", "t0", "line_db", "cuts_per_min", "cuts",
                                                "pauses", "digital_silence_pct", "harm_badness"])
            wr.writeheader()
            for d in reports:
                for w in d.get("windows", []):
                    wr.writerow({"file": d["file"], **w})
    return 0


if __name__ == "__main__":
    sys.exit(main())
