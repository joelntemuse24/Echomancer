"""VANILLA rerun: raw passage text through each model's own default API, no custom pipeline.

  ming       MingTTS.synthesize(task="TTS", text=<whole passage>) with all defaults
             (its own split_text max_length=24, cfg 2.0, sigma 0.25, temp 0, trim_silence,
             FST text normalization on if pynini imports).
  indextts   IndexTTS2.infer(spk_audio_prompt, text=<whole passage>, lang="EN") with all
             defaults (its own punctuation split, max_text_tokens_per_segment=120,
             interval_silence=200 ms).
  chatterbox ChatterboxTurboTTS.generate(text) with all defaults. Turbo has no internal
             splitting and garbles >~350 chars, so naive split: one call per paragraph,
             concatenated with no added silence.
Passage text = paragraphs joined with "\n" exactly as in audio8q.prosody.PASSAGES.
Seed 20250101. Resumable: one wav per take on the volume, skipped if present.

    modal run --detach modal_vanilla.py --model ming|chatterbox|indextts
"""
import json, os, time
import modal
from modal_tts_alts import ming_img, cb_img, itts_img, volume, REF_TEXT

OUT = "/vol/tts-alts-vanilla"
SEED = 20250101
app = modal.App("tts-alts-vanilla")
KW = dict(gpu="A10G", cpu=4, memory=24576, timeout=1800, max_containers=1, scaledown_window=5, volumes={"/vol": volume})
_src = lambda i: i.add_local_python_source("modal_tts_alts")
ming_img, cb_img, itts_img = _src(ming_img), _src(cb_img), _src(itts_img)
ming_img_v = ming_img  # cached image; pynini absent -> TN off (passages have no numbers/symbols)


def _loop(name, synth, extra):
    import numpy as np, soundfile as sf, torch
    from audio8q import prosody as P
    os.makedirs(OUT, exist_ok=True)
    torch.cuda.reset_peak_memory_stats()
    for pid, paras in P.PASSAGES.items():
        key = f"{name}__{pid}__s{SEED}"
        if os.path.exists(f"{OUT}/{key}.json"):
            print("skip", key); continue
        torch.manual_seed(SEED); torch.cuda.synchronize(); t0 = time.time()
        y, sr, parts = synth(paras)
        torch.cuda.synchronize(); g = time.time() - t0
        sf.write(f"{OUT}/{key}.wav", np.asarray(y, np.float32), sr, subtype="PCM_16")
        rec = dict(sr=sr, gpu_s=round(g, 2), audio_s=round(len(y) / sr, 2), audio_per_gpu_s=round(len(y) / sr / g, 3),
                   peak_vram_gb=round(torch.cuda.max_memory_allocated() / 1e9, 2), gpu=torch.cuda.get_device_name(0),
                   part_ends_s=parts, **extra)
        json.dump(rec, open(f"{OUT}/{key}.json", "w")); volume.commit(); print(key, rec, flush=True)
    return "done"


@app.function(image=ming_img_v, **KW)
def ming():
    import sys
    sys.path.insert(0, "/opt/ming"); os.chdir("/opt/ming")
    from ming_tts import MingTTS
    norm = True
    try:
        from frontend.talker_tn.talker_tn import TalkerTN; TalkerTN()
    except Exception as e:
        print("pynini/TN unavailable, normalization off:", repr(e)[:200]); norm = False
    m = MingTTS("/models/ming", text_normalization=norm)
    m.synthesize(task="TTS", language_id="English", text="Warm up.", prompt_wav_path="/work/ref.wav", prompt_text=REF_TEXT, use_spk_emb=True)

    def synth(paras):
        w = m.synthesize(task="TTS", language_id="English", text="\n".join(paras), prompt_wav_path="/work/ref.wav",
                         prompt_text=REF_TEXT, use_spk_emb=True)
        return w[0].float().cpu().numpy(), m.sample_rate, []
    return _loop("ming", synth, dict(text_normalization=norm, split="model-internal (split_text max_length=24)"))


@app.function(image=cb_img, **KW)
def chatterbox():
    import numpy as np
    os.environ["HF_HOME"] = "/root/.cache/huggingface"
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    m = ChatterboxTurboTTS.from_pretrained(device="cuda")
    m.generate("Warm up.", audio_prompt_path="/work/ref.wav")

    def synth(paras):
        outs, ends, t = [], [], 0
        for p in paras:
            a = m.generate(p, audio_prompt_path="/work/ref.wav")[0].float().cpu().numpy()
            outs.append(a); t += len(a); ends.append(round(t / m.sr, 3))
        return np.concatenate(outs), m.sr, ends
    return _loop("chatterbox", synth, dict(split="naive: one generate() per paragraph, concatenated, no silence"))


@app.function(image=itts_img, **KW)
def indextts():
    import sys, tempfile, soundfile as sf
    os.chdir("/opt/itts"); sys.path.insert(0, "/opt/itts")
    from indextts.infer_v2_5 import IndexTTS2
    m = IndexTTS2(cfg_path="checkpoints/config.yaml", model_dir="checkpoints", use_bf16=True)
    m.infer(spk_audio_prompt="/work/ref.wav", text="Warm up.", lang="EN", output_path="/tmp/w.wav")

    def synth(paras):
        fd, p = tempfile.mkstemp(suffix=".wav"); os.close(fd)
        m.infer(spk_audio_prompt="/work/ref.wav", text="\n".join(paras), lang="EN", output_path=p)
        y, sr = sf.read(p, dtype="float32")
        return (y if y.ndim == 1 else y.mean(1)), sr, []
    return _loop("indextts", synth, dict(split="model-internal (max_text_tokens_per_segment=120, interval_silence=200ms)"))


@app.local_entrypoint()
def main(model: str = "ming"):
    print({"ming": ming, "chatterbox": chatterbox, "indextts": indextts}[model].remote())
