"""Breath and codec-tick probes.

Both detectors are level-relative: they take the 90th percentile of frame level as
"speech" and describe everything else in dB below it, so one threshold set works
for a loud voice and a quiet one. Both are calibrated against real material:

  * `detect_ticks` reproduces the trial's `abs_ticks` measure (HF envelope at
    128 samples, peaks above an absolute dBFS floor inside quiet frames) so the
    numbers here are directly comparable to the 13-31 ticks per pause-minute the
    trial measured on Audio8 and the 0 it measured on Drama 3. It also returns
    the shape of each burst (width in samples, kurtosis) so a real impulse can be
    told apart from the crest of a sibilant, and it reports whether the bursts
    are spaced at the 46.4 ms codec hop.
  * `detect_breaths` reproduces the trial's `breath2.py` frame test, and
    classifies each run as a pause, a pre-sentence inhale, or the post-sentence
    "ahh" from the voicing contour alone -- no ASR needed, so the GPU jobs can
    score a take in a second.

Validated on: LibriSpeech clean 44.1 kHz speech (0 ticks, 0 breaths in digital
silence), the codec's own silence latents (0 ticks), and a synthetic -42 dBFS
impulse train at the codec hop (every impulse caught, spacing 45 ms).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import scipy.signal as ss

from .frames import (
    HOP,
    SAMPLE_RATE,
    TICK_BAND_HZ,
    frame_db,
    frame_spectra,
    quiet_mask,
    speech_level_db,
    voiced_mask,
)

FRAME_MS = HOP / SAMPLE_RATE * 1000.0  # 46.44 ms; the codec frame hop

# A run shorter than this is a consonant fragment on a voicing edge, not a
# breath. 150 ms is what the earlier trial's gap-based breath count used, so the
# counts here are directly comparable with it.
MIN_BREATH_S = 0.15


def band_limit(x: np.ndarray, lo: float = TICK_BAND_HZ[0], hi: float = TICK_BAND_HZ[1]) -> np.ndarray:
    nyq = SAMPLE_RATE / 2.0
    b, a = ss.butter(4, [lo / nyq, hi / nyq], btype="band")
    return ss.filtfilt(b, a, np.asarray(x, dtype=np.float64))


@dataclass
class TickReport:
    quiet_seconds: float
    ticks: int
    ticks_per_pause_minute: float
    loudest_db: float
    above_48dbfs: int
    spacing_mode_ms: float | None
    frame_periodic_fraction: float
    median_width_samples: float
    median_kurtosis: float
    per_frame: list[int] = field(default_factory=list)
    examples: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "quiet_seconds": round(self.quiet_seconds, 3),
            "ticks": self.ticks,
            "ticks_per_pause_minute": round(self.ticks_per_pause_minute, 2),
            "loudest_db": round(self.loudest_db, 1),
            "above_48dbfs": self.above_48dbfs,
            "spacing_mode_ms": self.spacing_mode_ms,
            "frame_periodic_fraction": round(self.frame_periodic_fraction, 3),
            "median_width_samples": round(self.median_width_samples, 1),
            "median_kurtosis": round(self.median_kurtosis, 1),
        }


def detect_ticks(
    x: np.ndarray,
    *,
    quiet_below_speech_db: float = 35.0,
    floor_dbfs: float = -45.0,
    window: int = 128,
    min_separation: int = 8,
    hold_ms: float = 60.0,
) -> TickReport:
    """HF impulses inside quiet codec frames.

    Deliberately the same measure the earlier trial used, so its numbers carry
    over: the 5-16 kHz envelope is taken in 128-sample windows, a burst is a peak
    at least `floor_dbfs` absolute, and it counts only inside a pause frame. Pause
    frames are the ones at least `quiet_below_speech_db` below *this take's* speech
    level, so a loud voice and a quiet voice get the same rule, and the mask is
    median-filtered over `hold_ms` so one loud sample cannot carve a hole in it.

    -45 dBFS is not arbitrary: the ticks measured in the trial sat at about
    -42 dBFS, while the codec's own digital-silence latents decode at about -88,
    so the floor has 40 dB of headroom on both sides.

    Valid negative controls (both report 0): the encoder's digital-silence
    latents decoded, and silence itself. A *raw recording* is not a valid
    negative control, because real narration contains breaths whose HF crest
    lands in the same band; that is what makes `frame_periodic_fraction` and the
    burst shape useful. A tick train is spaced at the 46.4 ms codec hop and each
    burst is narrow; a breathing human is neither.
    """
    x = np.asarray(x, dtype=np.float64)
    if x.size < HOP:
        return TickReport(0.0, 0, 0.0, -200.0, 0, None, 0.0, 0.0, 0.0)

    high = band_limit(x, 5000.0, 16000.0)
    level = frame_db(x)
    speech = speech_level_db(x)
    quiet = level < speech - quiet_below_speech_db
    hold = max(3, int(hold_ms / 1000.0 * SAMPLE_RATE / window) | 1)
    quiet_smooth = ss.medfilt(quiet.astype(float), hold) > 0.5
    quiet_seconds = float(quiet_smooth.sum() * HOP / SAMPLE_RATE)

    usable = (len(high) // window) * window
    envelope = 20.0 * np.log10(np.abs(high[:usable].reshape(-1, window)).max(axis=1) + 1e-12)
    peaks, _ = ss.find_peaks(envelope, height=floor_dbfs, distance=min_separation)

    hits: list[dict] = []
    for p in peaks:
        fi = int((p * window) // HOP)
        if fi >= len(quiet_smooth) or not quiet_smooth[fi]:
            continue
        a, b = fi * HOP, min((fi + 1) * HOP, len(high))
        segment = np.abs(high[a:b])
        peak = float(segment.max()) if segment.size else 0.0
        var = float(segment.var()) if segment.size else 0.0
        kurtosis = float(np.mean((segment - segment.mean()) ** 4) / (var * var + 1e-20)) if var > 0 else 0.0
        # descriptive only: how many 128-sample windows stay within 10 dB of the peak
        width_windows = 1
        while p + width_windows < envelope.size and envelope[p + width_windows] > envelope[p] - 10.0:
            width_windows += 1
        hits.append(
            dict(
                frame=fi,
                t=round(float(a / SAMPLE_RATE), 3),
                peak_db=round(float(envelope[p]), 1),
                width_samples=int(width_windows * window),
                kurtosis=round(kurtosis, 1),
            )
        )

    frames = np.array([h["frame"] for h in hits], dtype=np.float64)
    if frames.size >= 3:
        gaps_ms = np.diff(frames) * HOP / SAMPLE_RATE * 1000.0
        histogram, edges = np.histogram(gaps_ms, bins=np.arange(0.0, 200.0, 10.0))
        mode_ms = round(float(edges[int(np.argmax(histogram))] + 5.0), 1) if histogram.max() > 0 else None
        periodic = float(np.mean((gaps_ms > FRAME_MS - 6.0) & (gaps_ms < FRAME_MS + 12.0)))
    else:
        mode_ms, periodic = None, 0.0

    return TickReport(
        quiet_seconds=quiet_seconds,
        ticks=len(hits),
        ticks_per_pause_minute=(len(hits) / (quiet_seconds / 60.0)) if quiet_seconds > 0 else 0.0,
        loudest_db=max((h["peak_db"] for h in hits), default=-200.0),
        above_48dbfs=int(sum(1 for h in hits if h["peak_db"] > -48.0)),
        spacing_mode_ms=mode_ms,
        frame_periodic_fraction=periodic,
        median_width_samples=float(np.median([h["width_samples"] for h in hits])) if hits else 0.0,
        median_kurtosis=float(np.median([h["kurtosis"] for h in hits])) if hits else 0.0,
        per_frame=[int(h["frame"]) for h in hits],
        examples=hits[:8],
    )


def hf_crest_db(x: np.ndarray, band: tuple[float, float] = (4500.0, 14000.0)) -> float:
    h = band_limit(x, *band)
    if h.size == 0:
        return -200.0
    return float(20.0 * np.log10(np.abs(h).max() + 1e-12))


def quiet_hf_crest_db(x: np.ndarray, below_speech_db: float = 38.0) -> float:
    """Loudest HF sample restricted to quiet frames: the honest tick measure."""
    q = quiet_mask(x, below_speech_db)
    if not q.any():
        return -200.0
    h = band_limit(x)
    best = -200.0
    for fi in np.flatnonzero(q):
        a, b = fi * HOP, min((fi + 1) * HOP, h.size)
        if b > a:
            best = max(best, float(20.0 * np.log10(np.abs(h[a:b]).max() + 1e-12)))
    return best


def hf_burst_frames(
    x: np.ndarray,
    *,
    below_speech_db: float = 38.0,
    crest_threshold_db: float = -55.0,
) -> dict:
    """Quiet codec frames that still carry HF energy: the frame-periodic measure.

    A breathy latent puts one burst of 5-14 kHz frication into every 46.4 ms
    frame it occupies, so the artifact repeats at the codec frame rate however
    wide each individual burst is. This counts those frames per minute of quiet
    audio, which is the measure least sensitive to detector tuning.
    """
    x = np.asarray(x, dtype=np.float64)
    levels = frame_db(x)
    if levels.size == 0:
        return dict(quiet_seconds=0.0, hf_frames=0, hf_frames_per_pause_minute=0.0, crest_p95=-200.0)
    hf = band_limit(x)
    quiet = levels < speech_level_db(x) - below_speech_db
    quiet_seconds = float(quiet.sum() * HOP / SAMPLE_RATE)
    crests = []
    for fi in np.flatnonzero(quiet):
        a, b = fi * HOP, min((fi + 1) * HOP, len(hf))
        if b > a:
            crests.append(float(20.0 * np.log10(np.abs(hf[a:b]).max() + 1e-12)))
    if not crests:
        return dict(quiet_seconds=round(quiet_seconds, 2), hf_frames=0, hf_frames_per_pause_minute=0.0, crest_p95=-200.0)
    arr = np.asarray(crests)
    hot = int((arr >= crest_threshold_db).sum())
    return dict(
        quiet_seconds=round(quiet_seconds, 2),
        hf_frames=hot,
        hf_frames_per_pause_minute=round(hot / (quiet_seconds / 60.0), 2) if quiet_seconds > 0 else 0.0,
        crest_p95=round(float(np.percentile(arr, 95)), 1),
    )


# --------------------------------------------------------------------- breaths


@dataclass
class BreathCandidate:
    t: float
    dur: float
    peak_db: float
    rel_db: float
    centroid_hz: int
    kind: str  # pause | pre-sentence | post-sentence | inside-word

    def as_dict(self) -> dict:
        return dict(
            t=self.t,
            dur=self.dur,
            peak_db=self.peak_db,
            rel_db=self.rel_db,
            centroid_hz=self.centroid_hz,
            kind=self.kind,
        )


@dataclass
class BreathReport:
    candidates: list[BreathCandidate]

    @property
    def total(self) -> int:
        return len(self.candidates)

    @property
    def audible(self) -> int:
        """Runs at least 150 ms long: what a listener hears as a breath.

        The earlier trial used exactly this run length for its gap-based breath
        count, and sub-100 ms runs are unvoiced consonant fragments sitting on a
        voicing edge, not breaths.
        """
        return sum(1 for c in self.candidates if c.dur >= MIN_BREATH_S)

    @property
    def loud(self) -> int:
        return sum(1 for c in self.candidates if c.peak_db > -60.0)

    @property
    def pause_ah(self) -> int:
        """The soft "ahh" after a sentence: an audible breath run just after speech."""
        return sum(1 for c in self.candidates if c.kind == "post-sentence" and c.dur >= MIN_BREATH_S)

    @property
    def inhales(self) -> int:
        return sum(1 for c in self.candidates if c.kind == "pre-sentence" and c.dur >= MIN_BREATH_S)

    def as_dict(self) -> dict:
        kinds = sorted({c.kind for c in self.candidates})
        return dict(
            total=self.total,
            audible=self.audible,
            kind_counts={"pause": sum(1 for c in self.candidates if c.kind == "pause" and c.dur >= MIN_BREATH_S),
                         "post-sentence": self.pause_ah,
                         "pre-sentence": self.inhales,
                         "inside-word": sum(1 for c in self.candidates if c.kind == "inside-word")},
            loud_over_minus60=self.loud,
            pause_ah=self.pause_ah,
            pre_sentence_inhale=self.inhales,
            by_kind={k: sum(1 for c in self.candidates if c.kind == k) for k in kinds},
            examples=[c.as_dict() for c in self.candidates[:12]],
        )


_BREATH_HOP = 441  # 10 ms analysis grid


def _breath_frames(x: np.ndarray):
    import librosa

    spec = np.abs(librosa.stft(np.asarray(x, dtype=np.float32), n_fft=2048, hop_length=_BREATH_HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=SAMPLE_RATE, n_fft=2048)
    norm = (np.hanning(2048) ** 2).sum()
    total = spec.sum(axis=0) + 1e-20
    level = 10.0 * np.log10(total * 2.0 / norm / 2048.0 + 1e-20)
    low = spec[freqs < 300].sum(axis=0) / total
    mid = spec[(freqs >= 800) & (freqs < 4500)].sum(axis=0) / total
    high = spec[freqs >= 4500].sum(axis=0) / total
    centroid = (freqs[:, None] * spec).sum(axis=0) / total
    return level, low, mid, high, centroid


def detect_breaths(
    x: np.ndarray,
    words: list[tuple[str, float, float]] | None = None,
    *,
    floor_db: float = -78.0,
    below_speech_db: float = 12.0,
    min_run_s: float = 0.05,
) -> BreathReport:
    """Unvoiced, formant-shaped runs outside voiced speech.

    `words` (word, start, end) come from ASR when available and make the
    classification exact. Without them the same classes are derived from the
    voicing contour, which is what the GPU jobs use: a run that starts within
    0.45 s of the last voiced frame and before any new voicing is the
    post-sentence "ahh"; a run that ends within 0.45 s of the next voiced frame
    is a pre-sentence inhale; anything else in a gap is a plain pause breath.
    """
    import librosa

    x = np.asarray(x, dtype=np.float32)
    if x.size < 4096:
        return BreathReport([])
    level, low, mid, high, centroid = _breath_frames(x)
    n = level.size
    times = np.arange(n) * _BREATH_HOP / SAMPLE_RATE
    loud = level[level > -60.0]
    speech = float(np.percentile(loud, 90.0)) if loud.size else -20.0

    voiced = np.zeros(n, dtype=bool)
    try:
        f0, flag, prob = librosa.pyin(
            x, fmin=60, fmax=400, sr=SAMPLE_RATE, frame_length=2048, hop_length=_BREATH_HOP
        )
        m = min(n, len(f0))
        voiced[:m] = (
            np.asarray(flag[:m], dtype=bool)
            | (np.nan_to_num(f0[:m], nan=0.0) > 0.0)
            | (prob[:m] > 0.4)
        )
    except Exception:  # pragma: no cover - pyin failure only loses the voiced split
        pass

    candidate = (
        (level > floor_db)
        & (level < speech - below_speech_db)
        & (~voiced)
        & (low < 0.25)
        & (mid > 0.45)
        & (high < 0.45)
        & (centroid > 700.0)
        & (centroid < 4500.0)
    )

    in_word = np.full(n, -1, dtype=int)
    if words:
        for k, (_, start, end) in enumerate(words):
            in_word[int(start * 100.0): int(end * 100.0) + 1] = k

    out: list[BreathCandidate] = []
    i = 0
    while i < n:
        if not candidate[i]:
            i += 1
            continue
        j = i
        while j < n and (candidate[j] or (j + 1 < n and candidate[j + 1])):
            j += 1
        duration = (j - i) * _BREATH_HOP / SAMPLE_RATE
        if duration >= min_run_s:
            kind = "inside-word" if words and set(in_word[i:j].tolist()) - {-1} else _classify_voicing(
                voiced, i, j, level, words, in_word
            )
            out.append(
                BreathCandidate(
                    t=round(float(times[i]), 2),
                    dur=round(float(duration), 2),
                    peak_db=round(float(level[i:j].max()), 1),
                    rel_db=round(float(level[i:j].max() - speech), 1),
                    centroid_hz=int(np.median(centroid[i:j])),
                    kind=kind,
                )
            )
        i = j + 1
    return BreathReport(out)


def _classify_voicing(voiced: np.ndarray, i: int, j: int, level: np.ndarray, words, in_word) -> str:
    """Name a breath run from voicing, level shape, and (optionally) words.

    The physical difference between the two artifacts is the envelope shape:

      * the post-sentence "ahh" is an **exhale** that starts right after the
        last word and then decays, so its peak sits in the first half of the run;
      * a pre-sentence inhale is drawn in and **rises** into the next word, so
        its peak sits in the second half.

    That distinction needs no ASR, which matters because the GPU jobs score
    takes before anything is transcribed. When `words` is supplied the sentence
    punctuation is used instead, which is exact.
    """
    if words:
        previous = next((w for w in reversed(words) if w[2] <= i * _BREATH_HOP / SAMPLE_RATE), None)
        following = next((w for w in words if w[1] >= j * _BREATH_HOP / SAMPLE_RATE), None)
        if previous is not None and previous[0].rstrip("\"'")[-1:] in ".!?":
            return "post-sentence"
        if following is not None and previous is None:
            return "pre-sentence"

    run = level[i:j]
    if run.size < 3:
        return "pause"
    peak_at = float(np.argmax(run)) / max(1, run.size - 1)  # 0 = start, 1 = end
    before = np.flatnonzero(voiced[:i]) if i > 0 else np.array([], dtype=int)
    after = np.flatnonzero(voiced[j:]) if j < len(voiced) else np.array([], dtype=int)
    gap_before = (i - int(before[-1])) * _BREATH_HOP / SAMPLE_RATE if before.size else 99.0
    gap_after = int(after[0]) * _BREATH_HOP / SAMPLE_RATE if after.size else 99.0

    if gap_before <= 0.40 and peak_at <= 0.55:
        return "post-sentence"
    if gap_after <= 0.40 and peak_at >= 0.45:
        return "pre-sentence"
    return "pause"


def speech_band_balance(x: np.ndarray) -> dict:
    """Tilt of the take: 8-12 kHz against 1-4 kHz in voiced frames.

    A bright timbre makes the HF residue audible, which is why the same artifact
    was louder on one reference voice than another.
    """
    power, freqs = frame_spectra(x)
    if power.shape[0] == 0:
        return dict(voiced_8_12k_vs_1_4k_db=0.0)
    levels = frame_db(x)
    loud = levels > speech_level_db(x) - 15.0
    if not loud.any():
        return dict(voiced_8_12k_vs_1_4k_db=0.0)
    hi = power[np.ix_(loud, (freqs >= 8000) & (freqs < 12000))].sum()
    lo = power[np.ix_(loud, (freqs >= 1000) & (freqs < 4000))].sum()
    return dict(voiced_8_12k_vs_1_4k_db=round(float(10.0 * np.log10(hi / max(lo, 1e-20))), 1))
