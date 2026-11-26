"""Export Kokoro kmodels and voice packs for the ONNX runtime. Needs torch.

Two callers:

* the image build (`workers/sowell/Dockerfile`) exports the stock
  `kokoro-v1_0.pth` and writes Walter's, George's and Heart's packs;
* `modal run modal/sowell_worker.py::export_drew_onnx` exports Drew's private
  checkpoint from the `andrew-distill` volume into that same volume. Drew's
  weights never enter the image.

The graph is Kokoro 0.9.4's ``KModelForONNX`` (``forward_with_tokens``): one
graph from token ids, a 256-d style row and a speed scalar to the waveform.
``disable_complex=True`` swaps the complex STFT for Kokoro's real-valued
``CustomSTFT`` so the export has no complex tensors. This is the export the
A/B samples were made with (Nov 2026); it does not carry prosody G.

Packs are written as ``.npy`` in their *pinned* form (``style.pin_style``), so
the ONNX process indexes them exactly as ``KPipeline.infer`` indexes the torch
pack, and never needs ``torch.load``.

Every output gets a SHA-256 in ``manifest.json`` next to it; the runtime
refuses a file whose hash does not match.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

OPSET = 17
EXPORT_FORMAT = 1
STOCK_MODEL_FILE = "kokoro-v1_0.onnx"
DREW_MODEL_FILE = "drew.onnx"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def export_kmodel(model_path: str | None, out: Path, style_row) -> None:
    """`model_path=None` is the pinned stock checkpoint."""
    import torch
    from kokoro import KModel
    from kokoro.model import KModelForONNX

    from pack import PINNED_REPO, PINNED_REVISION, PINNED_WEIGHTS

    if model_path is None:
        from huggingface_hub import hf_hub_download

        config = hf_hub_download(repo_id=PINNED_REPO, filename="config.json", revision=PINNED_REVISION)
        model_path = hf_hub_download(repo_id=PINNED_REPO, filename=PINNED_WEIGHTS, revision=PINNED_REVISION)
        kmodel = KModel(repo_id=PINNED_REPO, config=config, model=model_path, disable_complex=True)
    else:
        kmodel = KModel(repo_id=PINNED_REPO, model=model_path, disable_complex=True)
    kmodel = kmodel.eval()
    torch.manual_seed(0)
    ids = torch.randint(1, 100, (1, 60), dtype=torch.long)
    ids[0, 0] = 0
    ids[0, -1] = 0
    style = torch.as_tensor(style_row, dtype=torch.float32).reshape(1, -1)
    kw = dict(
        input_names=["input_ids", "style", "speed"],
        output_names=["waveform", "duration"],
        dynamic_axes={"input_ids": {1: "n"}, "waveform": {0: "t"}, "duration": {0: "n"}},
        opset_version=OPSET,
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    wrapper = KModelForONNX(kmodel).eval()
    with torch.no_grad():
        try:
            torch.onnx.export(wrapper, (ids, style, torch.tensor([1.0])), str(tmp), dynamo=False, **kw)
        except TypeError:  # torch without the `dynamo` argument
            torch.onnx.export(wrapper, (ids, style, torch.tensor([1.0])), str(tmp), **kw)
    os.replace(tmp, out)


def write_pack(pack, index, out: Path) -> None:
    import numpy as np

    from style import pin_style

    pinned = pin_style(pack, index).detach().to("cpu").float().numpy().astype(np.float32)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.save(out, pinned)


def write_manifest(out_dir: Path, files: list[str], extra: dict) -> Path:
    import torch

    manifest = {
        "format": EXPORT_FORMAT,
        "opset": OPSET,
        "torch": str(torch.__version__),
        "files": {name: sha256(out_dir / name) for name in files},
        **extra,
    }
    path = out_dir / "manifest.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=1, sort_keys=True))
    os.replace(tmp, path)
    return path


def export_stock(out_dir: Path, pack_path: Path, manifest_file: Path) -> Path:
    """Stock model + Walter (private pack), George and Heart. Vocab too."""
    from engine import SowellEngine
    from pack import GEORGE_VOICE_ID, HEART_VOICE_ID, SOWELL_VOICE_ID
    from style import fixed_style_index

    engine = SowellEngine()
    engine.load(pack_path, manifest_file)
    raw = {
        SOWELL_VOICE_ID: engine._packs[SOWELL_VOICE_ID],
        GEORGE_VOICE_ID: engine._packs[GEORGE_VOICE_ID],
        HEART_VOICE_ID: engine._packs[HEART_VOICE_ID],
    }
    files = [STOCK_MODEL_FILE]
    # The engine already pinned them; pin_style(None) and a re-pin are no-ops.
    for voice, pack in raw.items():
        write_pack(pack, None, out_dir / f"{voice}.npy")
        files.append(f"{voice}.npy")
    vocab = engine._pipelines["a"].model.vocab
    (out_dir / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False, sort_keys=True))
    files.append("vocab.json")
    export_kmodel(None, out_dir / STOCK_MODEL_FILE, raw[SOWELL_VOICE_ID][0])
    return write_manifest(out_dir, files, {"kind": "stock", "styleIndex": {v: fixed_style_index(v) for v in raw}})


def export_drew(out_dir: Path) -> Path:
    """Drew's checkpoint and pack from the mounted volume."""
    from drew import DREW_FIXED_STYLE_INDEX, check_drew_assets, load_voice_pack

    assets = check_drew_assets()
    pack = load_voice_pack(assets.voice)
    write_pack(pack, DREW_FIXED_STYLE_INDEX, out_dir / "drew.npy")
    export_kmodel(str(assets.kmodel), out_dir / DREW_MODEL_FILE, pack[DREW_FIXED_STYLE_INDEX])
    return write_manifest(
        out_dir,
        [DREW_MODEL_FILE, "drew.npy"],
        {
            "kind": "drew",
            "kmodelSha256": sha256(assets.kmodel),
            "voiceSha256": sha256(assets.voice),
            "styleIndex": DREW_FIXED_STYLE_INDEX,
        },
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("kind", choices=("stock", "drew"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--pack", default=os.environ.get("SOWELL_PACK", "/opt/sowell/voices/am_sowell_avg.pt"))
    parser.add_argument("--manifest", default=os.environ.get("SOWELL_MANIFEST", "/opt/sowell/voices/manifest.json"))
    args = parser.parse_args(argv)
    out = Path(args.out)
    if args.kind == "stock":
        path = export_stock(out, Path(args.pack), Path(args.manifest))
    else:
        path = export_drew(out)
    print(path.read_text())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
