#!/usr/bin/env python3
"""Render a style pack on *stock* Kokoro-82M weights.

This is the one ablation the checkpoint archive allows. The style pack is 510 rows of
256 floats, indexed by phoneme count: rows[:128] drive the decoder, rows[128:] the
predictor. If the pack alone (on stock weights) already produces the dull, slurred
voice, the fine-tune is innocent. If it produces a clean but wrong-sounding voice, the
predictor/decoder fine-tune is what costs clarity.

    python3 research/andrew_clarity/pack_on_stock.py \\
        --pack ckpt/test2b/step00150_voice.pt --passage passage_text.txt --out /tmp

Needs `kokoro==0.9.4`, `misaki[en]==0.9.4`, espeak-ng and torch. No GPU, no network
beyond the one pinned Hugging Face download. Nothing is written outside --out.
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

WEIGHTS_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"


def render(pack_path: str, passage_path: str, speed: float = 0.85,
           out_dir: str = "", sample_rate: int = 24000) -> np.ndarray:
    """Return mono float32 audio of `passage` read with `pack_path` on stock weights."""
    import soundfile as sf
    import torch
    from huggingface_hub import hf_hub_download
    from kokoro import KModel, KPipeline

    text = open(passage_path, encoding="utf-8").read().strip()
    pack = torch.load(pack_path, map_location="cpu")
    if tuple(pack.shape) != (510, 1, 256):
        raise SystemExit(f"pack shape {tuple(pack.shape)} is not the Kokoro v1.0 contract (510, 1, 256)")

    cfg = hf_hub_download("hexgrad/Kokoro-82M", "config.json", revision=WEIGHTS_REVISION)
    weights = hf_hub_download("hexgrad/Kokoro-82M", "kokoro-v1_0.pth", revision=WEIGHTS_REVISION)
    model = KModel(repo_id="hexgrad/Kokoro-82M", config=cfg, model=weights).eval()
    pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=model)
    torch.manual_seed(0)
    with torch.no_grad():
        audio = np.concatenate([r.audio.cpu().numpy() for r in pipe(text, voice=pack, speed=speed)])

    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "pack_on_stock.wav")
        sf.write(path, audio, sample_rate)
        print(f"wrote {path}  {len(audio) / sample_rate:.2f}s", file=sys.stderr)
    return audio.astype(np.float64)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", required=True)
    ap.add_argument("--passage", required=True)
    ap.add_argument("--speed", type=float, default=0.85)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    a = render(args.pack, args.passage, args.speed, args.out)
    print(f"{len(a) / 24000:.2f}s  peak {np.abs(a).max():.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
