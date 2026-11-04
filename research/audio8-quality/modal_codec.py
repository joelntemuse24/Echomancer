"""Job 3 - codec diagnosis, then a short decoder fine-tune.

    modal run research/audio8-quality/modal_codec.py

The ticks were attributed to "the codec decode" in the earlier trial, but that
was never tested against the alternative: that the *latent* the slow AR chose for
the pause is a breathy one, and its HF frication is simply re-excited once per
46.4 ms codec frame. This job separates the two on real audio:

  * `decode_fp32` vs `decode_bf16` -- if the ticks differ, it is precision.
  * `decode_windowed8` -- the codec's post module is a causal window transformer;
    if the artifact moves with the window boundary, it is context.
  * `pause_substitution` -- quiet latents swapped for the encoder's own
    digital-silence latents. If the ticks vanish, the decoder is innocent.

Then, if `--steps` is passed, the decoder's output layers get a short fine-tune
with a reconstruction loss plus a quiet-frame HF penalty, so quiet latents decode
cleanly. That stage saves `decoder_lite.pt` (decoder + post_module only, a few MB).

Output: `/vol/audio8-quality/codec/{metrics.json,decoder_lite.pt,wav/}`.

Cost: 8 generations (~4 minutes of L4) plus, if requested, up to 300 decoder
steps at ~0.35 s/step (~2 minutes). Well under $0.20.
"""

from __future__ import annotations

import json

import modal

from modal_common import DEFAULT_GPU, REPO_REMOTE, gpu_image, prepare_run, refs_payload, texts_payload, volume, with_repo

app = modal.App("audio8q-codec")
image = with_repo(gpu_image)


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
def run(
    steps: int = 0,
    lr: float = 2e-4,
    limit_texts: int | None = None,
    seeds: list[int] | None = None,
):
    import sys

    sys.path.insert(0, REPO_REMOTE)
    from audio8q import jobs

    from modal_common import load_audio8, ref_dir

    processor, model = load_audio8()
    metrics = jobs.run_codec(
        model,
        processor,
        refs=refs_payload(),
        ref_dir=ref_dir(),
        texts=texts_payload(limit_texts),
        out_dir=prepare_run("codec"),
        seeds=seeds or [1234],
        sampling=dict(temperature=0.8, top_p=0.8, top_k=30, max_new_tokens=1024),
        decoder_steps=steps,
        decoder_lr=lr,
    )
    volume.commit()
    return dict(
        gpu=metrics["gpu"],
        by_setting=metrics["by_setting"],
        decoder_fine_tune=metrics.get("decoder_fine_tune"),
        metrics_path="codec/metrics.json",
    )


@app.local_entrypoint()
def main(steps: int = 0, lr: float = 2e-4, limit_texts: int = 0):
    print(json.dumps(run.remote(steps=steps, lr=lr, limit_texts=limit_texts or None), indent=1))
