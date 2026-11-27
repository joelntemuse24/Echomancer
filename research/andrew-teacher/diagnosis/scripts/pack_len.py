"""Kokoro indexes the style pack by phoneme length: pack[len(ps)-1].
The stock pack has 510 *different* rows; the teacher pack has ONE row repeated 510x.
Test what that actually costs: short vs long utterances, proper pack vs flat pack.
"""
import sys, os, numpy as np, torch, soundfile as sf, librosa
sys.path.insert(0,'/tmp/work')
from kh import build, voice, phonemes
from decoder_ab import capture
from analyse import SR, f0_contour

OUT='/tmp/work/pack'; os.makedirs(OUT,exist_ok=True)
V='/home/ubuntu/.cache/huggingface/hub/models--hexgrad--Kokoro-82M/snapshots/f3ff3571791e39611d31c381e3a41a3af07b4987/voices/am_michael.pt'
stock=torch.load(V,map_location='cpu').squeeze(1)       # [510,256]
t2=voice('/tmp/andrew-weights/epoch_2nd_00002_voice.pt').squeeze(1)[0]

texts={
 'short_8ph':'Marley was dead.',
 'short_25ph':'There is no doubt whatever about that.',
 'mid_60ph':"The register of his burial was signed by the clergyman, the clerk, and the undertaker.",
 'long_140ph':("Scrooge and he were partners for I don't know how many years. Scrooge was his sole "
               "executor, his sole administrator, his sole assign, his sole residuary legatee, his sole "
               "friend, and sole mourner."),
}
ALL=('bert','bert_encoder','predictor','decoder','text_encoder')
m=build(ALL,'base')

print(f'{"text":12s} {"len":>4} {"pack":>10} {"dur":>6} {"f0std":>6} {"f0range":>7} {"semis":>6} {"peak":>6}')
for name,tx in texts.items():
    ps=phonemes(tx)
    L=len(ps)
    for ptag, pack in [('proper', stock), ('flat', stock[200:201].repeat(510,1,1)),
                       ('teacher', t2.reshape(1,1,256).repeat(510,1,1))]:
        asr,F0,N,refs,pd=capture(m,ps,pack)
        with torch.no_grad():
            a=m.decoder(asr,F0,N,refs[:,:128]).squeeze().numpy()
        sf.write(f'{OUT}/{name}_{ptag}.wav',a,SR)
        f0=f0_contour(a); v=f0[~np.isnan(f0)]
        rng=np.percentile(v,95)-np.percentile(v,5) if len(v)>5 else float('nan')
        semi=12*np.log2(np.percentile(v,95)/np.percentile(v,5)) if len(v)>5 else float('nan')
        print(f'{name:12s} {L:4d} {ptag:>10} {len(a)/SR:6.2f} {(v.std() if len(v) else float("nan")):6.1f} '
              f'{rng:7.1f} {semi:6.1f} {np.abs(a).max():6.3f}')
    print()
