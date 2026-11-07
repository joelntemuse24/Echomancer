"""Count (and optionally silence) breaths with Respiro-en (Interspeech 2024).

    python respiro_breaths.py [--thr 0.064] [--min-ms 200] [--silence OUT.wav] a.wav b.wav ...

Prints one JSON line per file: breaths, speech minutes, breaths/min, segments.
Needs RESPIRO_DIR (clone of github.com/ydqmkkx/Respiro-en with respiro-en.pt).
Speech minutes = total duration minus digital/near silence (frames < -60 dBFS),
so joined chunk takes are not credited for the silence we insert.
"""
import argparse, json, os, sys
import numpy as np, librosa, soundfile as sf, torch

RD = os.environ.get("RESPIRO_DIR", "/workspace/Respiro-en")
sys.path.insert(0, RD)
from modules import feature_extractor, DetectionNet  # noqa: E402

_net = None


def net():
    global _net
    if _net is None:
        _net = DetectionNet()
        _net.load_state_dict(torch.load(os.path.join(RD, "respiro-en.pt"), map_location="cpu")["model"])
        _net.eval()
    return _net


def detect(wav16, thr=0.064, min_frames=20):
    """Return list of (start_s, end_s, max_prob) breath segments; 10 ms frames."""
    segs = []
    step = 16000 * 30  # 30 s windows keep the BiLSTM within its training range
    for off in range(0, len(wav16), step):
        w = wav16[off: off + step]
        if len(w) < 16000 * 0.5:
            continue
        feat, length = feature_extractor(w)
        with torch.no_grad():
            p = net()(feat, length)[0].numpy()
        on = p > thr
        i = 0
        while i < len(on):
            if on[i]:
                j = i
                while j < len(on) and on[j]:
                    j += 1
                if j - i > min_frames:
                    segs.append((round(off / 16000 + i / 100, 2), round(off / 16000 + j / 100, 2), round(float(p[i:j].max()), 3)))
                i = j
            else:
                i += 1
    return segs


def speech_minutes(y, sr):
    hop = int(sr * 0.01)
    fr = librosa.util.frame(np.pad(y, (0, hop)), frame_length=hop, hop_length=hop)
    db = 20 * np.log10(np.sqrt((fr ** 2).mean(0)) + 1e-9)
    return float((db > -60).sum()) * 0.01 / 60


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--thr", type=float, default=0.064)
    ap.add_argument("--min-ms", type=int, default=200)
    ap.add_argument("--silence", default=None, help="write first file with breaths zeroed (not cut)")
    a = ap.parse_args()
    for f in a.files:
        y16, _ = librosa.load(f, sr=16000, mono=True)
        segs = detect(y16, a.thr, a.min_ms // 10)
        y, sr = sf.read(f, dtype="float32")
        if y.ndim > 1:
            y = y.mean(1)
        mins = speech_minutes(y, sr)
        print(json.dumps(dict(file=os.path.basename(f), breaths=len(segs), speech_min=round(mins, 3),
                              per_min=round(len(segs) / max(mins, 1e-6), 2), segs=segs)), flush=True)
        if a.silence:
            z = y.copy()
            fade = int(sr * 0.01)
            for s, e, _ in segs:
                s0, e0 = int(s * sr), min(len(z), int(e * sr))
                z[s0:e0] = 0.0
                # 10 ms fades into the zeroed region to avoid clicks
                z[max(0, s0 - fade):s0] *= np.linspace(1, 0, s0 - max(0, s0 - fade))
                z[e0:e0 + fade] *= np.linspace(0, 1, len(z[e0:e0 + fade]))
            sf.write(a.silence, z, sr, subtype="PCM_16")
            a.silence = None


if __name__ == "__main__":
    main()
