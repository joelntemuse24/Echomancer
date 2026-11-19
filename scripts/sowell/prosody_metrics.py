"""Pitch numbers in the shape of the 2026-11-19 prosody A/B.

    python3 scripts/sowell/prosody_metrics.py off.wav on.wav
    python3 scripts/sowell/prosody_metrics.py off.wav on.wav --andrew andrew.wav

A sibling ``.json`` from ``prosody_ab.py`` supplies sentence durations.
Without it, only the whole-file pitch spread is printed. Correlation
with Andrew needs ``--andrew`` and the same sentence count. ``librosa.pyin``
is used when that package is installed. Otherwise the F0 is a numpy
autocorrelation and the line says so.
"""

from __future__ import annotations

import json
import sys
import wave
from pathlib import Path

import numpy as np


def _load_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        count = handle.getnframes()
        width = handle.getsampwidth()
        channels = handle.getnchannels()
        raw = handle.readframes(count)
    if width == 2:
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
    elif width == 4:
        audio = np.frombuffer(raw, dtype=np.int32).astype(np.float64) / 2147483648.0
    else:
        raise SystemExit(f"{path} is not 16- or 32-bit PCM")
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


def _pyin(audio: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray, str]:
    try:
        import librosa
    except ImportError:
        return _autocorr(audio, rate)
    f0, voiced_flag, _prob = librosa.pyin(
        audio, fmin=60, fmax=320, sr=rate, frame_length=1024, hop_length=160
    )
    times = np.arange(len(f0)) * (160 / rate)
    voiced = np.asarray(voiced_flag, dtype=bool) & np.isfinite(f0)
    return times, np.where(voiced, f0, np.nan), "librosa.pyin"


def _autocorr(audio: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray, str]:
    hop = 160
    frame = 1024
    min_lag = max(1, int(rate / 320))
    max_lag = max(min_lag + 1, int(rate / 60))
    count = 1 + max(0, (len(audio) - frame) // hop)
    f0 = np.full(count, np.nan)
    window = np.hanning(frame)
    for index in range(count):
        start = index * hop
        chunk = audio[start : start + frame]
        if chunk.size < frame:
            break
        chunk = chunk * window
        if float(np.sqrt(np.mean(chunk * chunk))) < 0.01:
            continue
        corr = np.correlate(chunk, chunk, mode="full")[frame - 1 :]
        if corr[0] <= 0:
            continue
        lag = min_lag + int(np.argmax(corr[min_lag:max_lag]))
        if corr[lag] / corr[0] < 0.3:
            continue
        f0[index] = rate / lag
    times = np.arange(count) * (hop / rate)
    return times, f0, "numpy-autocorr"


def _st(hz: np.ndarray) -> np.ndarray:
    return 12.0 * np.log2(np.clip(hz, 1.0, None) / 100.0)


def _sentence_rows(times: np.ndarray, f0: np.ndarray, sentences: list[dict]) -> list[dict]:
    rows = []
    cursor = 0.0
    for sentence in sentences:
        end = cursor + float(sentence["seconds"])
        mask = (times >= cursor) & (times < end) & np.isfinite(f0)
        values = _st(f0[mask])
        if values.size == 0:
            rows.append({"kind": sentence.get("kind"), "f0_med": None, "final_move": None})
        else:
            tail = values[-15:] if values.size > 15 else values
            rows.append(
                {
                    "kind": sentence.get("kind"),
                    "f0_med": float(np.median(values)),
                    "final_move": float(np.median(tail) - np.median(values)),
                }
            )
        cursor = end
    return rows


def _artifacts(audio: np.ndarray, rate: int, times: np.ndarray, f0: np.ndarray) -> dict:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    voiced = f0[np.isfinite(f0)]
    jumps = 0
    if voiced.size > 1:
        finite = np.isfinite(f0)
        previous = np.nan
        for value, ok in zip(f0, finite):
            if not ok:
                previous = np.nan
                continue
            if np.isfinite(previous):
                ratio = max(value, previous) / max(1e-6, min(value, previous))
                if ratio > 1.9:
                    jumps += 1
            previous = value
    tail_n = max(1, int(0.05 * rate))
    tail = audio[-tail_n:]
    tail_rms = float(np.sqrt(np.mean(tail * tail))) if tail.size else 0.0
    # A buzz is energy with no pitch. High zero-crossings and a quiet F0
    # tail is the check; a voiced ending is not.
    signs = np.signbit(tail)
    zcr = float(np.mean(signs[1:] != signs[:-1])) if tail.size > 1 else 0.0
    end_time = len(audio) / rate
    end_voiced = np.isfinite(f0[(times >= end_time - 0.05) & (times < end_time + 1)])
    return {
        "peak": round(peak, 4),
        "clipped": peak >= 0.99,
        "octaveJumps": jumps,
        "endZeroCross": round(zcr, 3),
        "endRms": round(tail_rms, 4),
        "endVoiced": bool(end_voiced.any()) if end_voiced.size else False,
    }


def analyse(path: Path) -> dict:
    audio, rate = _load_wav(path)
    times, f0, method = _pyin(audio, rate)
    voiced = f0[np.isfinite(f0)]
    summary: dict = {
        "name": path.name,
        "f0Method": method,
        "seconds": round(len(audio) / rate, 3),
        "f0_std_st": None if voiced.size == 0 else round(float(np.std(_st(voiced))), 3),
    }
    sidecar = path.with_suffix(".json")
    rows: list[dict] = []
    if sidecar.is_file():
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        sentences = data.get("sentences") or []
        if sentences:
            rows = _sentence_rows(times, f0, sentences)
            medians = [row["f0_med"] for row in rows if row["f0_med"] is not None]
            # Any sentence that ends in a question mark, matching the A/B
            # script (it keyed off the final character, so wh-questions count).
            questions = [
                row["final_move"]
                for row in rows
                if row["kind"] in ("qyn", "qwh") and row["final_move"] is not None
            ]
            yes_no = [
                row["final_move"]
                for row in rows
                if row["kind"] == "qyn" and row["final_move"] is not None
            ]
            summary["sent_f0_median_spread_st"] = (
                None if len(medians) < 2 else round(float(np.std(medians)), 3)
            )
            summary["q_final_move_st"] = (
                None if not questions else round(float(np.mean(questions)), 3)
            )
            summary["qyn_final_move_st"] = (
                None if not yes_no else round(float(np.mean(yes_no)), 3)
            )
            summary["sentenceCount"] = len(rows)
    summary["artifacts"] = _artifacts(audio, rate, times, f0)
    summary["rows"] = rows
    return summary


def main(argv: list[str]) -> int:
    args = list(argv[1:])
    andrew: Path | None = None
    if "--andrew" in args:
        at = args.index("--andrew")
        andrew = Path(args[at + 1])
        del args[at : at + 2]
    if not args:
        print("usage: prosody_metrics.py off.wav on.wav [--andrew andrew.wav]")
        return 2
    reports = [analyse(Path(name)) for name in args]
    if andrew is not None:
        reference = analyse(andrew)
        ref_rows = reference["rows"]
        for report in reports:
            rows = report["rows"]
            if ref_rows and len(rows) == len(ref_rows):
                a = [row["f0_med"] for row in rows]
                b = [row["f0_med"] for row in ref_rows]
                if all(value is not None for value in a + b):
                    report["corr_vs_andrew_f0_med"] = round(float(np.corrcoef(a, b)[0, 1]), 3)
            else:
                report["corr_vs_andrew_f0_med"] = None
        reports.append(reference)
    for report in reports:
        printable = {key: value for key, value in report.items() if key != "rows"}
        print(json.dumps(printable))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
