"""Job 4 - build the breath-free fine-tuning corpus on Modal's CPU.

    modal run research/audio8-quality/modal_prep.py

Downloads LibriSpeech dev-clean + test-clean (16 kHz, CC-BY 4.0, 5.4 h, 40+
speakers), removes every breath the detector finds by replacing it with that
clip's own noise floor, loudness-normalises to -20 LUFS, resamples to 44.1 kHz
and writes a manifest with the exact transcripts.

Clipping and editing happen on CPU, which is why this is a CPU function: no GPU
is needed and the whole corpus costs cents.

Output: `/vol/audio8-quality/dataset/{manifest.json,wav/*.wav}`.

Cost: a CPU container (~$0.02/core-hour). Downloading 1.4 GB plus de-breathing
~3,700 clips is 15-25 minutes of one core, so about $0.02.
"""

from __future__ import annotations

import json

import modal

from modal_common import VOLUME_ROOT, cpu_image, prepare_run, volume, with_repo

app = modal.App("audio8q-prep")
image = with_repo(cpu_image)

LIBRISPEECH_MIRRORS = [
    "https://www.openslr.org/resources/12",
    "https://us.openslr.org/resources/12",
]


@app.function(
    image=image,
    cpu=4,
    memory=16384,
    timeout=5400,
    max_containers=1,
    scaledown_window=5,
    volumes={"/vol": volume},
)
def run(limit: int = 0, splits: str = "dev-clean,test-clean"):
    import os
    import subprocess
    import sys
    import tarfile

    sys.path.insert(0, "/work/audio8-quality")
    from audio8q import dataprep

    root = "/data/librispeech"
    os.makedirs(root, exist_ok=True)
    split_list = tuple(s.strip() for s in splits.split(",") if s.strip())

    for split in split_list:
        target = os.path.join(root, "LibriSpeech", split)
        if os.path.isdir(target):
            continue
        archive = os.path.join(root, f"{split}.tar.gz")
        downloaded = False
        for mirror in LIBRISPEECH_MIRRORS:
            try:
                subprocess.run(
                    ["curl", "-sSL", "--fail", "-o", archive, f"{mirror}/{split}.tar.gz"],
                    check=True,
                    timeout=1800,
                )
                downloaded = True
                break
            except Exception as error:  # try the next mirror
                print(f"mirror failed for {split}: {error}", flush=True)
        if not downloaded:
            raise RuntimeError(f"could not download {split} from any mirror")
        with tarfile.open(archive, "r:gz") as handle:
            handle.extractall(root)
        os.remove(archive)

    manifest = dataprep.build_dataset(
        root,
        os.path.join(prepare_run("dataset"), "dataset"),
        limit=limit or None,
        splits=split_list,
    )
    volume.commit()
    return dict(
        clips=len(manifest["clips"]),
        speakers=len(manifest["speakers"]),
        total_seconds=manifest["total_seconds"],
        breaths_removed=manifest["breaths_removed"],
        skipped=manifest["skipped"],
        manifest_path="dataset/dataset/manifest.json",
    )


@app.local_entrypoint()
def main(limit: int = 0, splits: str = "dev-clean,test-clean"):
    print(json.dumps(run.remote(limit=limit, splits=splits), indent=1))
