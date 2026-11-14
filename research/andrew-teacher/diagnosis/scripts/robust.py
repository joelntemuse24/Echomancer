"""Robustness pass: 5 texts, decoder-only ripple + pace, so no single sentence decides it."""
import sys, os, numpy as np, torch, librosa, soundfile as sf
sys.path.insert(0,'/tmp/work')
from kh import build, voice, phonemes
from decoder_ab import capture
from analyse import SR

TEXTS=[
 "Marley was dead, to begin with. There is no doubt whatever about that.",
 "The register of his burial was signed by the clergyman, the clerk, the undertaker, and the chief mourner.",
 "Scrooge knew he was dead? Of course he did. How could it be otherwise?",
 "Oh! But he was a tight-fisted hand at the grindstone, Scrooge!",
 "The cold within him froze his old features, nipped his pointed nose, shrivelled his cheek, stiffened his gait.",
]
ALL=('bert','bert_encoder','predictor','decoder','text_encoder')
tv=voice('/tmp/andrew-weights/epoch_2nd_00002_voice.pt')

def ripple(x, lo=2000, hi=8000):
    S=np.abs(librosa.stft(x,n_fft=4096,hop_length=1024))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=4096)
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].mean(1); db=10*np.log10(Sp+1e-16)
    k=max(3,int(200/(f[1]-f[0])))
    sm=np.convolve(db,np.ones(k)/k,'same')
    sel=(f>=lo)&(f<=hi)
    return float(np.std(db[sel]-sm[sel]))

decs={}
for src in ['base','s1','s2']:
    m=build(ALL,'base')
    if src!='base':
        ck=torch.load('/tmp/andrew-weights/'+('epoch_1st_00002_kmodel.pth' if src=='s1' else 'epoch_2nd_00002_kmodel.pth'),
                      map_location='cpu',weights_only=True)
        sd=ck['decoder']
        if any(k.startswith('module.') for k in sd): sd={k[7:]:v for k,v in sd.items()}
        m.decoder.load_state_dict(sd, strict=False)
    decs[src]=m

print('Decoder-only, identical predictor+style+durations for every row:')
print(f'{"text":>6} {"frames":>7} {"stock":>7} {"s1":>7} {"s2":>7}   (spectral ripple, dB, 2-8 kHz)')
res={'base':[], 's1':[], 's2':[]}
for i,tx in enumerate(TEXTS):
    ps=phonemes(tx)
    asr,F0,N,refs,pd = capture(build(ALL,'base'), ps, tv)
    line=f'{i:>6} {int(pd.sum()):>7}'
    for src in ['base','s1','s2']:
        torch.manual_seed(0)
        with torch.no_grad():
            a=decs[src].decoder(asr,F0,N,refs[:,:128]).squeeze().numpy()
        r=ripple(a); res[src].append(r); line+=f' {r:7.2f}'
    print(line)
print()
for k,v in res.items():
    print(f'  {k:5s} mean {np.mean(v):.2f} dB   (n={len(v)})')
print(f'\n  stage1/stock ratio = {np.mean(res["s1"])/np.mean(res["base"]):.2f}x')
print(f'  stage2/stock ratio = {np.mean(res["s2"])/np.mean(res["base"]):.2f}x')

# pace across texts
print('\nPace (predicted durations; 600 samples per unit at 24 kHz):')
print(f'{"text":>6} {"stock_ms":>9} {"s1_ms":>8} {"s2_ms":>8}   (audio length)')
for i,tx in enumerate(TEXTS):
    ps=phonemes(tx); row=f'{i:>6}'
    for src in ['base','s1','s2']:
        mm=build(ALL,src)
        _,_,_,_,pd=capture(mm,ps,tv)
        row+=f' {int(pd.sum())*25:>8}'
    print(row)
