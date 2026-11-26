#!/usr/bin/env python3
"""Choose one style row for a Kokoro voice pack, and report length drift.

Kokoro selects ``pack[len(phonemes) - 1]``. Stock packs (``am_michael``,
``bm_george``) are almost constant above ~100 phonemes. A fine-tuned pack
is not: Drew's timbre half (the first 128 of the 256-d row, the decoder
half) has cosine 0.78 between rows 150 and 450. A section that Kokoro
splits into a long chunk and a short one then changes voice in the middle.

This script:

* prints timbre and prosody cosine across rows 100..510 against
  ``am_michael`` when that file is available
* renders one fixed passage at candidate rows with the pack pinned so
  every chunk uses that row
* scores speaker likeness with ``score_likeness.ts`` (the repo's
  Resemblyzer encoder) and 2–5 kHz brightness against the references

The winner is the candidate with the highest mean likeness. A candidate
within 0.005 likeness of the leader loses when its brightness is farther
from the first reference. Nothing here changes the Kokoro speed argument.

Weights are private. Pass paths; the script does not fetch them.

  python3 scripts/sowell/choose_fixed_style.py \\
    --pack /path/step00900_voice.pt \\
    --kmodel /path/step00900_kmodel.pth \\
    --text-file paragraph.txt \\
    --reference paragraph.wav --reference edge_paragraph.wav \\
    --speed 1.0 \\
    --out /tmp/style-out
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

import torch

# Repo scripts, so `from engine import ...` works when this file is run
# from anywhere.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import iter_phoneme_runs  # noqa: E402
from style import pin_style  # noqa: E402

# Tensor indices. 509 is the row a 510-phoneme chunk selects
# (pack[len(phonemes) - 1]). There is no index 510.
CANDIDATES = (120, 150, 200, 250, 300, 400, 509)
SAMPLE_RATE = 24_000
# Likeness within this of the leader is a tie, broken by brightness.
LIKENESS_TIE = 0.005


def load_pack(path: Path) -> torch.Tensor:
    pack = torch.load(path, map_location="cpu", weights_only=True)
    if tuple(pack.shape) != (510, 1, 256):
        raise SystemExit(f"{path} shape {tuple(pack.shape)}, want (510, 1, 256)")
    return pack.float()


def cosine(a: torch.Tensor, b: torch.Tensor) -> float:
    return float(torch.nn.functional.cosine_similarity(a, b, dim=0))


def pack_report(name: str, pack: torch.Tensor, baseline: torch.Tensor | None) -> dict:
    flat = pack.reshape(510, 256)
    tim = flat[:, :128]
    pro = flat[:, 128:]
    rows = [120, 150, 200, 250, 300, 400, 450, 509]

    def pair(i: int, j: int) -> dict:
        return {
            "rows": [i, j],
            "timbre": round(cosine(tim[i], tim[j]), 4),
            "prosody": round(cosine(pro[i], pro[j]), 4),
        }

    pairs = [pair(a, b) for a, b in ((150, 450), (120, 509), (100, 509), (200, 400))]
    versus = None
    if baseline is not None:
        base = baseline.reshape(510, 256)
        vals_t = [cosine(tim[i], base[i, :128]) for i in range(99, 510)]
        vals_p = [cosine(pro[i], base[i, 128:]) for i in range(99, 510)]
        versus = {
            "timbreMean": round(sum(vals_t) / len(vals_t), 4),
            "timbreMin": round(min(vals_t), 4),
            "prosodyMean": round(sum(vals_p) / len(vals_p), 4),
            "prosodyMin": round(min(vals_p), 4),
        }
    # Flat enough that pinning would not move a chunk. Stock voices sit here.
    flat_enough = pairs[0]["timbre"] >= 0.99 and pairs[0]["prosody"] >= 0.99
    return {
        "name": name,
        "pairs": pairs,
        "rows": rows,
        "versusAmMichael": versus,
        "flatEnoughToLeaveIndexed": flat_enough,
    }


def write_wav(path: Path, audio: torch.Tensor) -> None:
    pcm = (audio.clamp(-1, 1) * 32767.0).round().to(torch.int16).numpy()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm.tobytes())


def render_pinned(model, pipeline, pack: torch.Tensor, text: str, index: int, speed: float):
    from kokoro import KPipeline

    pinned = pin_style(pack, index)
    _, tokens = pipeline.g2p(text)
    pieces = []
    lengths = []
    started = time.perf_counter()
    with torch.inference_mode():
        for _graphemes, phonemes in iter_phoneme_runs(pipeline, tokens):
            if not phonemes:
                continue
            lengths.append(len(phonemes))
            # Speed is the caller's number, unchanged by the pin.
            output = KPipeline.infer(model, phonemes, pinned, speed)
            pieces.append(
                output.audio.detach().to(dtype=torch.float32, device="cpu").reshape(-1)
            )
    elapsed = time.perf_counter() - started
    if not pieces:
        raise RuntimeError("Kokoro returned no audio")
    return torch.cat(pieces), lengths, elapsed


def band_db(audio: torch.Tensor, lo: float, hi: float) -> float:
    """Mean power in [lo, hi) Hz, in dB, on the 24 kHz render."""
    window = 2048
    if audio.numel() < window:
        return float("-inf")
    spec = torch.stft(
        audio,
        n_fft=window,
        hop_length=window // 2,
        window=torch.hann_window(window),
        return_complex=True,
    )
    power = spec.abs().square().mean(dim=-1)
    freqs = torch.linspace(0, SAMPLE_RATE / 2, power.numel())
    mask = (freqs >= lo) & (freqs < hi)
    value = float(power[mask].mean())
    if value <= 0:
        return float("-inf")
    return 10.0 * torch.log10(torch.tensor(value)).item()


def brightness_db(audio: torch.Tensor) -> float:
    """2–5 kHz level relative to 0.3–2 kHz. Gain cancels."""
    return band_db(audio, 2000, 5000) - band_db(audio, 300, 2000)


def level_lufs(path: Path) -> float:
    result = subprocess.run(
        [
            os.environ.get("FFMPEG_PATH", "ffmpeg"),
            "-hide_banner",
            "-i",
            str(path),
            "-af",
            "ebur128=peak=true",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    text = result.stderr
    marker = "Integrated loudness:"
    start = text.rfind(marker)
    if start < 0:
        raise RuntimeError(f"ebur128 failed for {path}")
    line = next(ln for ln in text[start:].splitlines() if "I:" in ln and "LUFS" in ln)
    return float(line.split("I:")[1].split("LUFS")[0].strip())


def likeness_many(reference: Path, takes: list[Path], repo: Path) -> list[float]:
    """One process for every take, so the encoder loads once per reference."""
    env = os.environ.copy()
    env.setdefault(
        "REFERENCE_QUALITY_MODEL_DIR",
        str(repo / "models" / "reference-quality"),
    )
    cmd = [
        "npx",
        "--yes",
        "tsx",
        str(repo / "scripts" / "sowell" / "score_likeness.ts"),
        str(reference),
        *[str(take) for take in takes],
    ]
    result = subprocess.run(
        cmd, cwd=repo, env=env, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout)
    payload = json.loads(result.stdout)
    by_path = {row["path"]: float(row["cosine"]) for row in payload["takes"]}
    return [by_path[str(take)] for take in takes]


def choose(rows: list[dict]) -> int:
    leader = max(rows, key=lambda row: row["likeness"])
    tied = [
        row
        for row in rows
        if leader["likeness"] - row["likeness"] <= LIKENESS_TIE
    ]
    best = min(
        tied,
        key=lambda row: (abs(row["brightnessDeltaDb"]), -row["likeness"]),
    )
    return int(best["index"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--name", default="voice")
    parser.add_argument("--kmodel", type=Path)
    parser.add_argument("--stock-model", action="store_true")
    parser.add_argument("--text-file", type=Path)
    parser.add_argument("--reference", type=Path, action="append", default=[])
    parser.add_argument("--baseline-pack", type=Path)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--lang", default="a")
    parser.add_argument("--out", type=Path, default=Path("/tmp/style-out"))
    parser.add_argument("--candidates", default=",".join(str(i) for i in CANDIDATES))
    args = parser.parse_args()

    pack = load_pack(args.pack)
    baseline = load_pack(args.baseline_pack) if args.baseline_pack else None
    report = pack_report(args.name, pack, baseline)
    candidates = [int(part) for part in args.candidates.split(",") if part.strip()]
    renders = []

    if args.kmodel or args.stock_model:
        if not args.text_file or not args.reference:
            raise SystemExit("rendering needs --text-file and at least one --reference")
        from kokoro import KModel, KPipeline

        if args.stock_model:
            model = KModel(repo_id="hexgrad/Kokoro-82M").eval()
        else:
            model = KModel(model=str(args.kmodel)).eval()
        pipeline = KPipeline(lang_code=args.lang, repo_id="hexgrad/Kokoro-82M", model=model)
        text = " ".join(args.text_file.read_text(encoding="utf-8").split())
        ref_audio, _ = _read_wav(args.reference[0])
        ref_brightness = brightness_db(ref_audio)
        repo = Path(__file__).resolve().parents[2]
        pending: list[dict] = []
        for index in candidates:
            audio, lengths, elapsed = render_pinned(
                model, pipeline, pack, text, index, args.speed
            )
            wav = args.out / f"{args.name}-style{index}.wav"
            write_wav(wav, audio)
            bright = brightness_db(audio)
            pending.append(
                {
                    "index": index,
                    "phonemeLengths": lengths,
                    "wallSeconds": round(elapsed, 3),
                    "audioSeconds": round(audio.numel() / SAMPLE_RATE, 3),
                    "speed": args.speed,
                    "brightnessDb": round(bright, 3),
                    "brightnessDeltaDb": round(bright - ref_brightness, 3),
                    "lufs": round(level_lufs(wav), 2),
                    "wav": str(wav),
                }
            )
        take_paths = [Path(row["wav"]) for row in pending]
        per_ref = [likeness_many(ref, take_paths, repo) for ref in args.reference]
        for i, row in enumerate(pending):
            scores = [column[i] for column in per_ref]
            row["likeness"] = round(sum(scores) / len(scores), 4)
            row["likenessEach"] = [round(score, 4) for score in scores]
            renders.append(row)
        report["referenceBrightnessDb"] = round(ref_brightness, 3)
        report["chosenIndex"] = choose(renders)
        # Same-row control: pinning the row this text already selects must
        # not change the speed argument. Wall time is the infer clock only.
        natural_len = renders[0]["phonemeLengths"][0] if renders else None
        if natural_len:
            natural_index = min(509, natural_len - 1)
            audio_n, _lengths, elapsed_n = render_pinned(
                model, pipeline, pack, text, natural_index, args.speed
            )
            # A second pass of the identical pinned row. The speed is the
            # same number; the clock should match the first of these two.
            _audio2, _l2, elapsed_2 = render_pinned(
                model, pipeline, pack, text, natural_index, args.speed
            )
            report["sameRowRender"] = {
                "index": natural_index,
                "speed": args.speed,
                "wallSeconds": [round(elapsed_n, 3), round(elapsed_2, 3)],
                "audioSeconds": round(audio_n.numel() / SAMPLE_RATE, 3),
            }
    report["renders"] = renders
    args.out.mkdir(parents=True, exist_ok=True)
    out_json = args.out / f"{args.name}-scores.json"
    out_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


def _read_wav(path: Path) -> tuple[torch.Tensor, int]:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        frames = handle.readframes(handle.getnframes())
        width = handle.getsampwidth()
    if width != 2:
        raise SystemExit(f"{path} is not 16-bit wav")
    audio = torch.frombuffer(bytearray(frames), dtype=torch.int16).float() / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(dim=1)
    if rate != SAMPLE_RATE:
        # Linear resample so the brightness bands share the render rate.
        n = int(round(audio.numel() * SAMPLE_RATE / rate))
        audio = torch.nn.functional.interpolate(
            audio.reshape(1, 1, -1), size=n, mode="linear", align_corners=False
        ).reshape(-1)
    return audio, SAMPLE_RATE


if __name__ == "__main__":
    main()
