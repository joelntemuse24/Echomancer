"""Listen-critical extras for the bake-off (box CPU, /workspace/audio8-trial venv).

    python fillers_tails.py RAW_DIR JOINED_WAV_DIR GEN_JSON OUT_JSON

fillers: faster-whisper with a filler-preserving prompt (audio8-trial/fillers.py),
  count uh/um/ah/er/hm tokens on the joined take minus those in the source text
  (e.g. "Oh!"), plus fillers that sit next to a sentence end.
pause_voiced: voiced (pyin) frames > 60 ms inside non-speech gaps of each raw chunk
  between sentences (energy+voicing in pauses; catches 'ah' that ASR drops).
tail: per raw chunk, seconds of non-silent audio (> -50 dBFS) after the last voiced
  frame, and its RMS -> end-of-clip noise / breath (Chatterbox issue #287/#388).
"""
import glob, json, os, re, sys
import numpy as np, soundfile as sf, librosa
TRIAL = os.environ.get("TRIAL_DIR", "/workspace/audio8-trial"); sys.path.insert(0, TRIAL)
import fillers as F  # noqa

FIL = F.FIL


def text_fillers(t):
    return sum(1 for w in re.findall(r"[a-z]+", t.lower()) if FIL.match(w))


def voicing(y, sr):
    y16 = librosa.resample(y, orig_sr=sr, target_sr=16000)
    f0, v, _ = librosa.pyin(y16, fmin=60, fmax=400, sr=16000, frame_length=1024, hop_length=160)
    hop = 160; n = len(v)
    e = np.array([20 * np.log10(np.sqrt(np.mean(y16[i*hop:(i+1)*hop] ** 2)) + 1e-9) for i in range(n)])
    return v, e


def chunk_stats(path):
    y, sr = sf.read(path, dtype="float32")
    v, e = voicing(y, sr)
    vi = np.where(v)[0]
    if len(vi) == 0:
        return dict(tail_s=0, tail_rms_db=None, gap_voiced=0)
    last = vi[-1]; tail = e[last + 1:]
    loud = np.where(tail > -50)[0]
    tail_s = (loud[-1] + 1) * 0.01 if len(loud) else 0.0
    tail_rms = float(10 * np.log10(np.mean(10 ** (tail[: loud[-1] + 1] / 10)))) if len(loud) else None
    # voiced bursts inside gaps: a gap = >=150 ms of frames below -35 dB relative to speech... use unvoiced+low run
    sp = np.percentile(e[v], 50)
    low = e < sp - 20; gv = 0; i = vi[0]
    while i < last:
        if low[i]:
            j = i
            while j < last and (low[j] or (v[j] and e[j] < sp - 12)): j += 1
            if (j - i) >= 15:
                seg = v[i:j] & (e[i:j] > -50); run = 0; best = 0
                for s in seg:
                    run = run + 1 if s else 0; best = max(best, run)
                if best >= 6: gv += 1
            i = j
        else:
            i += 1
    return dict(tail_s=round(float(tail_s), 2), tail_rms_db=None if tail_rms is None else round(tail_rms, 1), gap_voiced=gv)


def main():
    raw, joined, genp, outp = sys.argv[1:5]
    gen = json.load(open(genp)); res = json.load(open(outp)) if os.path.exists(outp) else {}
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "audio8-quality"))
    from audio8q import prosody as P
    for key in gen["takes"]:
        if key in res: continue
        pid = key.split("__")[1]
        ws, hits = F.fillers(f"{joined}/{key}.wav")
        exp = text_fillers(P.clean(" ".join(P.PASSAGES[pid])))
        cs = [chunk_stats(p) for p in sorted(glob.glob(f"{raw}/{key}__c*.wav"))]
        tails = [c["tail_s"] for c in cs]
        res[key] = dict(asr_fillers=max(0, len(hits) - exp), filler_hits=[(h["prev"], h["w"], h["t"]) for h in hits],
                        text_fillers=exp, gap_voiced_bursts=sum(c["gap_voiced"] for c in cs), n_chunks=len(cs),
                        tail_mean_s=round(float(np.mean(tails)), 3), tail_max_s=max(tails),
                        tails_over_150ms=sum(t > 0.15 for t in tails),
                        tail_rms_db_max=max([c["tail_rms_db"] for c in cs if c["tail_rms_db"] is not None], default=None))
        print(key, json.dumps(res[key]), flush=True); json.dump(res, open(outp, "w"), indent=1)


if __name__ == "__main__":
    main()
