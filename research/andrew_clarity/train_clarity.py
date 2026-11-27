"""Drop-in patched `train2` that uses the clarity losses.

`train2.py` is not edited. The ticket asks not to disturb the shipped research scripts, and
more importantly a forked trainer makes the ablation unreadable: the point of stage A is
that *only the objective* changed. So this module imports `train2` and rebinds one
module-level name.

`train2` calls its step function through a module global, `step_losses(...)`, which it
imported from `train`. Rebinding `train2.step_losses` is therefore enough, and it is
visible in the diff as one line rather than a copy of the training loop.

The replacement reproduces `train.step_losses` term for term — CE at weight 20, duration,
F0, noise, the pack L2 regulariser, and the same random-crop selection — and swaps only
the waveform objective. With every clarity weight at zero the patched function returns the
original loss, which is the control arm the research doc refers to.

    python3 -m research.andrew_clarity.train_clarity --help
"""
from __future__ import annotations

import random

import torch
import torch.nn.functional as F

from .losses import ClarityLoss

#: Set by `install()`; `train2` has no argument for it and patching the global is the
#: whole mechanism.
_ACTIVE: ClarityLoss | None = None


def clarity_step_losses(model, pack, bt, mel_loss, crop=80, rng=random):
    """`train.step_losses` with `ClarityLoss` in place of mel-L1 alone."""
    from rt_common import AHOP

    clarity = _ACTIVE or ClarityLoss()
    rows = pack.rows(bt["nph"] - 1)
    s = rows[:, 128:]
    ac = rows[:, :128]
    bert = model.bert(bt["ids"], attention_mask=(~bt["mask"]).int())
    d_en = model.bert_encoder(bert).transpose(-1, -2)
    dur_logits, en = model.predictor(d_en, s, bt["lens"], bt["aln"], bt["mask"])
    F0p, Np = model.predictor.F0Ntrain(en, s)
    fm = bt["fm"]
    l_f0 = (F.smooth_l1_loss(F0p, bt["f0"], reduction="none") * fm).sum() / fm.sum() / 10
    l_n = (F.smooth_l1_loss(Np, bt["n"], reduction="none") * fm).sum() / fm.sum()
    l_ce = 0.0
    l_dur = 0.0
    for b, k in enumerate(bt["lens"].tolist()):
        lg = dur_logits[b, :k]
        tgt_d = bt["dur"][b, :k].clamp(max=lg.shape[-1])
        trg = (torch.arange(lg.shape[-1], device=lg.device)[None] < tgt_d[:, None]).float()
        l_ce = l_ce + F.binary_cross_entropy_with_logits(lg, trg)
        l_dur = l_dur + F.l1_loss(torch.sigmoid(lg).sum(-1)[1:k - 1], tgt_d[1:k - 1].float())
    n_batch = len(bt["rs"])
    l_ce = l_ce / n_batch
    l_dur = l_dur / n_batch

    with torch.no_grad():
        t_en = model.text_encoder(bt["ids"], bt["lens"], bt["mask"])
    t_min = min(r["T"] for r in bt["rs"])
    c = min(crop, t_min)
    asr, f0c, nc, wav = [], [], [], []
    for b, r in enumerate(bt["rs"]):
        s0 = rng.randint(0, r["T"] - c)
        asr.append(t_en[b] @ bt["aln"][b][:, s0:s0 + c])
        f0c.append(F0p[b, 2 * s0:2 * (s0 + c)])
        nc.append(Np[b, 2 * s0:2 * (s0 + c)])
        wav.append(r["wav"][s0 * AHOP:(s0 + c) * AHOP].float() / 32767)
    pred = model.decoder(torch.stack(asr), torch.stack(f0c), torch.stack(nc), ac).squeeze(1)
    target = torch.stack(wav).to(pred.device)
    n = min(pred.shape[-1], target.shape[-1])
    l_mel = mel_loss(pred[..., :n], target[..., :n])
    l_wave, terms = clarity(pred[..., :n], target[..., :n], l_mel)
    reg = (pack.delta ** 2).mean()
    total = 20 * l_ce + 1 * l_dur + l_f0 + l_n + l_wave + 1.0 * reg
    d = dict(ce=float(l_ce), dur=float(l_dur), f0=float(l_f0), n=float(l_n),
             tot=float(total), reg=float(reg))
    d.update(terms)
    return total, d


def install(train2_module, clarity: ClarityLoss):
    """Rebind `train2.step_losses` and remember the active weight set."""
    global _ACTIVE
    _ACTIVE = clarity
    train2_module.step_losses = clarity_step_losses
    return train2_module


def main() -> int:
    """Print the weights the patched step would use, without touching a GPU.

    Also a cheap self-check that this module imports cleanly on a machine with no
    `kokoro`, no `jdc` and no dataset — which is what a reviewer's laptop looks like.
    """
    import argparse

    ap = argparse.ArgumentParser(description="Inspect the clarity objective.")
    ap.add_argument("--w-mel", type=float, default=5.0)
    ap.add_argument("--w-mr", type=float, default=2.0)
    ap.add_argument("--w-hi", type=float, default=1.0)
    ap.add_argument("--w-voice", type=float, default=0.5)
    ap.add_argument("--w-silence", type=float, default=0.5)
    args = ap.parse_args()
    c = ClarityLoss(args.w_mel, args.w_mr, args.w_hi, args.w_voice, args.w_silence)
    print(f"ClarityLoss(w_mel={c.w_mel}, w_mr={c.w_mr}, w_hi={c.w_hi}, "
          f"w_voice={c.w_voice}, w_silence={c.w_silence})")
    print("A stage with all weights 0 reproduces train.step_losses exactly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
