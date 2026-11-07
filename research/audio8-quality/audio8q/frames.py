"""Frame grid constants and frame-level features.

Audio8's codec packs 2048 samples per model frame at 44.1 kHz (46.4 ms). Every
measurement in this folder is expressed on that grid so a "frame" means the same
thing for the AR token stream and for the decoded waveform.
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 44100
HOP = 2048
FRAME_MS = HOP / SAMPLE_RATE * 1000.0  # 46.44 ms

# Codec band used by the tick detector: above the formant region, below Nyquist
# and below the 16 kHz ceiling of the 44.1 kHz codec's useful band.
TICK_BAND_HZ = (5000.0, 14000.0)


def frame_count(n_samples: int) -> int:
    return int(n_samples) // HOP


def frame_db(x: np.ndarray, n: int = HOP) -> np.ndarray:
    """Per-frame RMS in dBFS on the codec grid (truncates the tail)."""
    usable = (len(x) // n) * n
    if usable == 0:
        return np.zeros(0)
    frames = np.asarray(x[:usable], dtype=np.float64).reshape(-1, n)
    rms = np.sqrt((frames**2).mean(axis=1) + 1e-20)
    return 20.0 * np.log10(rms + 1e-12)


def frame_spectra(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Hann-windowed power spectra per codec frame, plus the bin frequencies."""
    usable = (len(x) // HOP) * HOP
    if usable == 0:
        empty = np.zeros((0, HOP // 2 + 1))
        return empty, np.fft.rfftfreq(HOP, 1.0 / SAMPLE_RATE)
    frames = np.asarray(x[:usable], dtype=np.float64).reshape(-1, HOP)
    power = np.abs(np.fft.rfft(frames * np.hanning(HOP), axis=1)) ** 2
    return power, np.fft.rfftfreq(HOP, 1.0 / SAMPLE_RATE)


def voiced_mask(x: np.ndarray) -> np.ndarray:
    """Per-frame voicing on the codec grid, via pyin.

    pyin is slow, so callers that only need a crude split should use
    `loud_quiet_mask` instead. Returns all-False when pyin cannot run.
    """
    try:
        import librosa
    except ImportError:  # pragma: no cover - librosa is a hard dep of the harness
        return np.zeros(frame_count(len(x)), dtype=bool)
    n = frame_count(len(x))
    if n == 0:
        return np.zeros(0, dtype=bool)
    f0, voiced_flag, voiced_prob = librosa.pyin(
        np.asarray(x, dtype=np.float32),
        fmin=60,
        fmax=400,
        sr=SAMPLE_RATE,
        frame_length=HOP,
        hop_length=HOP,
        center=False,
    )
    m = min(n, len(f0))
    out = np.zeros(n, dtype=bool)
    out[:m] = np.asarray(voiced_flag[:m], dtype=bool) | (np.nan_to_num(f0[:m], nan=0.0) > 0.0) | (voiced_prob[:m] > 0.4)
    return out


def speech_level_db(x: np.ndarray) -> float:
    """90th-percentile frame level, used as the "loud speech" reference.

    A fixed threshold does not travel between voices or recordings, so every
    level test in this folder is relative to this number.
    """
    levels = frame_db(x)
    loud = levels[levels > -60.0]
    if loud.size == 0:
        return -20.0
    return float(np.percentile(loud, 90.0))


def quiet_mask(x: np.ndarray, below_speech_db: float = 40.0, absolute_db: float = -51.0) -> np.ndarray:
    """Frames that count as a pause.

    The threshold is the *higher* of "well below this take's speech" and an
    absolute floor, so a take with no loud speech at all (silence, a synthetic
    impulse train) still has a usable pause mask. -51 dBFS is where the earlier
    trial put its pause boundary: it compared frame level against the 95th
    percentile minus 40 dB, which for normal narration lands within a dB or two
    of -51. Keeping the absolute floor here means the numbers in this folder are
    comparable with that trial's.
    """
    levels = frame_db(x)
    threshold = max(speech_level_db(x) - below_speech_db, absolute_db)
    return levels < threshold
