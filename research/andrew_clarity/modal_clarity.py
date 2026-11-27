"""Modal app for the Andrew clarity stages. Ephemeral: `modal run`, never `modal deploy`.

This is **not** the production S2 clone app, not `echomancer-cpu`, and not `echomancer-sowell`.
It is a research app that reads the existing `andrew-distill` volume and writes only under
`/vol/kokoro/clarity/`. It has no deployment target in this repository's release path, it
reads no product secret, and the app runs no service: `modal run` starts it, it finishes,
it stops.

    modal run research/andrew_clarity/modal_clarity.py::plan_cmd
    modal run research/andrew_clarity/modal_clarity.py::stage --stage A_clarity_frozen

Every task is GPU-minute bounded by a deadline inside the function, so a runaway step
cannot outlive the money. `--hours` defaults well under the remaining budget; the plan
command prints the arithmetic before anything is spent.
"""
from __future__ import annotations

import os
import sys
import time

import modal

APP_NAME = "andrew-clarity"
HERE = os.path.dirname(os.path.abspath(__file__))
VOLUME_NAME = "andrew-distill"
#: Everything this app writes. Nothing outside this prefix is touched.
OUT = "/vol/kokoro/clarity"
#: Read-only inputs produced by earlier runs.
LEGACY = "/vol/kokoro/retrain_v3"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("espeak-ng", "ffmpeg")
    .pip_install(
        "torch==2.7.1", "torchaudio==2.7.1", "kokoro==0.9.4", "misaki[en]==0.9.4",
        "librosa==0.11.0", "soundfile", "numpy<2.3", "huggingface_hub",
        "speechbrain==1.1.1",
    )
    .run_commands(
        "python -c \"from huggingface_hub import hf_hub_download as d; "
        "R='f3ff3571791e39611d31c381e3a41a3af07b4987'; "
        "[d('hexgrad/Kokoro-82M', f, revision=R) for f in ('config.json','kokoro-v1_0.pth')]; "
        "from kokoro import KPipeline; p=KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', model=False); "
        "print([r.phonemes for r in p('Hello there.')])\""
    )
    # The research package, plus the original v3 scripts it imports. The v3 modules are
    # copied read-only: nothing here edits them, and `train_clarity` patches a single
    # module-level name rather than forking the trainer.
    .add_local_dir(HERE, "/root/research/andrew_clarity")
    .add_local_file(os.path.join(HERE, "..", "..", "training", "README.md"), "/root/research/_readme.md")
)

vol = modal.Volume.from_name(VOLUME_NAME)
app = modal.App(APP_NAME, image=image)


def _log(t0: float, out: str):
    logf = open(os.path.join(out, "run.log"), "a")

    def log(m: str) -> None:
        line = f"[{time.time() - t0:8.1f}s] {m}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    return log


@app.function(gpu="L4", cpu=4, memory=16384, timeout=3 * 3600, volumes={"/vol": vol},
              min_containers=0, max_containers=1, scaledown_window=2)
def run_stage(stage: str = "A_clarity_frozen", hours: float = 0.5, tag: str = ""):
    """Run one clarity stage and score it. Returns the gate for that stage's best checkpoint.

    `hours` is a hard deadline measured from the first step, not a hint: the training loop
    checks it every step and stops cleanly, leaving a resumable `last.pt`.
    """
    os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
    sys.path.insert(0, "/root")
    sys.path.insert(0, "/root/research/andrew_clarity")
    sys.path.insert(0, LEGACY)

    import torch

    import gate  # noqa: F401  (the existing five-point gate helpers, from the v3 tree)
    from train2 import train2

    from clarity_gate import score, score_pair
    from losses import ClarityLoss
    from plan import default_stages
    from train_clarity import install

    t0 = time.time()
    out = os.path.join(OUT, tag or stage)
    os.makedirs(out, exist_ok=True)
    log = _log(t0, out)
    log(f"gpu {torch.cuda.get_device_name(0)} stage {stage} hours {hours}")

    stages = {s.name: s for s in default_stages(
        f"{LEGACY}/test/best_kmodel.pth", f"{LEGACY}/test/best_voice.pt",
        f"{LEGACY}/test2b/step00150_kmodel.pth", f"{LEGACY}/test2b/step00150_voice.pt")}
    st = stages[stage]

    clarity = ClarityLoss(
        st.weights.get("w_mel", 5.0), st.weights.get("w_mr", 0.0), st.weights.get("w_hi", 0.0),
        st.weights.get("w_voice", 0.0), st.weights.get("w_silence", 0.0))
    install(sys.modules["train2"], clarity)
    log(f"objective {clarity.w_mel}*mel + {clarity.w_mr}*mr + {clarity.w_hi}*hi "
        f"+ {clarity.w_voice}*voice + {clarity.w_silence}*silence")

    d = torch.load(f"{LEGACY}/test/data.pt")
    recs, val = d["train"], d["val"]
    log(f"{len(recs)} train clips, {len(val)} val")

    # Init: stage A starts from the phase-1 checkpoint (decoder bit-identical to stock);
    # B and C start from the previous stage's winner via `--init-from`.
    if st.init_kmodel:
        init_kmodel, init_voice, allow = st.init_kmodel, st.init_voice, st.allow_nonstock_decoder
    else:
        init_kmodel = os.environ.get("CLARITY_INIT_KMODEL", f"{OUT}/A_clarity_frozen/best_kmodel.pth")
        init_voice = os.environ.get("CLARITY_INIT_VOICE", f"{OUT}/A_clarity_frozen/best_voice.pt")
        allow = True
    log(f"init kmodel {init_kmodel} voice {init_voice}")

    cfg = dict(
        init_kmodel=init_kmodel, init_voice=init_voice, allow_nonstock_decoder=allow,
        lr=st.lr_predictor, bert_lr=st.lr_predictor / 10, pack_lr=st.lr_pack,
        dec_lr=st.lr_decoder, dec_fc_lr=st.lr_decoder * 2, dec_pull=st.dec_pull,
        dec_scope="all", batch=16, steps=st.steps, score_every=st.score_every,
        warmup=50, log_every=25, crop=40, ripple_max=1.75, ripple_keep=2.0,
        ripple_patience=2, seed=0, deadline=time.time() + hours * 3600,
    )

    # The scorer keeps the existing five-point gate and adds the clarity gates on the same
    # rendered passages, so a checkpoint is judged on one render, not two.
    import numpy as np
    from kokoro import KPipeline

    passages = d["val"][:3]
    texts = [r["text"] for r in passages]
    ref_ecapa = {}
    for k in ("book", "edge1x"):
        p = f"{LEGACY}/eval/{k}_ecapa.npy"
        if os.path.exists(p):
            E = np.load(p)
            c = E.mean(0)
            ref_ecapa[k] = c / np.linalg.norm(c)
    from ecapa_fn import ecapa

    # The real Edge render of the same text, for the reference-relative clarity gates.
    # `test/data.pt` holds the held-out clips as int16 at 24 kHz; the first one is the
    # natural reference, and using it means the gate never needs a second data source.
    edge_ref = passages[0]["wav"].float().numpy() / 32767 if passages else None

    def scorer(model, pack):
        torch.manual_seed(0)
        pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=model)
        with torch.no_grad():
            aud = [np.concatenate([r.audio.cpu().numpy() for r in pipe(t, voice=pack)]) for t in texts]
        cat = np.concatenate(aud)
        emb = [ecapa(a) for a in aud]
        out_d = {f"ecapa_{k}": float(np.mean([e @ c for e in emb])) for k, c in ref_ecapa.items()}
        out_d.update(ripple=gate.ripple(cat), roll99=gate.rolloff(cat), hi6_8k_db=gate.hi_band(cat),
                     wps=float(sum(gate.nwords(t) for t in texts) / (len(cat) / 24000)))
        # Absolute clarity gates: no reference needed, so they work even when the held-out
        # Edge render is missing from the volume.
        out_d.update({f"clarity_{k}": float(v) for k, v in score(aud[0]).items()})
        # Reference-relative articulation, when a same-text Edge render is available.
        if edge_ref is not None:
            pair = score_pair(aud[0], edge_ref[: len(aud[0])])
            out_d["clarity_consonant_retention"] = float(pair["consonant_retention"])
            out_d["clarity_onset_recall"] = float(pair["onset_recall"])
            out_d["clarity_hf_balance_db"] = float(pair["hf_balance_db"])
        return out_d

    hist, cands = train2(recs, val, cfg, out, scorer=scorer, device="cuda", log=log)
    log(f"done cands {cands}")
    vol.commit()
    return dict(stage=stage, cands=cands, hist=hist)


@app.local_entrypoint()
def stage(stage: str = "A_clarity_frozen", hours: float = 0.5, tag: str = ""):
    r = run_stage.remote(stage=stage, hours=hours, tag=tag)
    print(r["stage"], "->", r["cands"])


@app.function(cpu=1, memory=2048, timeout=120)
def plan_cmd(budget: float = 6.80, reserve: float = 1.20):
    sys.path.insert(0, "/root/research")
    from research.andrew_clarity.plan import Budget, default_stages, plan

    stages = default_stages("a", "b", "c", "d")
    return plan(stages, Budget(ceiling_usd=budget, reserve_usd=reserve))


@app.local_entrypoint()
def plan(budget: float = 6.80, reserve: float = 1.20):
    import json

    print(json.dumps(plan_cmd.remote(budget=budget, reserve=reserve), indent=1))
