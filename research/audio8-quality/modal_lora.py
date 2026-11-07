"""Job 5 - LoRA fine-tune of the slow AR on the breath-free corpus.

    modal run research/audio8-quality/modal_lora.py --steps 600

Only worth running if job 2 (steering) does not reach the targets. Trains a
rank-16 adapter on the slow AR's attention and MLP projections, leaving the fast
AR, the codec and the text embeddings frozen, then evaluates the adapter against
the same four passages and two reference voices.

Output: `/vol/audio8-quality/lora/{metrics.json,lora_state.pt,wav/}`.

Cost: 600 steps of a 0.6B model at ~600 target frames with a rank-16 adapter is
roughly 0.10-0.15 s/step on an L4, so 1-2 minutes of GPU for the training loop,
plus the eval generations and the one-off 30 s of encoding. The 15-minute
container cap includes everything. Expect $0.15-0.40.
"""

from __future__ import annotations

import json

import modal

from modal_common import DEFAULT_GPU, REPO_REMOTE, VOLUME_ROOT, gpu_image, prepare_run, refs_payload, texts_payload, volume, with_repo

app = modal.App("audio8q-lora")
image = with_repo(gpu_image)


@app.function(
    image=image,
    gpu=DEFAULT_GPU,
    cpu=4,
    memory=24576,
    timeout=3600,
    max_containers=1,
    scaledown_window=5,
    volumes={"/vol": volume},
)
def run(
    steps: int = 600,
    rank: int = 16,
    alpha: float = 32.0,
    lr: float = 1e-4,
    max_frames: int = 600,
    dataset: str = "dataset/dataset",
    limit_texts: int | None = None,
    seeds: list[int] | None = None,
):
    import os
    import sys

    sys.path.insert(0, REPO_REMOTE)
    from audio8q import jobs

    from modal_common import load_audio8, ref_dir

    dataset_dir = os.path.join(VOLUME_ROOT, dataset)
    if not os.path.exists(os.path.join(dataset_dir, "manifest.json")):
        raise RuntimeError(f"no dataset at {dataset_dir}; run modal_prep.py first")

    processor, model = load_audio8()
    metrics = jobs.run_lora(
        model,
        processor,
        dataset_dir=dataset_dir,
        texts=texts_payload(limit_texts),
        refs=refs_payload(),
        ref_dir=ref_dir(),
        out_dir=prepare_run("lora"),
        rank=rank,
        alpha=alpha,
        steps=steps,
        lr=lr,
        max_frames=max_frames,
        eval_seeds=seeds or [1234],
        sampling=dict(temperature=0.8, top_p=0.8, top_k=30, max_new_tokens=1024),
    )
    volume.commit()
    return dict(
        gpu=metrics["gpu"],
        lora=metrics["lora"],
        dataset=metrics["dataset"],
        history=metrics["history"][-5:],
        overall=metrics["overall"],
        metrics_path="lora/metrics.json",
    )


@app.local_entrypoint()
def main(steps: int = 600, rank: int = 16, lr: float = 1e-4, max_frames: int = 600, limit_texts: int = 0):
    print(json.dumps(run.remote(steps=steps, rank=rank, lr=lr, max_frames=max_frames,
                               limit_texts=limit_texts or None), indent=1))
