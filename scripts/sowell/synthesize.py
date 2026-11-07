"""One short Sowell take on CPU. Refuses a book-length string.

The Kokoro weights are the pinned hexgrad/Kokoro-82M revision. The voice
argument is the checked tensor, never a stock voice name.
"""

from __future__ import annotations

import argparse
import sys
import wave
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pack import PINNED_REPO, PINNED_REVISION, PINNED_WEIGHTS, PackError, check_pack, load_manifest, manifest_path

MAX_CHARS = 280
SAMPLE_RATE = 24_000


def render(text: str, pack: torch.Tensor, out_wav: Path) -> dict:
    cleaned = " ".join(text.split())
    if not cleaned:
        raise PackError("empty text")
    if len(cleaned) > MAX_CHARS:
        raise PackError(f"{len(cleaned)} characters exceeds the {MAX_CHARS} cap")
    from huggingface_hub import hf_hub_download
    from kokoro import KModel, KPipeline

    config = hf_hub_download(
        repo_id=PINNED_REPO,
        filename="config.json",
        revision=PINNED_REVISION,
    )
    weights = hf_hub_download(
        repo_id=PINNED_REPO,
        filename=PINNED_WEIGHTS,
        revision=PINNED_REVISION,
    )
    model = KModel(repo_id=PINNED_REPO, config=config, model=weights)
    pipeline = KPipeline(lang_code="a", repo_id=PINNED_REPO, model=model)
    pieces: list[torch.Tensor] = []
    started = torch.tensor(0.0)
    import time

    t0 = time.perf_counter()
    for result in pipeline(cleaned, voice=pack, speed=1.0):
        audio = getattr(result, "audio", None)
        if audio is None:
            continue
        pieces.append(audio.detach().to(dtype=torch.float32, device="cpu").reshape(-1))
    elapsed = time.perf_counter() - t0
    del started
    if not pieces:
        raise PackError("Kokoro returned no audio")
    audio = torch.cat(pieces)
    if audio.numel() < SAMPLE_RATE // 10 or not bool(torch.isfinite(audio).all()):
        raise PackError("audio is empty or non-finite")
    pcm = (audio.clamp(-1, 1) * 32767.0).round().to(torch.int16).numpy()
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_wav), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm.tobytes())
    return {
        "chars": len(cleaned),
        "samples": int(audio.numel()),
        "seconds": round(audio.numel() / SAMPLE_RATE, 3),
        "wallSeconds": round(elapsed, 3),
        "wav": str(out_wav),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", required=True)
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        manifest = load_manifest(manifest_path(args.manifest))
        pack = check_pack(Path(args.pack), manifest)
        report = render(args.text, pack, Path(args.out))
    except PackError as err:
        print(str(err), file=sys.stderr)
        return 1
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
