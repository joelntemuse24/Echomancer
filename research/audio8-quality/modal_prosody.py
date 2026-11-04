"""Long-form prosody test: whole paragraphs vs flat 150-char chunks vs natural
chunks vs natural chunks + previous-chunk continuation context. Air, clean ref.

    modal run research/audio8-quality/modal_prosody.py

Modal only generates raw per-chunk audio (+ timings). Joining (flat / natural
pauses, fades, loudness match) and all metrics run on the box CPU:
    scripts/prosody_join_eval.py

Variants (generation side):
  A whole    one call per paragraph, sequential (bs=1); plus a batched timing run
  B flat150  rootcause chunker, sequential
  C natural  1-2 sentence chunks <=220 chars, ONE batched call per passage
  D natctx   natural chunks, sequential; reference = clean ref + previous chunk
             (its generated codes + its text) so prosody can carry over. This uses
             the stock prompt format (system: ref text + ref codes) -- no code change.
Refs: copy wolfe_ref15.wav from /workspace/audio8-trial/ref/ into refs/ (not committed).
"""
from __future__ import annotations

import json

import modal

from modal_common import REPO_REMOTE, gpu_image, prepare_run, volume, with_repo

SAMP = dict(temperature=0.8, top_p=0.95, top_k=50)
REF_WAV = "wolfe_ref15.wav"
REF_TEXT = ("And why would the gentleman we're about to surprise be any exception? He's in his apartment, a seven-room "
            "apartment on Riverside Drive on the west side of Manhattan in his study, seated at his desk. As we approach "
            "from the rear, we notice a bald spot on the crown of his head.")

app = modal.App("audio8q-prosody")
image = with_repo(gpu_image)


def max_new(texts):
    return int(min(2048, 80 + 4 * max(len(t) for t in texts)))


@app.function(image=image, gpu=["L4", "A10G"], cpu=4, memory=16384, timeout=3600,
              max_containers=1, scaledown_window=5, volumes={"/vol": volume})
def run(seeds: list[int], variants: list[str], skip: list[str] | None = None):
    import os, sys, time
    import torch
    sys.path.insert(0, REPO_REMOTE)
    from audio8q import jobs, prosody as P
    from modal_common import load_audio8

    proc, model = load_audio8()
    sr = int(model.config.codec_sample_rate)
    out = prepare_run("prosody"); os.makedirs(f"{out}/raw", exist_ok=True)
    ref_codes = jobs.load_ref_codes(model, proc, f"{REPO_REMOTE}/refs", {"wav": REF_WAV, "text": REF_TEXT}, sr)
    log = dict(gpu=torch.cuda.get_device_name(0), sr=sr, takes={}, timing={})

    def gen(texts, seed, refs):
        """Batched generate; refs = list of (codes, text). Returns audios, codes, gpu seconds."""
        torch.manual_seed(seed)
        inp = proc(text=texts, reference_codes=[r[0] for r in refs], reference_text=[r[1] for r in refs], return_tensors="pt")
        inp = {k: v.cuda() for k, v in inp.items()}
        torch.cuda.synchronize(); t0 = time.time()
        with torch.inference_mode():
            o = model.generate(**inp, max_new_tokens=max_new(texts), do_sample=True, return_dict_in_generate=True, **SAMP)
            codes = [o.codes[i, :, : int(o.code_lengths[i])] for i in range(len(texts))]
            auds = [model.decode_audio(c[None])[0][0].float().cpu().numpy() for c in codes]
        torch.cuda.synchronize()
        return auds, [c.cpu() for c in codes], time.time() - t0

    chunkers = dict(whole=P.chunk_whole, flat150=P.chunk_flat150, natural=P.chunk_natural, natctx=P.chunk_natural)
    # warm-up so the first timed call doesn't pay CUDA init
    gen(["Warm up."], 0, [(ref_codes, REF_TEXT)])
    for var in variants:
        for pid, paras in P.PASSAGES.items():
            chunks = chunkers[var](paras)
            texts = [c["text"] for c in chunks]
            for seed in seeds:
                key = f"{var}__{pid}__s{seed}"
                if key in (skip or []):
                    continue
                auds, gpu_s, calls = [None] * len(texts), 0.0, 0
                if var == "natural":  # one batch per passage
                    auds, _, gpu_s = gen(texts, seed, [(ref_codes, REF_TEXT)] * len(texts)); calls = 1
                else:
                    prev = None
                    for k, t in enumerate(texts):
                        ref = (ref_codes, REF_TEXT)
                        if var == "natctx" and prev is not None:
                            ref = (torch.cat([ref_codes, prev[0]], dim=1), REF_TEXT + " " + prev[1])
                        a, c, g = gen([t], seed + k, [ref]); auds[k] = a[0]; gpu_s += g; calls += 1
                        prev = (c[0], t)
                for k, a in enumerate(auds):
                    jobs.save_wav(f"{out}/raw/{key}__c{k:02d}.wav", a, sr)
                adur = sum(len(a) for a in auds) / sr
                log["takes"][key] = dict(chunks=chunks, gpu_s=round(gpu_s, 2), audio_s=round(adur, 2),
                                         audio_per_gpu_s=round(adur / gpu_s, 3), calls=calls)
                print(key, {k: v for k, v in log["takes"][key].items() if k != "chunks"}, flush=True)
                jobs.write_json(f"{out}/takes/{key}.json", log["takes"][key])  # resumable
                volume.commit()
    # throughput-only: batched whole paragraphs and bigger natural batches (both passages together)
    for name, ch in (("whole_batched", P.chunk_whole), ("natural_batched_2passages", P.chunk_natural)):
        texts = [c["text"] for pid, ps in P.PASSAGES.items() for c in ch(ps)]
        auds, _, g = gen(texts, seeds[0], [(ref_codes, REF_TEXT)] * len(texts))
        adur = sum(len(a) for a in auds) / sr
        log["timing"][name] = dict(batch=len(texts), gpu_s=round(g, 2), audio_s=round(adur, 2), audio_per_gpu_s=round(adur / g, 3))
        print(name, log["timing"][name], flush=True)
    jobs.write_json(f"{out}/gen.json", log)
    volume.commit()
    return dict(gpu=log["gpu"], timing=log["timing"],
                takes={k: {a: b for a, b in v.items() if a != "chunks"} for k, v in log["takes"].items()})


@app.local_entrypoint()
def main(seeds: str = "1234,20250101", variants: str = "whole,flat150,natural,natctx", skip: str = ""):
    r = run.remote([int(s) for s in seeds.split(",")], variants.split(","), [k for k in skip.split(",") if k])
    print(json.dumps(r, indent=1))
