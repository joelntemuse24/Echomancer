"""Bandwidth / brightness ceiling: what upper frequency does each signal actually carry?"""
import sys, numpy as np, librosa
sys.path.insert(0,'/tmp/work')
from analyse import load, SR

def rolloff(x, pct=0.99, n_fft=2048):
    S=np.abs(librosa.stft(x,n_fft=n_fft,hop_length=512))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=n_fft)
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].sum(1); c=np.cumsum(Sp)/Sp.sum()
    return float(f[np.searchsorted(c,pct)])

def band_table(x, n_fft=2048):
    S=np.abs(librosa.stft(x,n_fft=n_fft,hop_length=512))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=n_fft)
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].sum(1); Sp/=Sp.sum()
    ref=Sp[(f>=100)&(f<300)].sum()
    out={}
    for lo,hi in [(300,1000),(1000,2000),(2000,4000),(4000,6000),(6000,8000),(8000,10000),(10000,12000)]:
        out[f'{lo//1000}-{hi//1000}k']=round(float(10*np.log10(Sp[(f>=lo)&(f<hi)].sum()/ref+1e-12)),1)
    return out

S='/agent/repos/Echomancer/research/andrew-teacher/samples/'
items=[('Andrew ref t0070_0',S+'andrew_reference_book_clips/t0070_0.wav'),
       ('Andrew ref t0040_0',S+'andrew_reference_book_clips/t0040_0.wav'),
       ('Andrew ref t0070_1',S+'andrew_reference_book_clips/t0070_1.wav'),
       ('Andrew book mp3',S+'andrew_original_book_clip.mp3'),
       ('Stock Kokoro (am_michael)','/tmp/work/fact/1_base_stockvoice.wav'),
       ('Stock Kokoro+teacher style','/tmp/work/fact/2_base_teachervoice.wav'),
       ('Teacher stage 1','/tmp/work/fact/2_s1_teachervoice.wav'),
       ('Teacher stage 2','/tmp/work/fact/2_s2_teachervoice.wav'),
       ('Teacher bundle render',S+'p_teacher_full.wav'),
       ('Stock, long render','/tmp/work/long/stock_long.wav'),
       ('Teacher, long render','/tmp/work/long/s2_long.wav')]
first=True
print(f'{"name":28s} {"roll99":>7} '+' '.join(f'{k:>9}' for k in ['0-1k','1-2k','2-4k','4-6k','6-8k','8-10k','10-12k']))
for n,p in items:
    x=load(p); bt=band_table(x)
    print(f'{n:28s} {rolloff(x):7.0f} '+' '.join(f'{bt[k]:9.1f}' for k in bt))
