import os, sys, json, types, torch, numpy as np
sys.path.insert(0, '/tmp/kokoro-env/lib/python3.12/site-packages')
from kokoro import KModel

BASE = '/home/ubuntu/.cache/huggingface/hub/models--hexgrad--Kokoro-82M/snapshots/f3ff3571791e39611d31c381e3a41a3af07b4987/kokoro-v1_0.pth'
BASE_CFG = '/home/ubuntu/.cache/huggingface/hub/models--hexgrad--Kokoro-82M/snapshots/f3ff3571791e39611d31c381e3a41a3af07b4987/config.json'
S1 = '/tmp/andrew-weights/epoch_1st_00002_kmodel.pth'
S2 = '/tmp/andrew-weights/epoch_2nd_00002_kmodel.pth'

def build(groups=('bert','bert_encoder','predictor','decoder','text_encoder'),
          src='base'):
    """groups: which module groups come from `src` ('base','s1','s2'); rest from base."""
    m = KModel(repo_id='hexgrad/Kokoro-82M', config=BASE_CFG, model=BASE)
    m.eval()
    if src == 'base':
        return m
    path = S1 if src == 's1' else S2
    ck = torch.load(path, map_location='cpu', weights_only=True)
    for g in groups:
        sd = ck[g]
        if any(k.startswith('module.') for k in sd):
            sd = {k[len('module.'):]: v for k, v in sd.items()}
        # base and teacher ckpts both omit InstanceNorm affine params (146 vs 122 keys);
        # kokoro's KModel loads with strict=False for the same reason, and affine init is identity.
        missing, unexpected = getattr(m, g).load_state_dict(sd, strict=False)
        assert not unexpected, (g, unexpected)
        # Kokoro's AdaIN uses InstanceNorm(affine=True) whose extra affine params are not in
        # any checkpoint; their init is weight=1/bias=0, so omission is identity (see istftnet.py).
        assert all('.norm.' in k or k.endswith('.norm') for k in missing), (g, missing)
    return m

def voice(path=None):
    if path is None:
        return torch.load('/home/ubuntu/.cache/huggingface/hub/models--hexgrad--Kokoro-82M/snapshots/f3ff3571791e39611d31c381e3a41a3af07b4987/voices/am_michael.pt', map_location='cpu')
    return torch.load(path, map_location='cpu')

def phonemes(text, british=False):
    from misaki import en
    g = en.G2P(trf=False, british=british, fallback=None)
    ps, _ = g(text)
    return ps

def synth(model, ps, pack, speed=1.0, seed=None):
    """Deterministic: Kokoro has no sampling, but set seed anyway."""
    if seed is not None:
        torch.manual_seed(seed)
    with torch.no_grad():
        return model(ps, pack[len(ps)-1], speed, return_output=True)
