"""Final decisive measurements.

1. Decoder-only spectral ripple: how much the decoder smears the harmonic series.
2. Roughness (30-60 Hz modulation): the physical correlate of "metallic/buzzy".
3. Pace: does the constant style row cause the rushed delivery?
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

def ripple(x, lo=2000, hi=8000):
    """Std-dev of the long-term spectrum about a 200 Hz-smoothed version, in dB.
    High = the harmonic series is irregular / notches are present."""
    S=np.abs(librosa.stft(x,n_fft=4096,hop_length=1024))**2
    f=librosa.fft_frequencies(sr=SR,n_fft=4096)
    e=S.sum(0); keep=e>np.percentile(e,60)
    Sp=S[:,keep].mean(1)
    db=10*np.log10(Sp+1e-16)
    k=int(200/(f[1]-f[0]))
    sm=np.convolve(db,np.ones(k)/k,'same')
    sel=(f>=lo)&(f<=hi)
    return float(np.std(db[sel]-sm[sel]))

def roughness(x, lo=30, hi=70):
    """Energy modulation in the roughness band, relative to the syllable band."""
    rms=librosa.feature.rms(y=x,frame_length=256,hop_length=64)[0]
    rms=rms-rms.mean()
    fps=SR/64
    P=np.abs(np.fft.rfft(rms*np.hanning(len(rms))))**2
    f=np.fft.rfftfreq(len(rms),1/fps)
    a=P[(f>=lo)&(f<=hi)].sum(); b=P[(f>=2)&(f<=6)].sum()
    return float(10*np.log10((a+1e-18)/(b+1e-18)))

print('=== decoder-only: identical inputs, only the vocoder differs ===')
asr,F0,N,refs,pd = capture(build(ALL,'base'), ps, voice('/tmp/andrew-weights/epoch_2nd_00002_voice.pt'))
res={}
for tag,src in [('stock decoder','base'),('stage-1 decoder','s1'),('stage-2 decoder','s2')]:
    m=build(ALL,'base')
    if src!='base':
        ck=torch.load('/tmp/andrew-weights/'+('epoch_1st_00002_kmodel.pth' if src=='s1' else 'epoch_2nd_00002_kmodel.pth'),
                      map_location='cpu',weights_only=True)
        sd=ck['decoder']
        if any(k.startswith('module.') for k in sd): sd={k[7:]:v for k,v in sd.items()}
        m.decoder.load_state_dict(sd, strict=False)
    torch.manual_seed(0)
    with torch.no_grad():
        a=m.decoder(asr,F0,N,refs[:,:128]).squeeze().numpy()
    sf.write(f'/tmp/work/dec2/{src}.wav',a,SR)
    res[tag]=(ripple(a), roughness(a), np.abs(a).max())
    print(f'  {tag:16s} spectral ripple={ripple(a):5.2f} dB   roughness={roughness(a):6.1f} dB   peak={np.abs(a).max():.3f}')

S='/agent/repos/Echomancer/research/andrew-teacher/samples/'
print('\n=== reference points ===')
for n,p in [('Andrew ref t0070_0',S+'andrew_reference_book_clips/t0070_0.wav'),
            ('stock full model','/tmp/work/fact/1_base_stockvoice.wav'),
            ('teacher full (s2)','/tmp/work/fact/2_s2_teachervoice.wav')]:
    x=load(p); print(f'  {n:20s} spectral ripple={ripple(x):5.2f} dB   roughness={roughness(x):6.1f} dB')

# ── pace vs style-pack shape ─────────────────────────────────────────────
print('\n=== does the flat style row cause the rushed delivery? ===')
stock=voice().squeeze(1)
t2row=voice('/tmp/andrew-weights/epoch_2nd_00002_voice.pt').squeeze(1)[0]
shape=(stock-stock.mean(0,keepdim=True))
teach_shaped=(t2row.reshape(1,256)+shape).unsqueeze(1)     # teacher timbre, stock length-shape
m2=build(ALL,'s2')
for tag,pack in [('teacher pack (constant row)', voice('/tmp/andrew-weights/epoch_2nd_00002_voice.pt')),
                 ('teacher timbre + real length shape', teach_shaped),
                 ('stock pack', voice())]:
    asr,F0,N,refs,pd=capture(m2,ps,pack)
    print(f'  {tag:34s} predicted frames={int(pd.sum()):4d}  ({int(pd.sum())*25/1000:5.2f} s)')
