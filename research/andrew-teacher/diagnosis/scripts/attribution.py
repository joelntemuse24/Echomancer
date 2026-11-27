"""2x2 attribution: {stock, teacher style} x {stock, teacher decoder}.
Decomposes how much of the 'ripple' (audible roughness) is style vs vocoder."""
import sys, os, numpy as np, torch, librosa, soundfile as sf
sys.path.insert(0,'/tmp/work')
from kh import build, voice, phonemes
from decoder_ab import capture
from analyse import SR

TEXT=("In the spring of nineteen thirty-nine, the news from Berlin reached the "
      "physicists in Copenhagen within days. Some of them believed the discovery "
      "would change everything; others thought it was a curiosity of the laboratory, "
      "nothing more. By the end of the year, nobody was laughing.")
ps=phonemes(TEXT)
ALL=('bert','bert_encoder','predictor','decoder','text_encoder')

def ripple(x, lo=2000, hi=8000):
    S=np.abs(librosa.stft(x,n_fft=4096,hop_length=1024))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=4096)
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].mean(1); db=10*np.log10(Sp+1e-16)
    k=max(3,int(200/(f[1]-f[0])))
    sm=np.convolve(db,np.ones(k)/k,'same')
    sel=(f>=lo)&(f<=hi)
    return float(np.std(db[sel]-sm[sel]))

def roll99(x,n_fft=2048):
    S=np.abs(librosa.stft(x,n_fft=n_fft,hop_length=512))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=n_fft)
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].sum(1); c=np.cumsum(Sp)/Sp.sum()
    return float(f[np.searchsorted(c,.99)])

def hnr_praat(x):
    import parselmouth
    s=parselmouth.Sound(x.astype(np.float64),sampling_frequency=SR)
    h=s.to_harmonicity_cc(minimum_pitch=60.0,time_step=0.01)
    v=h.values[h.values>-100]
    return float(np.median(v)) if v.size else float('nan')

stock_v=voice(); teach_v=voice('/tmp/andrew-weights/epoch_2nd_00002_voice.pt')

def make(dec_src):
    m=build(ALL,'base')
    if dec_src!='base':
        ck=torch.load('/tmp/andrew-weights/epoch_2nd_00002_kmodel.pth',map_location='cpu',weights_only=True)
        sd=ck['decoder']
        if any(k.startswith('module.') for k in sd): sd={k[7:]:v for k,v in sd.items()}
        m.decoder.load_state_dict(sd,strict=False)
    return m

print(f'{"style pack":>14} {"decoder":>9} {"ripple":>7} {"roll99":>8} {"HNR":>6} {"dur":>6}')
out={}
for sname,sv in [('stock',stock_v),('teacher',teach_v)]:
    for dname,ds in [('stock','base'),('teacher','s2')]:
        m=make(ds)
        asr,F0,N,refs,pd=capture(m,ps,sv)
        torch.manual_seed(0)
        with torch.no_grad():
            a=m.decoder(asr,F0,N,refs[:,:128]).squeeze().numpy()
        sf.write(f'/tmp/work/attr_{sname}_{dname}.wav',a,SR)
        print(f'{sname:>14} {dname:>9} {ripple(a):7.2f} {roll99(a):8.0f} {hnr_praat(a):6.1f} {len(a)/SR:6.2f}')
        out[(sname,dname)]=ripple(a)
print()
print('Attribution of the increase in ripple over the stock/stock baseline:')
base=out[('stock','stock')]
print(f'  stock style, teacher decoder : +{out[("stock","teacher")]-base:.2f} dB  (vocoder)')
print(f'  teacher style, stock decoder : +{out[("teacher","stock")]-base:.2f} dB  (style vector)')
print(f'  both                         : +{out[("teacher","teacher")]-base:.2f} dB')
