"""Score rootcause takes: Respiro-en breaths/min, Whisper WER, ECAPA speaker sim.

    python rootcause_eval.py WAV_DIR OUT.json

Run with the audio8-trial venv (faster-whisper medium.en via asr.py, jiwer); speaker
sim shells out to the .venv-enh spksim.py (speechbrain ECAPA). Paths via env:
TRIAL_DIR (default /workspace/audio8-trial).
"""
import glob, json, os, subprocess, sys
TRIAL = os.environ.get("TRIAL_DIR", "/workspace/audio8-trial")
sys.path.insert(0, TRIAL); sys.path.insert(0, os.path.dirname(__file__))
import jiwer, asr, respiro_breaths as rb, librosa, soundfile as sf  # noqa
from whisper_normalizer.english import EnglishTextNormalizer
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from audio8q import texts as T

REFS = {"libri": "librispeech-1272.wav", "clean": "wolfe_ref15.wav", "vdhbreathy": "vdh_ref12.wav", "vdhsilenced": "vdh_ref12_respirosil.wav"}
REFDIR = os.path.join(os.path.dirname(__file__), "..", "refs")
n = EnglishTextNormalizer()
wdir, outp = sys.argv[1], sys.argv[2]
rows = json.load(open(outp)) if os.path.exists(outp) else {}
files = sorted(glob.glob(f"{wdir}/*.wav"))
for f in files:
    k = os.path.basename(f)[:-4]
    if k in rows:
        continue
    var, tid, seed = k.split("__")
    y16, _ = librosa.load(f, sr=16000, mono=True)
    segs = rb.detect(y16)
    y, sr = sf.read(f, dtype="float32")
    mins = rb.speech_minutes(y, sr)
    ref_text = T.get(tid)
    h = asr.transcribe(f, expected_words=len(ref_text.split()))
    o = jiwer.process_words(n(ref_text), n(h))
    refkey = next(r for r in REFS if f"_{r}_" in var)
    sim = json.loads(subprocess.run([f"{TRIAL}/.venv-enh/bin/python", "spksim.py", f"{os.path.abspath(os.path.join(REFDIR, REFS[refkey]))}:{f}"],
                                    capture_output=True, text=True, cwd=TRIAL).stdout.strip().splitlines()[-1])["cos"]
    rows[k] = dict(variant=var, text=tid, seed=seed, dur=round(len(y) / sr, 1), speech_min=round(mins, 3), breaths=len(segs),
                   per_min=round(len(segs) / mins, 2), wer=round(o.wer, 4), spk_sim=sim, segs=segs, hyp=h)
    print(json.dumps({a: b for a, b in rows[k].items() if a not in ("segs", "hyp")}), flush=True)
    json.dump(rows, open(outp, "w"), indent=1)
