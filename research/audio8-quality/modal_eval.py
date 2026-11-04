"""Job 6 - score every take: WER, speaker similarity, and the accept/reject call.

    modal run research/audio8-quality/modal_eval.py
    modal run research/audio8-quality/modal_eval.py --runs baseline,steer,codec,lora

Reads the wavs the other jobs wrote to the Volume and produces one record per
take, then `evalharness.compare` decides pass/fail against the acceptance
targets. Runs on CPU (Whisper small.en int8 + ECAPA), so it is cheap and it can
be re-run as often as wanted while iterating.

Output: `/vol/audio8-quality/eval/metrics.json` -- this is the file to send back.

Cost: 4 texts x 2 refs x 2 seeds x up to 6 variants ~= 100 takes of 12 s audio.
Whisper small.en int8 runs at about 6x realtime on one core here, ECAPA is
instant, so roughly 10 minutes of a 4-core CPU container: about $0.02.
"""

from __future__ import annotations

import json
import os

import modal

from modal_common import REPO_REMOTE, VOLUME_ROOT, eval_image, prepare_run, volume, with_repo

app = modal.App("audio8q-eval")
image = with_repo(eval_image)


@app.function(
    image=image,
    cpu=4,
    memory=16384,
    timeout=5400,
    max_containers=1,
    scaledown_window=5,
    volumes={"/vol": volume},
    env={"ECAPA_DIR": "/models/ecapa"},
)
def run(runs: str = "baseline,steer", whisper: str = "small.en", limit: int = 0):
    import sys

    sys.path.insert(0, REPO_REMOTE)
    from audio8q import jobs

    from modal_common import refs_payload, texts_payload

    roots = []
    for name in [r.strip() for r in runs.split(",") if r.strip()]:
        path = os.path.join(VOLUME_ROOT, name, "wav")
        if os.path.isdir(path):
            roots.append(path)
    if not roots:
        raise RuntimeError(f"no wav directories found for runs {runs!r}")

    refs = refs_payload()
    reference_wav = {
        name: os.path.join(REPO_REMOTE, "refs", entry["wav"]) for name, entry in refs.items()
    }
    metrics = jobs.run_eval(
        wav_roots=roots,
        texts=texts_payload(),
        ref_dir=os.path.join(REPO_REMOTE, "refs"),
        out_dir=prepare_run("eval"),
        reference_wav=reference_wav,
        whisper=whisper,
        limit=limit or None,
    )
    volume.commit()
    return dict(
        takes=metrics["takes"],
        by_variant=metrics["by_variant"],
        comparisons=metrics["comparisons"],
        metrics_path="eval/metrics.json",
    )


@app.local_entrypoint()
def main(runs: str = "baseline,steer", whisper: str = "small.en", limit: int = 0):
    print(json.dumps(run.remote(runs=runs, whisper=whisper, limit=limit), indent=1))
