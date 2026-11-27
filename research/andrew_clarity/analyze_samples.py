#!/usr/bin/env python3
"""Reproduce every number quoted in docs/research/andrew-clarity.md.

    python3 research/andrew_clarity/analyze_samples.py --dir /path/to/samples

`samples/` is the archive that came with the ticket: four MP3s of the same held-out
passage (09 = fine-tuned step150 at speed 0.85, 07 = real Edge Andrew at 1x,
03 = the old over-trained teacher, 02 = stock Kokoro with a clean low-likeness pack).

Optional `--pack` renders the checkpointed style pack on *stock* Kokoro weights, which
is the ablation that separates "the fine-tune did this" from "the style vector did this".
That path needs `kokoro`, `torch` and the pinned weights; every other section needs only
numpy, scipy and librosa.

Nothing here calls a paid API and nothing writes outside --out.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

import librosa
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clarity_gate import (  # noqa: E402
    Frames,
    SAMPLE_RATE,
    align,
    consonant_retention,
    gap_snr_p5,
    hf_from_noise_ratio,
    phrase_ends_from_energy,
    score_pair,
    tail_periodicity,
)

DEFAULT_FILES = {
    "07_edge": "07_real_edge_andrew_1x_same_passage.mp3",
    "09_step150": "09_p2_step150_speed0.85_pace_matched_passage.mp3",
    "03_teacher": "03_old_teacher_passage.mp3",
    "02_stock": "02_cma_free_mean_passage.mp3",
}
BANDS = [(80, 200), (200, 300), (300, 500), (500, 800), (800, 1200), (1200, 1800),
         (1800, 2500), (2500, 3500), (3500, 4500), (4500, 5500), (5500, 6500),
         (6500, 7500), (7500, 8500), (8500, 9500)]


def load(path: str) -> np.ndarray:
    """Decode through ffmpeg rather than an MP3 library: the four samples ship as MP3 and
    libsndfile's MP3 path is not guaranteed present."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav = tmp.name
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-ac", "1",
                        "-ar", str(SAMPLE_RATE), "-c:a", "pcm_f32le", wav], check=True)
        x, _ = librosa.load(wav, sr=SAMPLE_RATE, mono=True)
    finally:
        os.unlink(wav)
    a = np.abs(x)
    nz = np.where(a > 0.005 * a.max())[0]
    return x[nz[0]:nz[-1] + 1].astype(np.float64)


def ltas(x: np.ndarray, n: int = 2048, hop: int = 256) -> tuple[np.ndarray, np.ndarray]:
    """Energy-weighted long-term average spectrum over *all* frames.

    Deliberately mask-free. The gate's `rolloff`/`hi_band`/`ripple` helpers select frames
    by an energy percentile, so a take with more or less silence than the reference gets a
    different subset of frames and the comparison is no longer like-for-like. Silence
    contributes almost no energy, so an unweighted mean over frames is already
    energy-weighted and needs no threshold.
    """
    S = np.abs(librosa.stft(x, n_fft=n, hop_length=hop)) ** 2
    return librosa.fft_frequencies(sr=SAMPLE_RATE, n_fft=n), S.mean(1)


def section(title: str) -> None:
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def table(rows: dict[str, dict[str, float]], fmt: str = "8.3f") -> None:
    keys = list(rows)
    print(f"{'metric':>24} " + " ".join(f"{k:>16}" for k in keys))
    for m in rows[keys[0]]:
        vals = " ".join(f"{rows[k].get(m, float('nan')):>{14}.3f}" for k in keys)
        print(f"{m:>24} {vals}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="directory holding the four sample MP3s")
    ap.add_argument("--out", default="", help="write the JSON summary here")
    ap.add_argument("--pack", default="", help="step00150_voice.pt, for the pack-on-stock ablation")
    ap.add_argument("--passage", default="", help="passage_text.txt, used only for the word count")
    ap.add_argument("--skip-pack", action="store_true")
    args = ap.parse_args()

    X: dict[str, np.ndarray] = {}
    for name, fname in DEFAULT_FILES.items():
        p = os.path.join(args.dir, fname)
        if os.path.exists(p):
            X[name] = load(p)
        else:
            print(f"missing {p}", file=sys.stderr)

    if args.pack and not args.skip_pack:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from pack_on_stock import render  # noqa: E402

        X["pack_on_stock"] = render(args.pack, args.passage)

    ref = X["07_edge"]
    F = {k: Frames(v) for k, v in X.items()}
    out: dict[str, object] = {}
    section("1. Level and dynamic range")
    print(f"{'system':>18} {'rms dBFS':>10} {'peak':>7} {'crest dB':>9} {'gap_snr_p5':>11} {'frac<-30dB':>11}")
    for k, x in X.items():
        rms = 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-12)
        pk = np.abs(x).max()
        f = F[k]
        db = 20 * np.log10(f.rms + 1e-12); db -= db.max()
        print(f"{k:>18} {rms:10.2f} {pk:7.3f} {20 * np.log10(pk / (np.sqrt((x ** 2).mean()) + 1e-12)):9.1f} "
              f"{gap_snr_p5(f):11.1f} {np.mean(db < -30):11.3f}")

    section("2. Voicing: the aperiodic frames are where consonants live")
    print("A frame is aperiodic when its normalised autocorrelation peak is below 0.45.")
    print("Edge puts 99.7% of its 3.5-8 kHz energy on those frames.")
    print(f"\n{'system':>18} {'aperiodic':>10} {'UV preserved':>13} {'HF on noise':>12} {'voiced UV':>10}")
    for k, x in X.items():
        f = F[k]
        path = align(x, ref) if k != "07_edge" else None
        print(f"{k:>18} {f.aperiodic.sum() / max(f.speech.sum(), 1):10.3f} "
              f"{consonant_retention(x, ref, path):13.3f} {hf_from_noise_ratio(f):12.3f} "
              f"{float(np.mean(f.periodicity[f.speech])):10.3f}")

    section("3. Spectral balance, energy-weighted and mask-free")
    L = {k: ltas(v) for k, v in X.items()}
    print(f"{'band Hz':>12} " + " ".join(f"{k:>16}" for k in L))
    for lo, hi in BANDS:
        row = []
        for k, (fr, P) in L.items():
            anch = P[(fr >= 300) & (fr < 3000)].sum() + 1e-20
            row.append(10 * np.log10(P[(fr >= lo) & (fr < hi)].sum() / anch + 1e-20))
        print(f"{lo:5d}-{hi:5d} " + " ".join(f"{v - row[0]:+16.2f}" for v in row))

    section("4. Brightness as the shipped gate defines it, and how stable it is")
    print("roll99 with the frame-percentile swept. A gate whose ordering flips with the")
    print("frame threshold cannot rank candidates.")

    def rolloff(x, pct, pctf):
        S = np.abs(librosa.stft(x, n_fft=2048, hop_length=512)) ** 2
        fr = librosa.fft_frequencies(sr=SAMPLE_RATE, n_fft=2048)
        e = S.sum(0); keep = e > np.percentile(e, pctf)
        Sp = S[:, keep].sum(1); c = np.cumsum(Sp) / Sp.sum()
        return float(fr[np.searchsorted(c, pct)])

    for pctf in (30, 50, 60, 70, 90):
        print(f"  pct {pctf:3d}: " + " ".join(f"{k}={rolloff(v, 0.99, pctf):6.0f}" for k, v in X.items()))

    section("5. The new gate, whole")
    rows = {k: score_pair(v, ref) for k, v in X.items()}
    table(rows)
    out["gate"] = rows

    section("6. Is the 96 kbps source the cause? Controlled re-encode of the reference")
    print("Real Edge (07) re-encoded to 96k and 48k MP3, then compared band by band.")
    print("If the source codec were the limit, this would show the same deficit as 09.")
    for br in (96, 48):
        with tempfile.TemporaryDirectory() as d:
            mp3 = os.path.join(d, "x.mp3")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i",
                            os.path.join(args.dir, DEFAULT_FILES["07_edge"]),
                            "-c:a", "libmp3lame", "-b:a", f"{br}k",
                            "-ar", str(SAMPLE_RATE), "-ac", "1", mp3], check=True)
            y = load(mp3)
        fr, P = ltas(y); fr0, P0 = ltas(ref)
        row = []
        for lo, hi in BANDS:
            a = 10 * np.log10(P[(fr >= lo) & (fr < hi)].sum() / P[(fr >= 300) & (fr < 3000)].sum() + 1e-20)
            b = 10 * np.log10(P0[(fr0 >= lo) & (fr0 < hi)].sum() / P0[(fr0 >= 300) & (fr0 < 3000)].sum() + 1e-20)
            row.append(a - b)
        print(f"  {br}k: worst band change {max(abs(v) for v in row):.2f} dB "
              f"({BANDS[int(np.argmax([abs(v) for v in row]))]})")

    section("7. Phrase endings")
    print("The last 250 ms of each detected phrase.")
    print(f"{'system':>18} {'tail periodicity':>17} {'tail level dB':>14} {'release ms':>11}")
    for k, x in X.items():
        ends = phrase_ends_from_energy(x, 3)
        tail = [x[max(0, int(e * SAMPLE_RATE) - int(0.25 * SAMPLE_RATE)):int(e * SAMPLE_RATE)] for e in ends]
        lv = np.mean([20 * np.log10(np.sqrt((t ** 2).mean()) + 1e-12) for t in tail if len(t)])
        e = librosa.feature.rms(y=x, frame_length=1024, hop_length=256)[0]
        pk = int(np.argmax(e)); tgt = e[pk] * 10 ** (-35 / 20)
        rel = np.where(e[pk:] < tgt)[0]
        print(f"{k:>18} {tail_periodicity(x, ends):17.3f} {lv:14.1f} "
              f"{(rel[0] * 256 / SAMPLE_RATE * 1000 if len(rel) else float('nan')):11.0f}")

    if args.passage and os.path.exists(args.passage):
        section("8. Pace")
        words = len(re.findall(r"[A-Za-z0-9']+", open(args.passage).read()))
        for k, x in X.items():
            print(f"  {k:>18} {words / (len(x) / SAMPLE_RATE):.2f} words/s over the trimmed span")

    if args.out:
        json.dump(out, open(args.out, "w"), indent=1)
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
