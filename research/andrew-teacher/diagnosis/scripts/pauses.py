"""What exactly is in the pauses? Measure pause-region spectrum directly."""
import sys, numpy as np, librosa
sys.path.insert(0,'/tmp/work')
from analyse import load, SR

def pause_spectrum(path, rel_db=-42.0):
    x=load(path)
    db=20*np.log10(np.maximum(librosa.feature.rms(y=x,frame_length=1024,hop_length=256)[0],1e-9))
    db=db-db.max()
    frames=librosa.util.frame(x,frame_length=1024,hop_length=256)
    k=min(len(db),frames.shape[1]); db=db[:k]; frames=frames[:,:k]
    gap=frames[:, db<rel_db]
    sp=frames[:, db>=rel_db-6]
    if gap.shape[1]<8: return None
    win=np.hanning(1024)[:,None]
    Sg=np.abs(np.fft.rfft(gap*win,axis=0))**2
    Sp=np.abs(np.fft.rfft(sp*win,axis=0))**2
    f=np.fft.rfftfreq(1024,1/SR)
    lg=10*np.log10(Sg.mean(1)+1e-16); lp=10*np.log10(Sp.mean(1)+1e-16)
    # normalise each to its own speech level in 100-300 Hz
    ref=lambda l: l[(f>=100)&(f<300)].mean()
    lg-=ref(lp); lp-=ref(lp)
    bands=[(30,60),(60,90),(90,130),(130,300),(300,800),(800,2000),(2000,4000),(4000,8000)]
    return {f'{a}-{b}':(round(float(lg[(f>=a)&(f<b)].mean()),1),
                        round(float(lp[(f>=a)&(f<b)].mean()),1)) for a,b in bands}, gap.shape[1]

S='/agent/repos/Echomancer/research/andrew-teacher/samples/'
items=[('Andrew ref',S+'andrew_reference_book_clips/t0070_0.wav'),
       ('Stock Kokoro','/tmp/work/fact/1_base_stockvoice.wav'),
       ('Stock+teacher style','/tmp/work/fact/2_base_teachervoice.wav'),
       ('Teacher s1','/tmp/work/fact/2_s1_teachervoice.wav'),
       ('Teacher s2','/tmp/work/fact/2_s2_teachervoice.wav')]
hdr=None
for n,p in items:
    r=pause_spectrum(p)
    if not r: continue
    bands,ng=r
    if hdr is None:
        hdr=list(bands)
        print(f'{"name":22s} {"gaps":>5} ' + ' '.join(f'{h:>13}' for h in hdr))
        print(f'{"":22s} {"":>5} ' + ' '.join(f'{"gap/speech":>13}' for _ in hdr))
    print(f'{n:22s} {ng:5d} ' + ' '.join(f'{bands[h][0]:6.1f}/{bands[h][1]:6.1f}' for h in hdr))
print()
print('cell = dB in the PAUSES / dB in SPEECH, both relative to that file\'s own 100-300 Hz speech level')
