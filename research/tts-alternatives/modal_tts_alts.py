"""Breath-counter bake-off: Ming-3.0-tts-0.5B vs Chatterbox Turbo vs IndexTTS-2.5.

Same reference (wolfe_ref15.wav + transcript), same passages (Pride & Prejudice +
Walden from audio8q.prosody), same "natural" chunker (1-2 sentences, <=220 chars),
seeds 20250101 and 1234. Modal only generates raw per-chunk wavs; joining and
metrics run on the box CPU with ../audio8-quality/scripts/prosody_join_eval.py
plus fillers_tails.py here.

    modal run --detach modal_tts_alts.py --model ming        # or chatterbox / indextts

Resumable: every chunk wav and every take json goes to the volume at once and is
skipped on rerun. Volume: audio8-trial-vol, folder /vol/tts-alts/. App name
tts-alts-*, never echomancer-s2-clone.
"""
from __future__ import annotations

import json
import os
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
A8Q = os.path.join(HERE, "..", "audio8-quality")
volume = modal.Volume.from_name("audio8-trial-vol")
OUT = "/vol/tts-alts"
SEEDS = [20250101, 1234]
REF_TEXT = ("And why would the gentleman we're about to surprise be any exception? He's in his apartment, a seven-room "
            "apartment on Riverside Drive on the west side of Manhattan in his study, seated at his desk. As we approach "
            "from the rear, we notice a bald spot on the crown of his head.")


def _ship(img):
    return (img.env({"HF_HOME": "/vol/tts-alts/hf", "PYTHONPATH": "/work"})
            .add_local_dir(os.path.join(A8Q, "audio8q"), "/work/audio8q", ignore=["__pycache__"])
            .add_local_file(os.path.join(A8Q, "refs", "wolfe_ref15.wav"), "/work/ref.wav"))


ming_img = _ship(modal.Image.debian_slim(python_version="3.10").apt_install("git", "ffmpeg", "libsndfile1")
                 .run_commands("git clone https://github.com/inclusionAI/Ming-3.0-tts /opt/ming && cd /opt/ming && git rev-parse HEAD")
                 .pip_install("torch==2.6.0", "torchaudio==2.6.0")
                 .run_commands("pip install -r /opt/ming/requirements.txt librosa scipy")
                 .run_commands("hf download inclusionAI/Ming-3.0-tts-0.5B --local-dir /models/ming"))
cb_img = _ship(modal.Image.debian_slim(python_version="3.11").apt_install("git", "ffmpeg", "libsndfile1")
               .run_commands("pip install git+https://github.com/resemble-ai/chatterbox librosa scipy",
                             "python -c \"from huggingface_hub import snapshot_download as s; s('ResembleAI/chatterbox-turbo')\"")
               .env({"HF_HOME": "/root/.cache/huggingface"}))
itts_img = _ship(modal.Image.debian_slim(python_version="3.11").apt_install("git", "ffmpeg", "libsndfile1", "build-essential")
                 .run_commands("git clone --depth 1 https://github.com/index-tts/index-tts /opt/itts")
                 .pip_install("torch==2.8.0", "torchaudio==2.8.0")
                 .run_commands("cd /opt/itts && pip install -e . scipy && pip install -U 'protobuf>=5.29,<7'",
                               "hf download IndexTeam/IndexTTS-2.5 --local-dir /opt/itts/checkpoints"))

app = modal.App("tts-alts")
KW = dict(gpu="A10G", cpu=4, memory=24576, timeout=2400, max_containers=1, scaledown_window=5, volumes={"/vol": volume})


def _loop(name, synth, sr, conc_fn=None):
    """synth(text, seed) -> float32 numpy at sr. Writes raw chunks + take json, resumable."""
    import numpy as np, soundfile as sf, torch
    from audio8q import prosody as P
    os.makedirs(f"{OUT}/raw", exist_ok=True); os.makedirs(f"{OUT}/takes", exist_ok=True)
    synth("Warm up the model, please.", 0)
    torch.cuda.reset_peak_memory_stats()
    for seed in SEEDS:
        for pid, paras in P.PASSAGES.items():
            key = f"{name}__{pid}__s{seed}"
            tj = f"{OUT}/takes/{key}.json"
            if os.path.exists(tj):
                print("skip", key, flush=True); continue
            chunks = P.chunk_natural(paras); gpu_s = 0.0; adur = 0.0
            for k, c in enumerate(chunks):
                wp = f"{OUT}/raw/{key}__c{k:02d}.wav"
                if os.path.exists(wp):
                    adur += sf.info(wp).duration; continue
                torch.cuda.synchronize(); t0 = time.time()
                a = synth(c["text"], seed + k)
                torch.cuda.synchronize(); gpu_s += time.time() - t0
                sf.write(wp, np.asarray(a, np.float32), sr, subtype="PCM_16"); adur += len(a) / sr
                volume.commit()
            rec = dict(chunks=chunks, gpu_s=round(gpu_s, 2), audio_s=round(adur, 2),
                       audio_per_gpu_s=round(adur / max(gpu_s, 1e-6), 3), sr=sr,
                       peak_vram_gb=round(torch.cuda.max_memory_allocated() / 1e9, 2),
                       gpu=torch.cuda.get_device_name(0))
            json.dump(rec, open(tj, "w")); volume.commit()
            print(key, {k: v for k, v in rec.items() if k != "chunks"}, flush=True)
    # concurrency probe: 4 threads on the walden chunks (throughput only, not scored)
    cp = f"{OUT}/takes/{name}__concurrency.json"
    if not os.path.exists(cp):
        from concurrent.futures import ThreadPoolExecutor
        texts = [c["text"] for c in P.chunk_natural(P.PASSAGES["walden"])]
        res = {}
        for n in (1, 4):
            try:
                torch.cuda.synchronize(); t0 = time.time()
                with ThreadPoolExecutor(n) as ex:
                    auds = list(ex.map(lambda t: (conc_fn or synth)(t, 7), texts))
                torch.cuda.synchronize(); g = time.time() - t0
                a = sum(len(x) for x in auds) / sr
                res[f"threads{n}"] = dict(gpu_s=round(g, 2), audio_s=round(a, 2), audio_per_gpu_s=round(a / g, 3))
            except Exception as e:  # noqa
                res[f"threads{n}"] = dict(error=repr(e)[:300])
            print("concurrency", n, res[f"threads{n}"], flush=True)
        res["peak_vram_gb"] = round(torch.cuda.max_memory_allocated() / 1e9, 2)
        json.dump(res, open(cp, "w")); volume.commit()
    return "done"


@app.function(image=ming_img, **KW)
def ming():
    import sys, torch
    sys.path.insert(0, "/opt/ming"); os.chdir("/opt/ming")
    from ming_tts import MingTTS
    m = MingTTS("/models/ming", text_normalization=False)

    def synth(text, seed):
        torch.manual_seed(seed)
        w = m.synthesize(task="TTS", language_id="English", text=text, prompt_wav_path="/work/ref.wav",
                         prompt_text=REF_TEXT, use_spk_emb=True)
        return w[0].float().cpu().numpy()
    return _loop("ming", synth, m.sample_rate)


@app.function(image=cb_img, **KW)
def chatterbox():
    import torch
    os.environ["HF_HOME"] = "/root/.cache/huggingface"
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    m = ChatterboxTurboTTS.from_pretrained(device="cuda")
    m.prepare_conditionals("/work/ref.wav")

    def synth(text, seed):
        torch.manual_seed(seed)
        return m.generate(text)[0].float().cpu().numpy()  # defaults: rep_penalty 1.2, temp 0.8
    return _loop("chatterbox", synth, m.sr)


@app.function(image=itts_img, **KW)
def indextts():
    import sys, tempfile, torch, soundfile as sf
    os.chdir("/opt/itts"); sys.path.insert(0, "/opt/itts")
    from indextts.infer_v2_5 import IndexTTS2
    m = IndexTTS2(cfg_path="checkpoints/config.yaml", model_dir="checkpoints", use_bf16=True)
    sr_box = {}

    def synth(text, seed):
        torch.manual_seed(seed)
        fd, p = tempfile.mkstemp(suffix=".wav"); os.close(fd)
        m.infer(spk_audio_prompt="/work/ref.wav", text=text, lang="EN", output_path=p,
                max_text_tokens_per_segment=70, verbose=False)
        y, sr = sf.read(p, dtype="float32"); os.remove(p); sr_box["sr"] = sr
        return y if y.ndim == 1 else y.mean(1)
    synth("Probe.", 0)
    return _loop("indextts", synth, sr_box["sr"])


@app.local_entrypoint()
def main(model: str = "ming"):
    print({"ming": ming, "chatterbox": chatterbox, "indextts": indextts}[model].remote())
