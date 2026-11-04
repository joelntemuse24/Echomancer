"""Job 1 - baseline characterisation and the codec causality test.

    modal run research/audio8-quality/modal_baseline.py

Answers, on real generated audio:
  * how many breath candidates / pause "ah"s / inhales the stock model makes per
    passage, for two reference voices and two seeds;
  * how many HF bursts sit in its quiet frames, and whether they are spaced at
    the 46.4 ms codec hop;
  * whether the *decoder* or the *latent it is given* is responsible -- by
    decoding the encoder's own digital-silence latents and the model's pause
    latents and comparing their HF crest.

Output: `/vol/audio8-quality/baseline/metrics.json` plus wavs in `.../wav/`.

Cost: 4 texts x 2 refs x 2 seeds = 16 takes of ~12 s audio. Measured RTF on an
L4 is ~0.30, one take is ~25 s of GPU wall including the codec decode, so under
10 minutes billed -> about $0.13 on an L4.
"""

from __future__ import annotations

import json

import modal

from modal_common import DEFAULT_GPU, REPO_REMOTE, gpu_image, prepare_run, refs_payload, texts_payload, volume, with_repo

app = modal.App("audio8q-baseline")
image = with_repo(gpu_image)


@app.function(
    image=image,
    gpu=DEFAULT_GPU,
    cpu=4,
    memory=16384,
    timeout=2400,
    max_containers=1,
    scaledown_window=5,
    volumes={"/vol": volume},
)
def run(seeds: list[int] | None = None, limit_texts: int | None = None):
    import sys

    sys.path.insert(0, REPO_REMOTE)
    from audio8q import jobs

    from modal_common import load_audio8, ref_dir

    processor, model = load_audio8()
    out = prepare_run("baseline")
    metrics = jobs.run_baseline(
        model,
        processor,
        refs=refs_payload(),
        ref_dir=ref_dir(),
        texts=texts_payload(limit_texts),
        out_dir=out,
        seeds=seeds or [1234, 20250101],
        sampling=dict(temperature=0.8, top_p=0.8, top_k=30, max_new_tokens=1024),
    )
    volume.commit()
    return _brief(metrics)


def _brief(metrics: dict) -> dict:
    """Only what the coordinator needs to read: nothing large."""
    return dict(
        kind=metrics.get("kind"),
        gpu=metrics.get("gpu"),
        overall=metrics.get("overall"),
        by_text=metrics.get("by_text"),
        codec_verdict={k: v.get("verdict") for k, v in (metrics.get("codec_causality") or {}).items()},
        frame_labels=metrics.get("frame_labels"),
        metrics_path=f"baseline/metrics.json",
    )


@app.local_entrypoint()
def main(seeds: str = "", limit_texts: int = 0):
    seed_list = [int(s) for s in seeds.split(",") if s.strip()] or None
    result = run.remote(seeds=seed_list, limit_texts=limit_texts or None)
    print(json.dumps(result, indent=1))
