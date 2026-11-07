"""Score vanilla takes as-is (no join/trim).  python eval_vanilla.py VOL_DIR OUT_DIR
Same metrics as the tuned run: prosody_join_eval.score (Respiro, WER, ECAPA sim, F0, wpm,
pauses) + fillers_tails (filler-prompted Whisper; voiced bursts in pauses and end tails
computed per model part: paragraph pieces for Chatterbox, the whole file otherwise)."""
import glob, json, os, sys
import numpy as np, soundfile as sf
H = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(H, "..", "audio8-quality", "scripts"), os.path.join(H, "..", "audio8-quality"), H]
import prosody_join_eval as E  # noqa
import fillers_tails as FT  # noqa
from audio8q import prosody as P  # noqa
V, O = sys.argv[1:3]; os.makedirs(O, exist_ok=True)
mp = f"{O}/metrics.json"; res = json.load(open(mp)) if os.path.exists(mp) else {}
for jp in sorted(glob.glob(f"{V}/*__s*.json")):
    key = os.path.basename(jp)[:-5]
    if key in res: continue
    meta = json.load(open(jp)); wav = os.path.abspath(f"{V}/{key}.wav"); pid = key.split("__")[1]
    text = P.clean(" ".join(P.PASSAGES[pid]))
    _, r = E.score((key, wav, [], text))
    ws, hits = FT.F.fillers(wav); exp = FT.text_fillers(text)
    y, sr = sf.read(wav, dtype="float32")
    bounds = [0] + [int(e * sr) for e in meta.get("part_ends_s") or []]
    if bounds[-1] < len(y) - sr // 100: bounds.append(len(y))
    cs = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        tmp = f"/tmp/_part.wav"; sf.write(tmp, y[a:b], sr); cs.append(FT.chunk_stats(tmp))
    tails = [c["tail_s"] for c in cs]
    r.update(asr_fillers=max(0, len(hits) - exp), filler_hits=[(h["prev"], h["w"], h["t"]) for h in hits],
             gap_voiced_bursts=sum(c["gap_voiced"] for c in cs), n_parts=len(cs), tail_max_s=max(tails),
             tails_over_150ms=sum(t > 0.15 for t in tails), **{k: meta[k] for k in ("audio_per_gpu_s", "peak_vram_gb", "gpu", "gpu_s", "audio_s")})
    res[key] = r; print(key, json.dumps({k: v for k, v in r.items() if k != "hyp"}), flush=True)
    json.dump(res, open(mp, "w"), indent=1)
