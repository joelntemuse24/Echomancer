"""Consolidated artifact table for the report (all rows measured the same way)."""
import sys, os, json, numpy as np, librosa, torch, soundfile as sf
sys.path.insert(0,'/tmp/work'); sys.path.insert(0,'/tmp/SpeechMOS')
from analyse import load, SR, f0_contour

def ripple(x, lo, hi):
    S=np.abs(librosa.stft(x,n_fft=4096,hop_length=1024))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=4096)
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].mean(1); db=10*np.log10(Sp+1e-16)
    k=max(3,int(200/(f[1]-f[0])))
    sm=np.convolve(db,np.ones(k)/k,'same')
    sel=(f>=lo)&(f<=hi)
    return float(np.std(db[sel]-sm[sel]))

def tail_decay(x, ms=100):
    n=int(ms/1000*SR)
    if len(x)<n*8: return float('nan')
    return float(20*np.log10((np.sqrt((x[-n:]**2).mean())+1e-9)/(np.sqrt((x[-8*n:-n]**2).mean())+1e-9)))

def onset_rise(x):
    env=np.abs(librosa.stft(x,n_fft=512,hop_length=64)).sum(0); env/=env.max()
    d=np.diff(env)
    pk=np.where((d[1:-1]>d[:-2])&(d[1:-1]>d[2:])&(d[1:-1]>0.02))[0]+1
    r=[]
    for i in pk:
        j=max(0,i-40); seg=env[j:i+1]
        if len(seg)<8: continue
        lo,hi=seg.min(),seg[-1]
        if hi-lo<0.05: continue
        try:
            a=np.where(seg>=lo+0.1*(hi-lo))[0][0]; b=np.where(seg>=lo+0.9*(hi-lo))[0][0]
        except IndexError: continue
        r.append((b-a)*64/SR*1000)
    return float(np.median(r)) if r else float('nan')

def spectral_flux_var(x):
    """Frame-to-frame timbre instability (flutter)."""
    S=np.abs(librosa.stft(x,n_fft=1024,hop_length=256))
    e=S.sum(0); keep=e>np.percentile(e,55)
    Sn=S[:,keep]; Sn=Sn/(Sn.sum(0,keepdims=True)+1e-12)
    fl=np.sqrt((np.diff(Sn,axis=1)**2).sum(0))
    return float(np.std(fl)/ (np.mean(fl)+1e-12))

def hf_share(x, cut=6000):
    S=np.abs(librosa.stft(x,n_fft=2048,hop_length=512))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=2048)
    e=S.sum(0); keep=e>np.percentile(e,60)
    return float(100*S[f>=cut][:,keep].sum()/max(S[:,keep].sum(),1e-12))

S='/agent/repos/Echomancer/research/andrew-teacher/samples/'
items=[('Andrew ref (Edge book)','/agent/repos/Echomancer/research/andrew-teacher/samples/andrew_reference_book_clips/t0070_0.wav'),
       ('Andrew ref 2',S+'andrew_reference_book_clips/t0040_0.wav'),
       ('Stock Kokoro','/tmp/work/fact/1_base_stockvoice.wav'),
       ('Stock Kokoro + teacher style','/tmp/work/fact/2_base_teachervoice.wav'),
       ('Teacher stage 1','/tmp/work/fact/2_s1_teachervoice.wav'),
       ('Teacher stage 2','/tmp/work/fact/2_s2_teachervoice.wav'),
       ('Teacher (bundle render)',S+'p_teacher_full.wav'),
       ('Stock dec only, same inputs','/tmp/work/dec2/base.wav'),
       ('S1 dec only, same inputs','/tmp/work/dec2/s1.wav'),
       ('S2 dec only, same inputs','/tmp/work/dec2/s2.wav')]
print(f'{"name":30s} {"ripple2-4k":>10} {"ripple4-8k":>10} {"tail_db":>8} {"rise_ms":>7} {"fluxVar":>7} {"hf%":>6}')
rows=[]
for n,p in items:
    if not os.path.exists(p): print('missing',p); continue
    x=load(p)
    r=dict(name=n, rip24=round(ripple(x,2000,4000),2), rip48=round(ripple(x,4000,8000),2),
           tail=round(tail_decay(x),1), rise=round(onset_rise(x),1),
           flux=round(spectral_flux_var(x),3), hf=round(hf_share(x),3))
    rows.append(r)
    print(f'{n:30s} {r["rip24"]:10.2f} {r["rip48"]:10.2f} {r["tail"]:8.1f} {r["rise"]:7.1f} {r["flux"]:7.3f} {r["hf"]:6.3f}')
json.dump(rows, open('/tmp/work/artifact_table.json','w'), indent=1)
