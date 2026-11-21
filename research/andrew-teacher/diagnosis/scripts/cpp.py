"""Cepstral Peak Prominence (CPP) — the standard objective measure of voice clarity.
Low CPP = breathy/rough/hoarse. Also: HNR within voiced nuclei, F0 micro-perturbation.
"""
import sys, numpy as np, librosa, parselmouth
sys.path.insert(0,'/tmp/work')
from analyse import load, SR, f0_contour

def cpp(x, n_fft=1024, hop=128):
    """Cepstral peak prominence per frame (dB), median over voiced frames."""
    frames = librosa.util.frame(x, frame_length=n_fft, hop_length=hop).astype(np.float64)
    rms = np.sqrt((frames**2).mean(0))
    keep = rms > max(np.percentile(rms,60),1e-6)
    win = np.hanning(n_fft)[:,None]
    out=[]
    quef = np.arange(n_fft)/SR
    lo, hi = int(SR/400), int(SR/60)     # 60..400 Hz
    for fr in frames[:, keep].T:
        spec = np.abs(np.fft.rfft(fr*win[:,0]))
        logspec = np.log(spec+1e-12)
        ceps = np.abs(np.fft.irfft(logspec))
        # regression line through the cepstrum (the "expected" level)
        seg = ceps[lo:hi]
        if seg.size<8: continue
        q = np.argmax(seg)+lo
        # local baseline: linear fit over the quefrency range
        xs = np.arange(lo,hi)
        A = np.polyfit(xs, ceps[lo:hi], 1)
        base = np.polyval(A, q)
        out.append(20*(ceps[q]-base))    # ln -> dB
    return float(np.median(out)) if out else float('nan')

def voiced_hnr_praat(path):
    x=load(path)
    snd=parselmouth.Sound(x.astype(np.float64), sampling_frequency=SR)
    h=snd.to_harmonicity_cc(minimum_pitch=60.0, time_step=0.01)
    v=h.values[h.values>-100]
    return dict(med=round(float(np.median(v)),1),
                p25=round(float(np.percentile(v,25)),1),
                p10=round(float(np.percentile(v,10)),1))

def f0_perturbation(x):
    f0=f0_contour(x)
    v=f0[~np.isnan(f0)]
    if v.size<20: return {}
    d=np.diff(v)
    # micro-perturbation: frame-to-frame change beyond what real intonation does
    return dict(f0_std=round(float(v.std()),1),
                f0_iqr=round(float(np.percentile(v,75)-np.percentile(v,25)),1),
                f0_jump_med=round(float(np.median(np.abs(d))),2),
                f0_jump_p95=round(float(np.percentile(np.abs(d),95)),2),
                f0_reversals=round(float((np.diff(np.sign(d))!=0).mean()),3))

items=[('Andrew ref t0070_0','/agent/repos/Echomancer/research/andrew-teacher/samples/andrew_reference_book_clips/t0070_0.wav'),
       ('Andrew ref t0040_0','/agent/repos/Echomancer/research/andrew-teacher/samples/andrew_reference_book_clips/t0040_0.wav'),
       ('Andrew book clip','/agent/repos/Echomancer/research/andrew-teacher/samples/andrew_original_book_clip.mp3'),
       ('stock Kokoro','/tmp/work/fact/1_base_stockvoice.wav'),
       ('stock+teacher voice','/tmp/work/fact/2_base_teachervoice.wav'),
       ('teacher s1 (full)','/tmp/work/fact/2_s1_teachervoice.wav'),
       ('teacher s2 (full)','/tmp/work/fact/2_s2_teachervoice.wav'),
       ('teacher s2 bundle','/agent/repos/Echomancer/research/andrew-teacher/samples/p_teacher_full.wav'),
       ('teacher_long bundle','/agent/repos/Echomancer/research/andrew-teacher/samples/teacher_long.wav'),
       ('p_stock_teacherpack','/agent/repos/Echomancer/research/andrew-teacher/samples/p_stock_teacherpack.wav')]
print(f'{"name":24s} {"CPP":>6} {"HNRmed":>7} {"HNRp25":>7} {"HNRp10":>7} {"f0std":>6} {"f0iqr":>6} {"jmp95":>6} {"rev":>5}')
for n,p in items:
    x=load(p)
    c=cpp(x); h=voiced_hnr_praat(p); f=f0_perturbation(x)
    print(f'{n:24s} {c:6.1f} {h["med"]:7.1f} {h["p25"]:7.1f} {h["p10"]:7.1f} '
          f'{f.get("f0_std",""):>6} {f.get("f0_iqr",""):>6} {f.get("f0_jump_p95",""):>6} {f.get("f0_reversals",""):>5}')
