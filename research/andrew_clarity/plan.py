"""Budgeted clarity stages for Andrew, plus the cost model that keeps them affordable.

The whole point of this module is that a run is *planned before it is launched*: given an
L4 at $1.12/h and a hard ceiling, it computes how many optimizer steps fit, how many
checkpoints will be scored, and what the run is expected to cost — and refuses to start
when the plan does not fit.

Baseline timings, all read out of `ckpt/test2b/run.log` and `hist.json` rather than
guessed:

* **0.686 s per step** (median over thirty 25-step gaps, range 0.65-0.82) at batch 16,
  crop 40, decoder unfrozen, on an L4.
* **3 s per scored checkpoint** (2.0-3.6 s once ECAPA and the pipeline exist).
* **~50 s of fixed overhead** before the first steady-state step.

The headline consequence: 782 steps cost about ten minutes and $0.18, so the $6.80
ceiling buys roughly **4.8 hours of L4 — about 25,000 steps**. Cost is not the binding
constraint on this work. The binding constraints are the objective (which currently
prefers a stock render over the real reference) and the source data. The plan below
therefore spends a small fraction of the budget on three well-separated stages and keeps
most of it for re-running whichever stage the gate says came closest.

Nothing in here imports torch at module scope, so the cost model can be run on a laptop.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass

L4_USD_PER_HOUR = 1.12
#: Measured on `test2b` (`ckpt/test2b/run.log`): consecutive 25-step log lines 0.65-0.82 s
#: apart, median **0.686 s/step** at batch 16 and crop 40 with the decoder unfrozen. This
#: is the number to trust; the 594.7 s / 782 steps average is inflated by setup and by the
#: first (lazily initialised) score.
SECONDS_PER_STEP = 0.686
#: A scored checkpoint costs 2.0-3.6 s once ECAPA and the pipeline exist (measured from
#: the deltas between consecutive `hist` entries, each a 75-step block). The *first*
#: score costs ~18 s because it constructs the pipeline and loads ECAPA.
SECONDS_PER_SCORE = 3.0
#: Model load, data read, pipeline + ECAPA construction, and the first score. Measured:
#: `hist` step 0 lands at 30.9 s and step 25 at 66.6 s, i.e. ~49 s before steady state.
FIXED_OVERHEAD_S = 50.0


@dataclass
class Stage:
    """One trainable stage.

    `init` names the checkpoint to start from, so the stage sequence is explicit and a
    stage can be re-run on its own. `freeze_decoder` is what makes stage A cheap: it
    reproduces the phase-1 recipe that already reached ECAPA 0.78 with the decoder
    untouched, so the clarity losses are being tested against a known likeness rather
    than against a moving one.
    """

    name: str
    init_kmodel: str
    init_voice: str
    allow_nonstock_decoder: bool
    freeze_decoder: bool
    lr_predictor: float
    lr_pack: float
    lr_decoder: float
    dec_pull: float
    weights: dict[str, float]
    steps: int
    score_every: int
    note: str = ""

    def cost(self) -> tuple[float, float]:
        """(seconds, usd) for this stage."""
        secs = FIXED_OVERHEAD_S + self.steps * SECONDS_PER_STEP
        secs += (self.steps // self.score_every + 1) * SECONDS_PER_SCORE
        return secs, secs / 3600 * L4_USD_PER_HOUR


def default_stages(step1: str, voice1: str, step150: str, voice150: str) -> list[Stage]:
    """The three stages, in the order they should run.

    A. **Clarity losses with the decoder frozen.** Starts from the phase-1 best
       (predictor and pack already fitted to Andrew, decoder still bit-identical to
       stock). Only the loss changes, so any movement in the clarity gate is
       attributable to the loss and not to a freer decoder. Cheapest stage, and the one
       that answers the top-ranked question in the diagnosis: can the existing 82M
       decoder produce clean consonants at all?

    B. **Gentle decoder unfreeze on the stage-A result.** This is where the 6-8 kHz
       balance and the gap floor get fixed if stage A says the decoder is the limit.
       Same 10x-lower decoder LR and L2 pull as `test2b`, but with the clarity terms
       still on — the pull towards stock is what stops the run from trading likeness
       for crispness or vice versa.

    C. **Sentence-end repair only.** Resumes from whichever of A/B won, at a low LR,
       with `w_silence` and `w_voice` raised and everything else held. This is the
       stage that targets the "buzz at the ends of sentences" complaint directly.
       It is also the stage to skip if A and B already clear the gate.
    """
    return [
        Stage(
            name="A_clarity_frozen",
            init_kmodel=step1, init_voice=voice1, allow_nonstock_decoder=False,
            freeze_decoder=True, lr_predictor=5e-5, lr_pack=5e-4, lr_decoder=0.0,
            dec_pull=0.0,
            weights=dict(w_mel=5.0, w_mr=2.0, w_hi=1.0, w_voice=0.5, w_silence=0.5),
            steps=900, score_every=75,
            note="loss-only ablation against the phase-1 checkpoint; decoder bit-identical to stock",
        ),
        Stage(
            name="B_clarity_unfreeze",
            init_kmodel="", init_voice="", allow_nonstock_decoder=True,
            freeze_decoder=False, lr_predictor=4e-5, lr_pack=4e-4, lr_decoder=5e-6,
            dec_pull=5e-4,
            weights=dict(w_mel=4.0, w_mr=3.0, w_hi=1.5, w_voice=1.0, w_silence=0.5),
            steps=1200, score_every=100,
            note="gentle decoder unfreeze with the clarity terms on; init from the stage-A winner",
        ),
        Stage(
            name="C_endings",
            init_kmodel="", init_voice="", allow_nonstock_decoder=True,
            freeze_decoder=False, lr_predictor=1e-5, lr_pack=1e-4, lr_decoder=2e-6,
            dec_pull=1e-3,
            weights=dict(w_mel=4.0, w_mr=1.0, w_hi=0.5, w_voice=2.0, w_silence=2.0),
            steps=600, score_every=100,
            note="phrase-end repair only; skip when A and B already clear the gate",
        ),
    ]


@dataclass
class Budget:
    ceiling_usd: float = 6.80
    #: Not every dollar is spendable: keep a margin for a re-run of the stage that
    #: fails, because a stage that misses its gate has to be repeated to be useful.
    reserve_usd: float = 1.20
    #: Prep and data load happen once and are charged even if a stage is cancelled.
    prep_usd: float = 0.25

    @property
    def spendable(self) -> float:
        return max(0.0, self.ceiling_usd - self.reserve_usd - self.prep_usd)


def plan(stages: list[Stage], budget: Budget) -> dict:
    """Fit as many stages as the spendable budget allows, in order.

    A stage that does not fit is not silently truncated to part of its steps: a stage
    cut mid-schedule has a different LR curve and is not the experiment it claims to be.
    The plan reports what was dropped so the operator decides.
    """
    remaining = budget.spendable
    kept, dropped = [], []
    for st in stages:
        secs, usd = st.cost()
        if usd <= remaining:
            kept.append(st)
            remaining -= usd
        else:
            dropped.append(st)
    total_s = sum(st.cost()[0] for st in kept)
    total_usd = sum(st.cost()[1] for st in kept)
    return {
        "budget": asdict(budget) | {"spendable": round(budget.spendable, 2)},
        "measured": {"seconds_per_step": round(SECONDS_PER_STEP, 4),
                     "seconds_per_score": SECONDS_PER_SCORE,
                     "l4_usd_per_hour": L4_USD_PER_HOUR},
        "stages": [
            asdict(st) | {"seconds": round(st.cost()[0]), "usd": round(st.cost()[1], 3)}
            for st in kept
        ],
        "dropped": [asdict(st) | {"usd": round(st.cost()[1], 3)} for st in dropped],
        "total": {"seconds": round(total_s), "minutes": round(total_s / 60, 1),
                  "usd": round(total_usd, 2), "remaining_usd": round(remaining, 2)},
        "wall_clock_note": (
            f"{total_s / 60:.0f} min of billed L4 time across {len(kept)} stage(s). "
            "Modal bills container wall time, including the image build on the first "
            "call, so the first stage of a fresh image costs a few extra minutes."
        ),
    }


def modal_seconds_to_usd(seconds: float) -> float:
    return seconds / 3600 * L4_USD_PER_HOUR


def steps_that_fit(usd: float, sec_per_step: float = SECONDS_PER_STEP) -> int:
    """How many steps a given spend buys, at zero scoring cost. Used to sanity-check a
    plan by hand."""
    return int(max(0.0, usd) / L4_USD_PER_HOUR * 3600 / sec_per_step)


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Plan the Andrew clarity stages against a budget.")
    ap.add_argument("--budget", type=float, default=6.80)
    ap.add_argument("--reserve", type=float, default=1.20)
    ap.add_argument("--prep-usd", type=float, default=0.25)
    ap.add_argument("--stage1", default="ckpt/test/best_kmodel.pth")
    ap.add_argument("--voice1", default="ckpt/test/best_voice.pt")
    ap.add_argument("--step150", default="ckpt/test2b/step00150_kmodel.pth")
    ap.add_argument("--voice150", default="ckpt/test2b/step00150_voice.pt")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    stages = default_stages(args.stage1, args.voice1, args.step150, args.voice150)
    p = plan(stages, Budget(ceiling_usd=args.budget, reserve_usd=args.reserve, prep_usd=args.prep_usd))
    if args.json:
        print(json.dumps(p, indent=1))
        return 0
    print(f"spendable ${p['budget']['spendable']:.2f} of ${p['budget']['ceiling_usd']:.2f} "
          f"(reserve ${p['budget']['reserve_usd']:.2f}, prep ${p['budget']['prep_usd']:.2f})")
    print(f"measured {p['measured']['seconds_per_step']:.3f} s/step, "
          f"{p['measured']['seconds_per_score']:.0f} s/score at ${L4_USD_PER_HOUR}/h\n")
    for s in p["stages"]:
        print(f"  {s['name']:<22} {s['steps']:>4} steps  {s['seconds']:>6} s  ${s['usd']:.2f}")
    for s in p["dropped"]:
        print(f"  {s['name']:<22} DROPPED (${s['usd']:.2f} does not fit)")
    print(f"\n  total {p['total']['minutes']:.0f} min  ${p['total']['usd']:.2f}  "
          f"leaves ${p['total']['remaining_usd']:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
