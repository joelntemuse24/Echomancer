"""One consistent table: gap haze, harmonicity, pacing, for every controlled render."""
import sys, os, glob, numpy as np, librosa, torch
sys.path.insert(0,'/tmp/work')
from analyse import load, frame_db, SR

N=1024; HOP=256

def metrics(path, nphon=274):
    x=load(path)
    db,_=frame_db(x)
    frames=librosa.util.frame(x,frame_length=N,hop_length=HOP)
    k=min(len(db),frames.shape[1]); db=db[:k]; frames=frames[:,:k]
    rel = db - db.max()
    sp = rel > -30.0           # clearly speech
    gap = rel < -42.0          # clearly not speech
    win=np.hanning(N)[:,None]
    Ssp=np.abs(np.fft.rfft(frames[:,sp]*win,axis=0))**2
    Sgp=np.abs(np.fft.rfft(frames[:,gap]*win,axis=0))**2
    f=np.fft.rfftfreq(N,1/SR)
    lsp=10*np.log10(Ssp.mean(1)+1e-14); lgp=10*np.log10(Sgp.mean(1)+1e-14)
    def band(l,lo,hi): 
        m=(f>=lo)&(f<hi); return l[m].mean()
    def flat(S):
        S=np.maximum(S,1e-14)
        return float(np.exp(np.log(S).mean(0))/np.maximum(S.mean(0),1e-14)).__float__() if False else float(np.median(np.exp(np.log(S).mean(0))/np.maximum(S.mean(0),1e-14)))
    # gap "haze" = gap energy 2-6 kHz relative to gap energy 200-800 Hz
    haze = band(lgp,2000,6000) - band(lgp,200,800)
    # gap vs speech level
    gs = 10*np.log10(Sgp.mean()+1e-16) - 10*np.log10(Ssp.mean()+1e-16)
    speech_s = sp.sum()*HOP/SR
    # spectral tilt in speech
    sel=(f>300)&(f<6000)
    tilt=np.polyfit(np.log10(f[sel]), lsp[sel], 1)[0]
    return dict(dur=len(x)/SR, speech_s=speech_s, pps=nphon/max(speech_s,1e-9),
                gap_rel_db=gs, gap_haze=haze, gap_flat=flat(Sgp), sp_flat=flat(Ssp),
                sp_tilt=tilt, peak=float(np.abs(x).max()),
                n_gap=int(gap.sum()), n_sp=int(sp.sum()))

def table(items, nphon=274, title=''):
    print('\n'+('='*118))
    if title: print(title)
    print(f'{"name":30s} {"dur":>6} {"pps":>6} {"gapRel":>7} {"gapHaze":>8} {"gapFlat":>8} {"spFlat":>7} {"spTilt":>7} {"peak":>6}')
    for name,p in items:
        m=metrics(p,nphon)
        print(f'{name:30s} {m["dur"]:6.2f} {m["pps"]:6.2f} {m["gap_rel_db"]:7.1f} {m["gap_haze"]:8.1f} '
              f'{m["gap_flat"]:8.4f} {m["sp_flat"]:7.4f} {m["sp_tilt"]:7.2f} {m["peak"]:6.3f}')
