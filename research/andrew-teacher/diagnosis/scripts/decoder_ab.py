"""Isolate the decoder: feed identical en/F0/N into stock vs teacher decoder."""
import sys, os, numpy as np, torch, soundfile as sf
sys.path.insert(0,'/tmp/work')
from kh import build, voice, phonemes, BASE_CFG
import json

OUT='/tmp/work/dec'
os.makedirs(OUT, exist_ok=True)

TEXT = ("In the spring of nineteen thirty-nine, the news from Berlin reached the "
        "physicists in Copenhagen within days. Some of them believed the discovery "
        "would change everything; others thought it was a curiosity of the laboratory, "
        "nothing more. By the end of the year, nobody was laughing.")
ps = phonemes(TEXT)

def capture(m, ps, pack):
    """Run the model's own forward but keep the decoder inputs."""
    m.eval()
    ids = list(filter(lambda i: i is not None, map(lambda p: m.vocab.get(p), ps)))
    input_ids = torch.LongTensor([[0, *ids, 0]])          # [1, T]
    ref_s = pack[len(ps)-1].reshape(1, 256)               # [1, 256]
    L = torch.full((1,), input_ids.shape[-1], dtype=torch.long)
    tmask = torch.arange(L.max()).unsqueeze(0).expand(L.shape[0], -1).type_as(L)
    tmask = torch.gt(tmask+1, L.unsqueeze(1))
    with torch.no_grad():
        bert_dur = m.bert(input_ids, attention_mask=(~tmask).int())
        d_en = m.bert_encoder(bert_dur).transpose(-1, -2)  # [1, 512, T]
        s = ref_s[:, 128:]                                 # [1, 128]
        d = m.predictor.text_encoder(d_en, s, L, tmask)
        x, _ = m.predictor.lstm(d)
        duration = torch.sigmoid(m.predictor.duration_proj(x)).sum(-1)
        pred_dur = torch.round(duration).clamp(min=1).long().squeeze()
        idx = torch.repeat_interleave(torch.arange(input_ids.shape[1]), pred_dur)
        aln = torch.zeros((input_ids.shape[1], idx.shape[0]))
        aln[idx, torch.arange(idx.shape[0])] = 1
        aln = aln.unsqueeze(0)
        en = d.transpose(-1, -2) @ aln
        F0, N = m.predictor.F0Ntrain(en, s)
        t_en = m.text_encoder(input_ids, L, tmask)
        asr = t_en @ aln
    return asr, F0, N, ref_s, pred_dur

# Use the teacher voice for both so only the decoder differs.
pack = voice('/tmp/andrew-weights/epoch_2nd_00002_voice.pt')
pack_stock = voice()

results = {}
for tag, path in [('stock', None), ('s1','/tmp/andrew-weights/epoch_1st_00002_kmodel.pth'),
                  ('s2','/tmp/andrew-weights/epoch_2nd_00002_kmodel.pth')]:
    m = build((), 'base')       # all-base weights; we swap only the decoder below
    if path:
        ck = torch.load(path, map_location='cpu', weights_only=True)
        sd = ck['decoder']
        if any(k.startswith('module.') for k in sd):
            sd = {k[7:]: v for k, v in sd.items()}
        m.decoder.load_state_dict(sd, strict=False)
    res=[]
    for vtag, vpack in [('tvoice', pack), ('stockvoice', pack_stock)]:
        asr, F0, N, ref_s, pred_dur = capture(m, ps, vpack)
        with torch.no_grad():
            audio = m.decoder(asr, F0, N, ref_s[:, :128]).squeeze().numpy()
        f=f'{OUT}/{tag}_{vtag}.wav'
        sf.write(f, audio, 24000)
        res.append((vtag, f, pred_dur.numpy()))
        print(f'{tag:6s} {vtag:11s} frames={pred_dur.numpy().sum()} dur={len(audio)/24000:.2f}s peak={np.abs(audio).max():.3f}')
    results[tag]=res

# also save the shared intermediate tensors once
asr, F0, N, ref_s, pred_dur = capture(build((), 'base'), ps, pack)
torch.save({'asr':asr,'F0':F0,'N':N,'ref_s':ref_s,'pred_dur':pred_dur,'ps':ps}, f'{OUT}/intermediates.pt')
print('saved intermediates', {k:tuple(v.shape) for k,v in dict(asr=asr,F0=F0,N=N).items()})
