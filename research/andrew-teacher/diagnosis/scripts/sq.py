"""Reference-free signal-quality scores: SQUIM (STOI/PESQ/SI-SDR) + DNSMOS.
These *do* see encoder artifacts, unlike UTMOS."""
import sys, numpy as np, torch, torchaudio, soundfile as sf

_b=None
def sq(path, chunk_s=10.0):
    global _b
    if _b is None:
        _b=torchaudio.pipelines.SQUIM_OBJECTIVE.get_model(); _b.eval()
    x,sr=sf.read(path,dtype='float32')
    if x.ndim>1: x=x.mean(1)
    if sr!=16000: x=torchaudio.functional.resample(torch.tensor(x),sr,16000).numpy()
    n=int(chunk_s*16000); out=[]
    for i in range(0,max(1,len(x)-n+1),n):
        seg=x[i:i+n]
        if len(seg)<n//2 or np.abs(seg).max()<1e-4: continue
        with torch.no_grad():
            p,s,d=_b(torch.tensor(seg).unsqueeze(0))
        out.append((p.item(),s.item(),d.item()))
    if not out:
        seg=np.pad(x,(0,max(0,n-len(x))))
        with torch.no_grad():
            p,s,d=_b(torch.tensor(seg).unsqueeze(0))
        out=[(p.item(),s.item(),d.item())]
    a=np.array(out)
    return a[:,0].mean(), a[:,1].mean(), a[:,2].mean()

try:
    from speechmos import dnsmos as _dnsmod
except Exception:
    _dnsmod = None
_d=None
def dns(path):
    global _d
    if _dnsmod is None: return {'ovrl_mos':float('nan'),'sig_mos':float('nan'),'bak_mos':float('nan')}
    import os
    if _d is None:
        base=os.path.dirname(os.path.abspath(_dnsmod.__file__))
        _d=_dnsmod.DNSMOS(os.path.join(base,'dnsmos_models','sig_bak_ovr.onnx'),
                          os.path.join(base,'dnsmos_models','model_v8.onnx'))
    x,sr=sf.read(path,dtype='float32')
    if x.ndim>1: x=x.mean(1)
    if sr!=16000: x=torchaudio.functional.resample(torch.tensor(x),sr,16000).numpy()
    r=_d(x,16000,False)
    return {'ovrl_mos':float(r['ovrl_mos']),'sig_mos':float(r['sig_mos']),'bak_mos':float(r['bak_mos'])}

if __name__=='__main__':
    S='/agent/repos/Echomancer/research/andrew-teacher/samples/'
    items=[('Andrew ref t0070_0',S+'andrew_reference_book_clips/t0070_0.wav'),
           ('Andrew ref t0040_0',S+'andrew_reference_book_clips/t0040_0.wav'),
           ('Andrew book clip (0.85x)',S+'andrew_original_book_clip.mp3'),
           ('stock Kokoro','/tmp/work/fact/1_base_stockvoice.wav'),
           ('stock+teacher voice','/tmp/work/fact/2_base_teachervoice.wav'),
           ('teacher s1','/tmp/work/fact/2_s1_teachervoice.wav'),
           ('teacher s2','/tmp/work/fact/2_s2_teachervoice.wav'),
           ('p_teacher_full',S+'p_teacher_full.wav'),
           ('p_stock_teacherpack',S+'p_stock_teacherpack.wav'),
           ('eval_final',S+'eval_final'),
           ('stock long','/tmp/work/long/stock_long.wav'),
           ('s1 long','/tmp/work/long/s1_long.wav'),
           ('s2 long','/tmp/work/long/s2_long.wav')]
    print(f'{"name":26s} {"PESQ":>6} {"STOI":>6} {"SI-SDR":>7} {"OVRL":>6} {"SIG":>6} {"BAK":>6}')
    for n,p in items:
        pe,st,sd=sq(p)
        d=dns(p)
        print(f'{n:26s} {pe:6.3f} {st:6.3f} {sd:7.2f} {d["ovrl_mos"]:6.2f} {d["sig_mos"]:6.2f} {d["bak_mos"]:6.2f}')
