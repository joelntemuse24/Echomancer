"""Tests for the cost model and the stage definitions.

These exist because the plan is the deliverable: a run that overshoots the budget is
worse than no run. The numbers asserted here are the ones measured from
`ckpt/test2b/run.log`, so a change to the constants that is not backed by a new
measurement fails the suite.
"""
from __future__ import annotations

import pytest

from research.andrew_clarity.plan import (
    FIXED_OVERHEAD_S,
    L4_USD_PER_HOUR,
    SECONDS_PER_SCORE,
    SECONDS_PER_STEP,
    Budget,
    Stage,
    default_stages,
    modal_seconds_to_usd,
    plan,
    steps_that_fit,
)


def stages():
    return default_stages("s1.bin", "v1.pt", "s150.bin", "v150.pt")


def test_measured_constants_match_the_log():
    """0.686 s/step and 3 s/score are read out of test2b/run.log; do not drift."""
    assert SECONDS_PER_STEP == pytest.approx(0.686)
    assert SECONDS_PER_SCORE == pytest.approx(3.0)
    assert FIXED_OVERHEAD_S == pytest.approx(50.0)


def test_l4_rate_is_the_quoted_one():
    assert L4_USD_PER_HOUR == pytest.approx(1.12)
    assert modal_seconds_to_usd(3600) == pytest.approx(1.12)


def test_stage_cost_includes_overhead_and_scores():
    st = Stage("x", "a", "b", False, True, 1e-5, 1e-4, 0.0, 0.0, {}, steps=100, score_every=50)
    secs, usd = st.cost()
    assert secs == pytest.approx(FIXED_OVERHEAD_S + 100 * SECONDS_PER_STEP + 3 * SECONDS_PER_SCORE)
    assert usd == pytest.approx(secs / 3600 * L4_USD_PER_HOUR)


def test_default_plan_fits_the_stated_budget():
    p = plan(stages(), Budget())
    assert p["total"]["usd"] <= 6.80
    assert not p["dropped"], p["dropped"]
    assert p["total"]["remaining_usd"] > 3.0


def test_plan_drops_what_does_not_fit_instead_of_truncating_it():
    p = plan(stages(), Budget(ceiling_usd=0.60, reserve_usd=0.0, prep_usd=0.0))
    kept = [s["name"] for s in p["stages"]]
    dropped = [s["name"] for s in p["dropped"]]
    assert kept and dropped
    assert len(kept) + len(dropped) == 3
    # kept stages are whole, never a fraction of the declared step count
    by_name = {s.name: s for s in stages()}
    for s in p["stages"]:
        assert s["steps"] == by_name[s["name"]].steps
    assert p["total"]["usd"] <= 0.60


def test_zero_budget_keeps_nothing():
    p = plan(stages(), Budget(ceiling_usd=0.0, reserve_usd=0.0, prep_usd=0.0))
    assert p["stages"] == []
    assert p["total"]["usd"] == 0.0


def test_stage_a_keeps_the_decoder_frozen():
    a = stages()[0]
    assert a.freeze_decoder is True
    assert a.allow_nonstock_decoder is False
    assert a.lr_decoder == 0.0


def test_later_stages_allow_a_moved_decoder_but_pull_it_back():
    for st in stages()[1:]:
        assert st.allow_nonstock_decoder is True
        assert st.dec_pull > 0.0
        assert st.lr_decoder > 0.0


def test_decoder_learning_rate_stays_far_below_the_predictor():
    """10x lower was the rule that made test2b usable; it must not creep up."""
    for st in stages()[1:]:
        assert st.lr_decoder <= st.lr_predictor / 5


def test_every_stage_turns_on_at_least_one_clarity_term():
    for st in stages():
        assert st.weights.get("w_mr", 0) > 0
        assert st.weights.get("w_voice", 0) > 0


def test_steps_that_fit_matches_a_known_budget():
    assert steps_that_fit(1.12) == int(3600 / SECONDS_PER_STEP)


def test_wall_clock_note_is_present_and_speakable():
    p = plan(stages(), Budget())
    assert "min of billed L4" in p["wall_clock_note"]
