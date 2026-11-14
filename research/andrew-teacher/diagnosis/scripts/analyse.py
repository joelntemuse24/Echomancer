"""Objective analysis metrics for the Andrew teacher diagnosis.

All measurements are explainable to a non-ML reader: "how noisy is the
recording", "how much does the pitch wobble", "how long are the gaps".
"""
import numpy as np, soundfile as sf, librosa
import parselmouth

SR = 24000

def load(p, sr=SR):
    x, s = sf.read(p, dtype='float32', always_2d=False)
    if x.ndim > 1: x = x.mean(1)
    if s != sr:
        x = librosa.resample(x, orig_sr=s, target_sr=sr)
    return x

def frame_db(x, n=1024, hop=256):
    rms = librosa.feature.rms(y=x, frame_length=n, hop_length=hop)[0]
    return 20*np.log10(np.maximum(rms, 1e-8)), hop

def vad_mask(x, thr_db=-45.0, n=1024, hop=256):
    db,_ = frame_db(x, n, hop)
    return db > thr_db, db

def speech_bounds(x, thr_db=-45.0):
    m,_ = vad_mask(x, thr_db)
    idx = np.where(m)[0]
    if len(idx)==0: return 0, len(x)
    hop=256
    return max(0,idx[0]*hop-128), min(len(x), idx[-1]*hop+128+1024)

def hnr_and_harmonics(x, f0min=60, f0max=400):
    """Harmonics-to-noise ratio (dB) from Praat. Higher = cleaner voice, lower = breathy/rough."""
    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=SR)
    harm = snd.to_harmonicity_cc(minimum_pitch=float(f0min), time_step=0.01,
                                  silence_threshold=0.1, periods_per_window=1.0)
    v = harm.values[harm.values > -100]
    return float(np.median(v)) if v.size else float('nan')

def f0_contour(x, f0min=60, f0max=400):
    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=SR)
    pitch = snd.to_pitch_ac(pitch_floor=f0min, pitch_ceiling=f0max, time_step=0.01)
    f0 = pitch.selected_array['frequency'].copy()
    f0[f0==0] = np.nan
    return f0

def jitter_shimmer(x):
    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=SR)
    try:
        pt = parselmouth.praat.call(snd, "To PointProcess (cc)")
        j = parselmouth.praat.call(pt, "Get jitter (local)", 0.0, 0.0, 0.0001, 0.02, 1.3)
        sh = parselmouth.praat.call([snd, pt], "Get shimmer (local)",
                                    0.0, 0.0, 0.0001, 0.02, 1.3, 1.6)
    except Exception:
        j, sh = float('nan'), float('nan')
    return float(j), float(sh)

def voiced_hnr_frame(x):
    """Frame-wise HNR via autocorrelation peak height: cheap proxy for 'buzz vs breath'."""
    n, hop = 1024, 256
    frames = librosa.util.frame(x, frame_length=n, hop_length=hop).astype(np.float64)
    out=[]
    for fr in frames.T:
        if np.sqrt((fr**2).mean()) < 1e-4: out.append(np.nan); continue
        fr = fr - fr.mean()
        ac = np.correlate(fr, fr, 'full')[n-1:]
        if ac[0] <= 0: out.append(np.nan); continue
        ac = ac/ac[0]
        lo = int(SR/400); hi = min(len(ac)-1, int(SR/60))
        if hi<=lo: out.append(np.nan); continue
        out.append(ac[lo:hi].max())
    return np.array(out)

def spectral_flatness(x):
    S = np.abs(librosa.stft(x, n_fft=1024, hop_length=256))
    f = librosa.feature.spectral_flatness(S=S)[0]
    return float(np.median(f))

def noise_floor_db(x, pct=10):
    db,_ = frame_db(x)
    # quietest frames that still have some energy
    d = db[db > -90]
    if d.size==0: return float('nan')
    return float(np.percentile(d, pct))

def snr_db(x):
    db,_ = frame_db(x)
    sp = np.percentile(db, 90)
    return float(sp - noise_floor_db(x))

def hf_energy_ratio(x, cut=6000):
    S = np.abs(librosa.stft(x, n_fft=1024, hop_length=256))**2
    freqs = librosa.fft_frequencies(sr=SR, n_fft=1024)
    hi = S[freqs>=cut].sum(); tot = S.sum()+1e-12
    return float(hi/tot)

def band_energy(x, lo, hi):
    S = np.abs(librosa.stft(x, n_fft=1024, hop_length=256))**2
    freqs = librosa.fft_frequencies(sr=SR, n_fft=1024)
    m = (freqs>=lo)&(freqs<hi)
    return float(S[m].sum()/(S.sum()+1e-12))

def pause_stats(x, thr_db=-40.0, min_pause=0.15):
    m,_ = vad_mask(x, thr_db)
    hop=256
    # runs of silence
    pauses=[]; i=0; n=len(m)
    while i<n:
        if not m[i]:
            j=i
            while j<n and not m[j]: j+=1
            dur=(j-i)*hop/SR
            if dur>=min_pause: pauses.append(dur)
            i=j
        else: i+=1
    sp = m.sum()*hop/SR
    return {'speech_s': sp, 'pause_count': len(pauses),
            'pause_total_s': float(np.sum(pauses)) if pauses else 0.0,
            'pause_mean_s': float(np.mean(pauses)) if pauses else 0.0,
            'pause_max_s': float(np.max(pauses)) if pauses else 0.0,
            'pauses': pauses}

def onsets(x):
    return librosa.onset.onset_detect(y=x, sr=SR, hop_length=256, backtrack=False)

def speaking_rate(x, phoneme_count=None):
    b0,b1 = speech_bounds(x)
    dur = (b1-b0)/SR
    p = pause_stats(x)
    return {'total_s': len(x)/SR, 'speech_region_s': dur,
            'voiced_ratio': p['speech_s']/max(dur,1e-9),
            'chars_per_s': (phoneme_count/dur) if phoneme_count else None}

def analyse(path, label=None, phoneme_count=None):
    x = load(path)
    j, sh = jitter_shimmer(x)
    f0 = f0_contour(x)
    v = f0[~np.isnan(f0)]
    p = pause_stats(x)
    hnr_frames = voiced_hnr_frame(x)
    out = {
      'label': label or path.split('/')[-1],
      'dur_s': round(len(x)/SR, 2),
      'peak': round(float(np.abs(x).max()), 3),
      'clip_frac': round(float((np.abs(x)>0.999).mean()), 5),
      'dc': round(float(x.mean()), 5),
      'crest_db': round(float(20*np.log10(np.abs(x).max()/(np.sqrt((x**2).mean())+1e-12))), 1),
      'rms_db': round(float(20*np.log10(np.sqrt((x**2).mean())+1e-12)), 1),
      'noise_floor_db': round(noise_floor_db(x),1),
      'snr_db': round(snr_db(x),1),
      'hnr_db': round(hnr_and_harmonics(x), 1),
      'ac_peak_med': round(float(np.nanmedian(hnr_frames)), 3),
      'jitter_pct': round(j*100, 2) if j==j else None,
      'shimmer_pct': round(sh*100, 2) if sh==sh else None,
      'f0_median': round(float(np.median(v)),1) if v.size else None,
      'f0_iqr': round(float(np.percentile(v,75)-np.percentile(v,25)),1) if v.size else None,
      'f0_p5_p95': [round(float(np.percentile(v,5)),1), round(float(np.percentile(v,95)),1)] if v.size else None,
      'f0_std': round(float(v.std()),1) if v.size else None,
      'spectral_flatness': round(spectral_flatness(x),5),
      'hf_ratio_6k': round(hf_energy_ratio(x),5),
      'band_1_4k': round(band_energy(x,1000,4000),4),
      'band_4_8k': round(band_energy(x,4000,8000),4),
      'pauses': {k:v2 for k,v2 in p.items() if k!='pauses'},
      'voiced_ratio': round(p['speech_s']/max((speech_bounds(x)[1]-speech_bounds(x)[0])/SR,1e-9),3),
    }
    if phoneme_count:
        b0,b1=speech_bounds(x)
        out['phonemes_per_s'] = round(phoneme_count/((b1-b0)/SR), 2)
        out['dur_per_phoneme_ms'] = round(1000*(b1-b0)/SR/phoneme_count, 1)
    return out

def report(paths, phoneme_count=None):
    rows=[analyse(p, phoneme_count=phoneme_count) for p in paths]
    keys=['label','dur_s','rms_db','peak','noise_floor_db','snr_db','hnr_db','ac_peak_med',
          'jitter_pct','shimmer_pct','f0_median','f0_iqr','spectral_flatness','hf_ratio_6k',
          'voiced_ratio','phonemes_per_s','dur_per_phoneme_ms','crest_db','clip_frac']
    w=max(len(k) for k in keys)+1
    print(''.join(k.ljust(w) for k in keys))
    for r in rows:
        print(''.join(str(r.get(k,'-')).ljust(w) for k in keys))
    return rows
