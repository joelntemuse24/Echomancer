"""Which half of the style vector carries the 'dull' (dark) timbre?
Also: does that darkness come from the training target or from the model?
"""
import sys, os, numpy as np, torch, librosa, soundfile as sf
sys.path.insert(0,'/tmp/work')
from kh import build, voice, phonemes
from decoder_ab import capture
from analyse import load, SR

TEXT=("In the spring of nineteen thirty-nine, the news from Berlin reached the "
      "physicists in Copenhagen within days. Some of them believed the discovery "
      "would change everything; others thought it was a curiosity of the laboratory, "
      "nothing more. By the end of the year, nobody was laughing.")
ps=phonemes(TEXT)
ALL=('bert','bert_encoder','predictor','decoder','text_encoder')

def roll99(x, n_fft=2048):
    S=np.abs(librosa.stft(x,n_fft=n_fft,hop_length=512))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=n_fft)
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].sum(1); c=np.cumsum(Sp)/Sp.sum()
    return float(f[np.searchsorted(c,.99)])

def hf6to8(x, n_fft=2048):
    S=np.abs(librosa.stft(x,n_fft=n_fft,hop_length=512))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=n_fft)
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].sum(1)
    ref=Sp[(f>=100)&(f<300)].sum()
    return float(10*np.log10(Sp[(f>=6000)&(f<8000)].sum()/ref+1e-12))

stock=voice()                                     # [510,1,256]
s=stock.squeeze(1)
t=voice('/tmp/andrew-weights/epoch_2nd_00002_voice.pt').squeeze(1)[0]

variants={
 'stock pack':                       stock,
 'teacher pack (both halves)':       t.reshape(1,1,256).repeat(510,1,1),
 'teacher ACOUSTIC + stock PROSODY': torch.cat([t[:128], s[273,128:]]).reshape(1,1,256).repeat(510,1,1),
 'stock ACOUSTIC + teacher PROSODY': torch.cat([s[273,:128], t[128:]]).reshape(1,1,256).repeat(510,1,1),
}
m=build(ALL,'base')   # stock model: nothing but the style vector changes
print(f'{"style vector":36s} {"roll99 Hz":>10} {"6-8k rel dB":>12}')
for n,p in variants.items():
    asr,F0,N,refs,pd=capture(m,ps,p)
    torch.manual_seed(0)
    with torch.no_grad():
        a=m.decoder(asr,F0,N,refs[:,:128]).squeeze().numpy()
    sf.write(f'/tmp/work/style/{n.replace(" ","_").replace("+","_")}.wav',a,SR)
    print(f'{n:36s} {roll99(a):10.0f} {hf6to8(a):12.1f}')

print()
print(f'{"training target":36s} {"roll99 Hz":>10} {"6-8k rel dB":>12}')
S='/agent/repos/Echomancer/research/andrew-teacher/samples/'
for n,p in [('Andrew reference (training target)',S+'andrew_reference_book_clips/t0070_0.wav'),
            ('Andrew book clip (0.85x)',S+'andrew_original_book_clip.mp3')]:
    x=load(p); print(f'{n:36s} {roll99(x):10.0f} {hf6to8(x):12.1f}')
