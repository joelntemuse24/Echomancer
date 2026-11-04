"""Join raw per-chunk takes from modal_prosody.py and score them.

    python prosody_join_eval.py RAW_DIR GEN_JSON OUT_DIR

whole/natural/natctx -> audio8q.prosody.join_natural (trim, loudness match, 25 ms
fades, pauses clause 150 / sentence 350 / turn 450 / para 700 ms); flat150 -> 300 ms
flat zeros (the rootcause flow). Metrics: Respiro-en breaths/min, Whisper WER, ECAPA
speaker sim to the ref, F0 std/range (semitones, pyin), words/min, pause stats,
intonation reset (|dF0| across pauses, split into chunk joins vs within-chunk pauses).
Run with the /workspace/audio8-trial venv (TRIAL_DIR).
"""
import glob, json, os, subprocess, sys
import numpy as np, soundfile as sf, librosa

HERE = os.path.dirname(os.path.abspath(__file__))
TRIAL = os.environ.get("TRIAL_DIR", "/workspace/audio8-trial")
sys.path[:0] = [TRIAL, HERE, os.path.join(HERE, "..")]
from audio8q import prosody as P  # noqa
REF = os.path.join(HERE, "..", "refs", "wolfe_ref15.wav")


def f0_track(y, sr):
    y16 = librosa.resample(y, orig_sr=sr, target_sr=16000)
    f0, vflag, _ = librosa.pyin(y16, fmin=60, fmax=400, sr=16000, frame_length=1024, hop_length=160)
    return np.where(vflag, f0, np.nan)  # 10 ms frames


def pauses(y, sr, thr=-45.0, min_s=0.10):
    hop = int(sr * 0.01); n = len(y) // hop
    e = 20 * np.log10(np.sqrt((y[: n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-9)
    sil = e < thr; out = []; i = 0
    while i < n:
        if sil[i]:
            j = i
            while j < n and sil[j]: j += 1
            if (j - i) * 0.01 >= min_s and i > 0 and j < n: out.append((i * 0.01, j * 0.01))
            i = j
        else: i += 1
    return out


def reset(st, a, b, win=0.25):
    pre = st[max(0, int((a - 1.0) * 100)): int(a * 100)]; pre = pre[~np.isnan(pre)][-int(win * 100):]
    post = st[int(b * 100): int((b + 1.0) * 100)]; post = post[~np.isnan(post)][: int(win * 100)]
    if len(pre) < 5 or len(post) < 5: return None
    return float(np.median(post) - np.median(pre))


def score(job):
    key, wav, joins, text = job
    import asr, jiwer, respiro_breaths as rb
    from whisper_normalizer.english import EnglishTextNormalizer
    n = EnglishTextNormalizer()
    y, sr = sf.read(wav, dtype="float32")
    y16 = librosa.resample(y, orig_sr=sr, target_sr=16000)
    segs = rb.detect(y16); mins = rb.speech_minutes(y, sr)
    h = asr.transcribe(wav, expected_words=len(text.split()))
    o = jiwer.process_words(n(text), n(h))
    sim = json.loads(subprocess.run([f"{TRIAL}/.venv-enh/bin/python", "spksim.py", f"{REF}:{wav}"], capture_output=True,
                                    text=True, cwd=TRIAL).stdout.strip().splitlines()[-1])["cos"]
    f0 = f0_track(y, sr); v = f0[~np.isnan(f0)]
    st = 12 * np.log2(f0 / np.nanmedian(f0))
    ps = pauses(y, sr); dur = len(y) / sr
    jr, ir = [], []
    for a, b in ps:
        r = reset(st, a, b)
        if r is None: continue
        (jr if any(a - 0.05 <= j["t"] <= b + 0.05 for j in joins) else ir).append(r)
    pl = np.array([b - a for a, b in ps]) if ps else np.zeros(1)
    return key, dict(dur=round(dur, 1), breaths=len(segs), breaths_per_min=round(len(segs) / mins, 2), wer=round(o.wer, 4),
                     spk_sim=sim, f0_std_st=round(float(np.nanstd(st)), 2),
                     f0_range_st=round(float(np.nanpercentile(st, 95) - np.nanpercentile(st, 5)), 2),
                     f0_median_hz=round(float(np.median(v)), 1), wpm=round(len(text.split()) / (dur / 60), 1),
                     pauses_per_min=round(len(ps) / (dur / 60), 1), pause_med_s=round(float(np.median(pl)), 3),
                     pause_p90_s=round(float(np.percentile(pl, 90)), 3), pause_mean_s=round(float(pl.mean()), 3),
                     reset_join_abs_st=round(float(np.mean(np.abs(jr))), 2) if jr else None, n_join=len(jr),
                     reset_join_signed_st=round(float(np.mean(jr)), 2) if jr else None,
                     reset_internal_abs_st=round(float(np.mean(np.abs(ir))), 2) if ir else None, n_internal=len(ir),
                     hyp=h)


def main():
    raw, genp, outd = sys.argv[1:4]
    gen = json.load(open(genp)); os.makedirs(f"{outd}/wav", exist_ok=True)
    jobs = []
    for key, t in gen["takes"].items():
        var, pid, _ = key.split("__")
        auds = [sf.read(f, dtype="float32")[0] for f in sorted(glob.glob(f"{raw}/{key}__c*.wav"))]
        assert len(auds) == len(t["chunks"]), key
        y, joins = P.join_flat(auds, gen["sr"]) if var == "flat150" else P.join_natural(auds, t["chunks"], gen["sr"])
        wav = f"{outd}/wav/{key}.wav"; sf.write(wav, y, gen["sr"], subtype="PCM_16")
        jobs.append((key, wav, joins, P.clean(" ".join(P.PASSAGES[pid]))))
    mp = f"{outd}/metrics.json"
    res = json.load(open(mp)) if os.path.exists(mp) else {}
    for job in jobs:  # sequential: whisper medium + ECAPA per process OOMs the box when parallel
        if job[0] in res:
            continue
        key, r = score(job)
        res[key] = r; print(key, json.dumps({k: v for k, v in r.items() if k != "hyp"}), flush=True)
        json.dump(res, open(mp, "w"), indent=1)


if __name__ == "__main__":
    main()
