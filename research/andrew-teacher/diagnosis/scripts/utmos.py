"""UTMOS22 strong-learner scoring of every render (CPU)."""
import sys, os, glob, numpy as np, torch, torchaudio, soundfile as sf
sys.path.insert(0,'/tmp/SpeechMOS')
from speechmos.utmos22.strong.model import UTMOS22Strong

URL='https://github.com/tarepan/SpeechMOS/releases/download/v1.0.0/utmos22_strong_step7459_v1.pt'
_m=None
def model():
    global _m
    if _m is None:
        sd=torch.hub.load_state_dict_from_url(URL, map_location='cpu', progress=False)
        _m=UTMOS22Strong(); _m.load_state_dict(sd); _m.eval()
    return _m

def utmos(path, chunk_s=9.0):
    x,sr = sf.read(path, dtype='float32')
    if x.ndim>1: x=x.mean(1)
    if sr!=16000:
        x=torchaudio.functional.resample(torch.tensor(x), sr, 16000).numpy()
    m=model()
    n=int(chunk_s*16000)
    # score non-overlapping chunks; skip near-silent ones
    scores=[]
    for i in range(0, max(1,len(x)-n+1), n):
        seg=x[i:i+n]
        if len(seg)<n*0.5: continue
        if np.abs(seg).max()<1e-4: continue
        with torch.no_grad():
            s=m(torch.tensor(seg).float().unsqueeze(0), 16000).item()
        scores.append(s)
    if not scores:  # short clip: pad
        seg=np.pad(x,(0,max(0,n-len(x))))
        with torch.no_grad():
            scores=[m(torch.tensor(seg).float().unsqueeze(0),16000).item()]
    return float(np.mean(scores)), len(scores)

if __name__=='__main__':
    items=[('Andrew ref t0070_0','/agent/repos/Echomancer/research/andrew-teacher/samples/andrew_reference_book_clips/t0070_0.wav'),
           ('Andrew ref t0040_0','/agent/repos/Echomancer/research/andrew-teacher/samples/andrew_reference_book_clips/t0040_0.wav'),
           ('Andrew book clip (0.85x)','/agent/repos/Echomancer/research/andrew-teacher/samples/andrew_original_book_clip.mp3'),
           ('stock Kokoro','/tmp/work/fact/1_base_stockvoice.wav'),
           ('stock+teacher voice','/tmp/work/fact/2_base_teachervoice.wav'),
           ('teacher s1','/tmp/work/fact/2_s1_teachervoice.wav'),
           ('teacher s2','/tmp/work/fact/2_s2_teachervoice.wav'),
           ('p_teacher_full (bundle)','/agent/repos/Echomancer/research/andrew-teacher/samples/p_teacher_full.wav'),
           ('p_stock_teacherpack','/agent/repos/Echomancer/research/andrew-teacher/samples/p_stock_teacherpack.wav'),
           ('eval_final','/agent/repos/Echomancer/research/andrew-teacher/samples/eval_final'),
           ('teacher_long','/agent/repos/Echomancer/research/andrew-teacher/samples/teacher_long.wav'),
           ('stock long','/tmp/work/long/stock_long.wav'),
           ('s1 long','/tmp/work/long/s1_long.wav'),
           ('s2 long','/tmp/work/long/s2_long.wav'),
           ('teacher_paragraph','/agent/repos/Echomancer/research/andrew-teacher/samples/teacher_paragraph.wav')]
    print(f'{"name":28s} {"UTMOS":>6} {"nChunks":>8}')
    for n,p in items:
        s,k=utmos(p)
        print(f'{n:28s} {s:6.3f} {k:8d}')
