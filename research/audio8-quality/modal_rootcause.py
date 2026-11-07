"""Root-cause grid for excessive breaths: reference x model x chunking.

    modal run research/audio8-quality/modal_rootcause.py

No steering, no token bans, no post-processing. Every take is the raw model output
(chunked takes are joined with exactly 300 ms of digital zeros, nothing else).
Writes /vol/audio8-quality/rootcause/wav/{variant}__{text}__s{seed}.wav plus
rootcause/gen.json (generation seconds, chunk lists). Breaths are counted on the
box CPU afterwards with scripts/respiro_breaths.py.

Refs: wolfe_ref15.wav and vdh_ref12.wav are Echomancer voice clips (not committed);
copy them from /workspace/audio8-trial/ref/ into refs/ first. vdh_ref12_respirosil.wav is
`scripts/respiro_breaths.py refs/vdh_ref12.wav --silence refs/vdh_ref12_respirosil.wav`.
"""
from __future__ import annotations

import json
import re

import modal

from modal_common import REPO_REMOTE, gpu_image, prepare_run, volume, with_repo

PREVIEW_ID = "Edge0/Audio8-TTS-Preview-0.6b"
MODELS = {"air": "/models/air", "prev": "/models/preview"}
AUTHOR = dict(temperature=0.8, top_p=0.95, top_k=50)
OLD = dict(temperature=0.8, top_p=0.8, top_k=30)

REFS = {
    "libri": ("librispeech-1272.wav", "He tells us that at this festive season of the year, with Christmas and roast beef looming before us, similes drawn from eating and its results occur most readily to the mind."),
    "wolfe": ("wolfe_ref15.wav", "And why would the gentleman we're about to surprise be any exception? He's in his apartment, a seven-room apartment on Riverside Drive on the west side of Manhattan in his study, seated at his desk. As we approach from the rear, we notice a bald spot on the crown of his head."),
    "vdh": ("vdh_ref12.wav", "What was our military doing? They were cannibalizing their own ranks. And when General Austin said, we want every aspect of our military to reflect proportionality."),
    "vdhsil": ("vdh_ref12_respirosil.wav", "What was our military doing? They were cannibalizing their own ranks. And when General Austin said, we want every aspect of our military to reflect proportionality."),
}

# variant -> (model, ref, mode, sampling)
GRID = {
    "01_air_libri_whole": ("air", "libri", "whole", AUTHOR),
    "02_air_clean_whole": ("air", "wolfe", "whole", AUTHOR),
    "03_air_clean_chunks": ("air", "wolfe", "chunks", AUTHOR),
    "04_preview_clean_chunks": ("prev", "wolfe", "chunks", AUTHOR),
    "05_air_vdhbreathy_whole": ("air", "vdh", "whole", AUTHOR),
    "06_air_vdhsilenced_whole": ("air", "vdhsil", "whole", AUTHOR),
    "07_preview_clean_whole": ("prev", "wolfe", "whole", AUTHOR),
    "08_air_libri_chunks": ("air", "libri", "chunks", AUTHOR),
    "09_air_clean_whole_old0.8-0.8-30": ("air", "wolfe", "whole", OLD),
    "10_preview_libri_whole": ("prev", "libri", "whole", AUTHOR),
}

app = modal.App("audio8q-rootcause")
image = with_repo(gpu_image.run_commands(f"hf download {PREVIEW_ID} --local-dir /models/preview"))


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def chunk(text: str, limit: int = 150, min_len: int = 40) -> list[str]:
    """One sentence per chunk (<=limit chars, single line). Long sentences split at
    commas; sentences shorter than min_len are merged with the next if it fits."""
    sents = re.split(r"(?<!Mr\.)(?<!Mrs\.)(?<!Dr\.)(?<=[.!?])\s+", clean(text))
    pieces = []
    for s in sents:
        if len(s) <= limit:
            pieces.append(s)
            continue
        cur = ""
        for part in re.split(r"(?<=[,;:])\s+", s):
            if cur and len(cur) + 1 + len(part) > limit:
                pieces.append(cur)
                cur = part
            else:
                cur = f"{cur} {part}".strip()
        pieces.append(cur)
    out = []
    for p in pieces:
        if out and len(out[-1]) < min_len and len(out[-1]) + 1 + len(p) <= limit:
            out[-1] = f"{out[-1]} {p}"
        else:
            out.append(p)
    return [c for c in out if c]


@app.function(image=image, gpu=["L4", "A10G"], cpu=4, memory=16384, timeout=3000,
              max_containers=1, scaledown_window=5, volumes={"/vol": volume})
def run(texts: dict, seeds: list[int], only: list[str] | None = None):
    import os, sys, time
    import numpy as np, torch
    from transformers import AutoModel, AutoProcessor
    sys.path.insert(0, REPO_REMOTE)
    from audio8q import jobs

    out = prepare_run("rootcause")
    os.makedirs(f"{out}/wav", exist_ok=True)
    log = {"gpu": torch.cuda.get_device_name(0), "takes": {}}
    grid = {k: v for k, v in GRID.items() if not only or k in only}
    for mname in ("air", "prev"):
        todo = {k: v for k, v in grid.items() if v[0] == mname}
        if not todo:
            continue
        proc = AutoProcessor.from_pretrained(MODELS[mname], trust_remote_code=True)
        model = AutoModel.from_pretrained(MODELS[mname], trust_remote_code=True, dtype=torch.bfloat16).eval().cuda()
        sr = int(model.config.codec_sample_rate)
        codes = {}
        for var, (_, ref, mode, samp) in todo.items():
            if ref not in codes:
                codes[ref] = jobs.load_ref_codes(model, proc, f"{REPO_REMOTE}/refs", {"wav": REFS[ref][0], "text": REFS[ref][1]}, sr)
            for tid, text in texts.items():
                pieces = [clean(text)] if mode == "whole" else chunk(text)
                for seed in seeds:
                    t0 = time.time(); audio = []
                    for i, p in enumerate(pieces):
                        a, _, _ = jobs.generate(model, proc, p, codes[ref], REFS[ref][1],
                                                dict(samp, seed=seed + i, max_new_tokens=2048 if mode == "whole" else 512))
                        audio.append(a)
                        if i < len(pieces) - 1:
                            audio.append(np.zeros(int(0.3 * sr), dtype=np.float32))
                    y = np.concatenate(audio)
                    jobs.save_wav(f"{out}/wav/{var}__{tid}__s{seed}.wav", y, sr)
                    log["takes"][f"{var}__{tid}__s{seed}"] = dict(gen_s=round(time.time() - t0, 1), dur=round(len(y) / sr, 2), n_chunks=len(pieces))
                    print(var, tid, seed, log["takes"][f"{var}__{tid}__s{seed}"], flush=True)
        del model; torch.cuda.empty_cache()
    log["chunks"] = {t: chunk(x) for t, x in texts.items()}
    jobs.write_json(f"{out}/gen.json", log)
    volume.commit()
    return log


@app.local_entrypoint()
def main(seeds: str = "1234,20250101", only: str = "", texts: str = "looking,bennet"):
    from modal_common import texts_payload
    allt = texts_payload()
    sel = {t: allt[t] for t in texts.split(",")}
    r = run.remote(sel, [int(s) for s in seeds.split(",")], [o for o in only.split(",") if o] or None)
    print(json.dumps({k: v for k, v in r.items() if k != "takes"}, indent=1))
