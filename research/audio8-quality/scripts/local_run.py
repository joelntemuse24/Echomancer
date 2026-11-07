"""Run any job body locally on CPU, against the real checkpoint.

This is the CPU rehearsal for the Modal scripts: same `audio8q.jobs` functions,
same inputs, same metrics, no GPU and no Modal. It is what makes the GPU runs
work first time, and it is also how the numbers in README.md were produced.

    python scripts/local_run.py baseline --model ~/models/audio8 --short
    python scripts/local_run.py steer    --model ~/models/audio8 --short
    python scripts/local_run.py codec    --model ~/models/audio8 --short
    python scripts/local_run.py lora     --model ~/models/audio8 --short --steps 2
    python scripts/local_run.py eval     --wav out/steer/wav

`--short` uses two texts and one seed, which is a couple of minutes on 4 CPU
threads. Without it the run is the same matrix the GPU job uses (slow on CPU:
roughly 3 minutes of wall per 10 seconds of audio).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def load(model_dir: str, dtype: str = "float32"):
    import torch
    from transformers import AutoModel, AutoProcessor

    torch.set_num_threads(int(os.environ.get("A8Q_THREADS", "4")))
    processor = AutoProcessor.from_pretrained(model_dir, trust_remote_code=True)
    model = AutoModel.from_pretrained(model_dir, trust_remote_code=True, dtype=getattr(torch, dtype)).eval()
    return processor, model


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("job", choices=["baseline", "steer", "codec", "lora", "eval", "prep"])
    parser.add_argument("--model", default=os.environ.get("A8Q_MODEL", "")
                        , help="local checkpoint dir (needs config.json, *.safetensors, codec.pth, tokenizer.json)")
    parser.add_argument("--out", default=str(ROOT / "out"))
    parser.add_argument("--short", action="store_true", help="2 texts, 1 seed")
    parser.add_argument("--seeds", default="1234")
    parser.add_argument("--alphas", default="0,1.0,2.5")
    parser.add_argument("--steps", type=int, default=2)
    parser.add_argument("--wav", default="", help="for the eval job: a directory of wavs")
    parser.add_argument("--dataset", default="", help="for the lora job: a prepared dataset dir")
    parser.add_argument("--librispeech", default=os.environ.get("A8Q_LIBRISPEECH", ""),
                        help="for the prep job: a directory containing LibriSpeech/{dev,test}-clean")
    parser.add_argument("--limit-clips", type=int, default=0)
    args = parser.parse_args()

    from audio8q import jobs, refs, texts

    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]
    alphas = [float(a) for a in args.alphas.split(",") if a.strip()]
    text_map = texts.TEXTS if not args.short else {k: texts.TEXTS[k] for k in texts.text_ids()[:2]}
    text_map = {k: v["text"] for k, v in text_map.items()}
    ref_map = refs.load()
    ref_dir = str(refs.REF_DIR)
    out_dir = Path(args.out) / args.job
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.job == "prep":
        from audio8q import dataprep

        if not args.librispeech:
            print("--librispeech is required for the prep job", file=sys.stderr)
            return 2
        manifest = dataprep.build_dataset(
            args.librispeech, str(out_dir / "dataset"), limit=args.limit_clips or None
        )
        print(json.dumps({k: v for k, v in manifest.items() if k != "clips"}, indent=1))
        return 0

    if args.job == "eval":
        target = args.wav or str(Path(args.out) / "steer" / "wav")
        metrics = jobs.run_eval(
            wav_roots=[target],
            texts=text_map,
            ref_dir=ref_dir,
            out_dir=str(out_dir),
            reference_wav={name: str(refs.REF_DIR / entry["wav"]) for name, entry in ref_map.items()},
        )
        print(json.dumps(metrics["by_variant"], indent=1))
        return 0

    if not args.model:
        print("--model (or A8Q_MODEL) is required", file=sys.stderr)
        return 2
    processor, model = load(args.model)

    if args.job == "baseline":
        metrics = jobs.run_baseline(
            model, processor, refs=ref_map, ref_dir=ref_dir, texts=text_map, out_dir=str(out_dir),
            seeds=seeds, sampling=dict(temperature=0.8, top_p=0.8, top_k=30, max_new_tokens=1024),
        )
        print(json.dumps({"overall": metrics["overall"], "codec": {
            k: v["verdict"] for k, v in metrics["codec_causality"].items()}}, indent=1))
    elif args.job == "steer":
        metrics = jobs.run_steer(
            model, processor, refs=ref_map, ref_dir=ref_dir, texts=text_map, out_dir=str(out_dir),
            alphas=alphas, seeds=seeds, calibration_seeds=seeds,
            calibration_text=texts.get("scandal"),
            sampling=dict(temperature=0.8, top_p=0.8, top_k=30, max_new_tokens=1024),
        )
        print(json.dumps(metrics["by_variant"], indent=1))
    elif args.job == "codec":
        metrics = jobs.run_codec(
            model, processor, refs=ref_map, ref_dir=ref_dir, texts=text_map, out_dir=str(out_dir),
            seeds=seeds, sampling=dict(temperature=0.8, top_p=0.8, top_k=30, max_new_tokens=1024),
        )
        print(json.dumps(metrics["by_setting"], indent=1))
    elif args.job == "lora":
        if not args.dataset:
            print("--dataset is required for the lora job", file=sys.stderr)
            return 2
        metrics = jobs.run_lora(
            model, processor, dataset_dir=args.dataset, texts=text_map, refs=ref_map, ref_dir=ref_dir,
            out_dir=str(out_dir), steps=args.steps, eval_seeds=seeds[:1],
        )
        print(json.dumps({"overall": metrics["overall"], "history": metrics["history"][-3:]}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
