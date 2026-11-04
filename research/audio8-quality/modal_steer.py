"""Job 2 - activation steering sweep.

    modal run research/audio8-quality/modal_steer.py

Learns the "breath direction" in the slow AR's residual stream from contrast
frames, then regenerates the eval set with it projected out (clamped) at several
strengths. Weights are untouched, so the result is one inference flag.

Read `baseline/metrics.json` first: the direction is learned from the model's own
frames, so it needs no baseline run, but the comparison does.

Output: `/vol/audio8-quality/steer/{metrics.json,breath_direction.npy,wav/}`.

Cost: 4 calibration generations + 4 texts x 2 refs x 2 seeds x 5 alphas = 80
takes of ~12 s audio. On an L4 at RTF ~0.30 that is ~10 minutes of billed GPU
time, about $0.14.
"""

from __future__ import annotations

import json

import modal

from modal_common import DEFAULT_GPU, REPO_REMOTE, gpu_image, prepare_run, refs_payload, texts_payload, volume, with_repo

app = modal.App("audio8q-steer")
image = with_repo(gpu_image)

CALIBRATION_TEXT = (
    "She walked to the window and looked out at the rain. The street was empty. "
    "It was very late now, and nobody was coming. He waited."
)


@app.function(
    image=image,
    gpu=DEFAULT_GPU,
    cpu=4,
    memory=16384,
    timeout=3600,
    max_containers=1,
    scaledown_window=5,
    volumes={"/vol": volume},
)
def run(alphas: list[float] | None = None, seeds: list[int] | None = None, limit_texts: int | None = None):
    import sys

    sys.path.insert(0, REPO_REMOTE)
    from audio8q import jobs

    from modal_common import load_audio8, ref_dir

    processor, model = load_audio8()
    metrics = jobs.run_steer(
        model,
        processor,
        refs=refs_payload(),
        ref_dir=ref_dir(),
        texts=texts_payload(limit_texts),
        calibration_text=CALIBRATION_TEXT,
        out_dir=prepare_run("steer"),
        alphas=alphas,
        seeds=seeds or [1234, 20250101],
        calibration_seeds=seeds or [1234, 20250101],
        sampling=dict(temperature=0.8, top_p=0.8, top_k=30, max_new_tokens=1024),
    )
    volume.commit()
    return dict(
        gpu=metrics["gpu"],
        direction=metrics["direction"],
        by_variant=metrics["by_variant"],
        peak_gpu_mb=metrics.get("peak_gpu_mb"),
        metrics_path="steer/metrics.json",
    )


@app.local_entrypoint()
def main(alphas: str = "", seeds: str = "", limit_texts: int = 0):
    requested = [float(a) for a in alphas.split(",") if a.strip()] or None
    seed_list = [int(s) for s in seeds.split(",") if s.strip()] or None
    print(json.dumps(run.remote(alphas=requested, seeds=seed_list, limit_texts=limit_texts or None), indent=1))
