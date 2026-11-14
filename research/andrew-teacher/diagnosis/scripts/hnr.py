"""Within-speech harmonic quality: the thing a listener calls "weird quality"."""
import sys, os, glob, numpy as np, librosa, parselmouth
sys.path.insert(0,'/tmp/work')
from analyse import load, SR

def frame_hnr(x, n=1024, hop=256, fmin=60, fmax=400):
    """Autocorrelation-peak HNR per frame, kept only on voiced frames."""
    frames = librosa.util.frame(x, frame_length=n, hop_length=hop).astype(np.float64)
    rms = np.sqrt((frames**2).mean(0))
    keep = rms > max(rms.max()*0.10, 1e-5)
    out=[]
    lo, hi = int(SR/fmax), int(SR/fmin)
    for fr in frames[:, keep].T:
        fr = fr - fr.mean()
        ac = np.correlate(fr, fr, 'full')[n-1:]
        if ac[0] <= 0: continue
        ac = ac/ac[0]
        seg = ac[lo:min(hi,len(ac))]
        if len(seg)<2: continue
        p = seg.max()
        if p <= 0.05 or p >= 0.999: continue
        out.append(10*np.log10(p/(1-p)))     # HNR in dB
    return np.array(out)

def praat_hnr(path):
    x=load(path)
    snd=parselmouth.Sound(x.astype(np.float64), sampling_frequency=SR)
    h=snd.to_harmonicity_cc(minimum_pitch=60.0, time_step=0.01)
    v=h.values[h.values>-100]
    return float(np.median(v)) if v.size else float('nan')

def spectrum_roughness(x, n=1024, hop=256):
    """Frame-to-frame spectral flux variation inside voiced speech: high = 'fluttery'."""
    S=np.abs(librosa.stft(x,n_fft=n,hop_length=hop))
    e=S.sum(0); keep=e>np.percentile(e,55)
    Sn=S[:,keep]
    Sn=Sn/(Sn.sum(0,keepdims=True)+1e-12)
    flux=np.sqrt((np.diff(Sn,axis=1)**2).sum(0))
    return float(np.median(flux))

def harmonic_fuzz(x, n=2048, hop=512):
    """How 'smeared' harmonics are: ratio of energy in harmonic bins vs between them."""
    S=np.abs(librosa.stft(x,n_fft=n,hop_length=hop))**2
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].mean(1)
    f=librosa.fft_frequencies(sr=SR,n_fft=n)
    # use praat F0
    f0 = np.median([v for v in parselmouth.Sound(x.astype(np.float64),sampling_frequency=SR)
                    .to_pitch_ac(pitch_floor=60,pitch_ceiling=400,time_step=0.01)
                    .selected_array['frequency'] if v>0] or [110.0])
    # fractional position of each bin within its harmonic period
    frac = (f/f0) % 1.0
    near = (frac<0.25)|(frac>0.75)
    sel=(f>200)&(f<6000)
    on = 10*np.log10(Sp[sel&near].mean()+1e-16)
    off= 10*np.log10(Sp[sel&~near].mean()+1e-16)
    return float(on-off), float(f0)

def analyse_all(path, nphon=274):
    x=load(path)
    hnr=frame_hnr(x)
    onoff,f0=harmonic_fuzz(x)
    return dict(hnr_med=round(float(np.median(hnr)),1) if len(hnr) else None,
                hnr_p25=round(float(np.percentile(hnr,25)),1) if len(hnr) else None,
                hnr_p10=round(float(np.percentile(hnr,10)),1) if len(hnr) else None,
                praat_hnr=round(praat_hnr(path),1),
                sfm=round(spectrum_roughness(x),4),
                harm_contrast=round(onoff,1), f0=round(f0,1))

if __name__=='__main__':
    items=[('Andrew ref','/agent/repos/Echomancer/research/andrew-teacher/samples/andrew_reference_book_clips/t0070_0.wav'),
           ('Andrew ref 2','/agent/repos/Echomancer/research/andrew-teacher/samples/andrew_original_book_clip.mp3'),
           ('1_base_stockvoice','/tmp/work/fact/1_base_stockvoice.wav'),
           ('1_s1_stockvoice','/tmp/work/fact/1_s1_stockvoice.wav'),
           ('1_s2_stockvoice','/tmp/work/fact/1_s2_stockvoice.wav'),
           ('2_base_teachervoice','/tmp/work/fact/2_base_teachervoice.wav'),
           ('2_s1_teachervoice','/tmp/work/fact/2_s1_teachervoice.wav'),
           ('2_s2_teachervoice','/tmp/work/fact/2_s2_teachervoice.wav'),
           ('p_teacher_full','/agent/repos/Echomancer/research/andrew-teacher/samples/p_teacher_full.wav'),
           ('teacher_long','/agent/repos/Echomancer/research/andrew-teacher/samples/teacher_long.wav'),
           ('p_stock_teacherpack','/agent/repos/Echomancer/research/andrew-teacher/samples/p_stock_teacherpack.wav')]
    print(f'{"name":22s} {"hnr_med":>7} {"hnr_p25":>7} {"hnr_p10":>7} {"praat":>6} {"specflux":>9} {"harmContr":>9} {"f0":>6}')
    for n,p in items:
        r=analyse_all(p)
        print(f'{n:22s} {str(r["hnr_med"]):>7} {str(r["hnr_p25"]):>7} {str(r["hnr_p10"]):>7} '
              f'{str(r["praat_hnr"]):>6} {r["sfm"]:9.4f} {r["harm_contrast"]:9.1f} {r["f0"]:6.1f}')
