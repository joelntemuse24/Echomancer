"""Unit scheduling: batch width, work-stealing, and the anchor rule.

Two things here decide whether a book still sounds right, and neither is a
performance question:

1. **A section's later units are conditioned on its first take only.** Units
   1..K-1 have no dependency on each other, which is why they can be stolen by
   an idle lane at all — but every one of them still has to be prompted with
   exactly the turn sequential execution would have built. A stolen unit that
   got a different prompt is a different recording.
2. **A section is complete before it reaches the codec.** The codec assembles
   takes in unit order, so an out-of-order finish must not leave a hole.

The scheduler is pure Python (`_UnitScheduler`), so all of this is asserted on a
CPU with no GPU, no torch and no Modal.
"""

from __future__ import annotations

import importlib
import sys

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


@pytest.fixture(scope="module")
def batch_module():
    from test_s2_unit_assembly import _install_stubs

    sys.path.insert(0, str(MODAL_DIR))
    _install_stubs()
    module = importlib.import_module("s2_batch")
    yield module
    sys.path.remove(str(MODAL_DIR))


class _Codes:
    """Stand-in for a take: `shape[1]` frames, and an identity to compare."""

    def __init__(self, index, frames: int = 4) -> None:
        self.index = index
        self.shape = (10, frames)

    def __repr__(self) -> str:
        return f"take({self.index})"


def _units(n: int, chars: int = 100):
    return [{"text": "x" * chars, "pause": "para"} for _ in range(n)]


def _run_waves(sched, width: int = 32) -> int:
    """Steps until every unit is done, each unit taking one step.

    Each lane holds at most one unit at a time and every claim finishes at the
    end of the step, so this counts *time*, not claim count: a lane that picks
    up a stolen unit at step 2 and one that does not both cost one step.
    """
    steps = 0
    while not sched.is_done():
        claims = []
        for lane in range(width):
            claim = sched.claim()
            if claim is None:
                break
            sched.assign(lane, claim)
            claims.append((lane, claim))
        assert claims, "a step must make progress"
        steps += 1
        for lane, claim in claims:
            sched.complete(lane, claim, _Codes(claim))
    return steps


# ── batch width ───────────────────────────────────────────────────────────


class TestBatchWidth:
    def test_a_one_section_call_steps_one_row_not_the_capacity(self, batch_module):
        """Section 0 is one section; 32 rows would be 31 dummies."""
        width = batch_module.choose_batch_width([[{"text": "hi"}]], bucketed=True, work_steal=False)
        assert width == 1

    @pytest.mark.parametrize(
        "sections,units,expected",
        [
            (1, 1, 1),
            (1, 2, 4),     # work-stealing: both units can run at once
            (2, 1, 4),
            (3, 1, 4),
            (5, 1, 8),
            (8, 1, 8),
            (9, 1, 16),
            (17, 1, 24),
            (25, 1, 32),
            (32, 1, 32),
            (40, 1, 32),   # never wider than the capacity
        ],
    )
    def test_width_is_the_smallest_bucket_that_fits(self, batch_module, sections, units, expected):
        slots = [_units(units) for _ in range(sections)]
        assert batch_module.choose_batch_width(slots, work_steal=True) == expected

    def test_width_without_work_stealing_counts_one_unit_per_section(self, batch_module):
        slots = [_units(4) for _ in range(3)]
        # One unit at a time per section: three lanes, not twelve.
        assert batch_module.choose_batch_width(slots, work_steal=False) == 4

    def test_bucketing_can_be_turned_off(self, batch_module):
        slots = [_units(1)]
        assert batch_module.choose_batch_width(slots, bucketed=False) == batch_module.BATCH

    def test_the_width_is_never_above_the_capacity(self, batch_module):
        slots = [_units(2) for _ in range(64)]
        assert batch_module.choose_batch_width(slots, capacity=4) == 4

    def test_an_empty_call_still_returns_a_sane_width(self, batch_module):
        assert batch_module.choose_batch_width([]) == 1


class TestKvBuckets:
    def test_the_four_coarse_buckets_are_used(self, batch_module):
        assert batch_module.KV_BUCKETS == (512, 1024, 2048, 4096)

    @pytest.mark.parametrize(
        "pos,expected",
        [(0, 512), (100, 512), (511, 512), (512, 1024), (1023, 1024), (1024, 2048),
         (2048, 4096), (4096, 4096)],
    )
    def test_a_position_rounds_up_to_its_bucket(self, batch_module, pos, expected):
        assert batch_module.choose_kv_len(pos) == expected

    def test_the_bucket_count_is_small_enough_to_warm(self, batch_module):
        """The old 128-token bucket produced 32 shapes; only 512 was warmed."""
        assert len(batch_module.KV_BUCKETS) <= 4


# ── the anchor rule ───────────────────────────────────────────────────────


class TestAnchorRule:
    def test_only_anchors_are_claimable_until_one_finishes(self, batch_module):
        """Nothing else can start: every later unit needs its section's anchor."""
        slots = [_units(4) for _ in range(2)]
        sched = batch_module._UnitScheduler(slots, width=8)
        claims = [sched.claim() for _ in range(8)]
        assert claims == [(0, 0), (1, 0)] + [None] * 6

    def test_a_later_unit_waits_for_unit_zero_to_finish(self, batch_module):
        slots = [_units(3)]
        sched = batch_module._UnitScheduler(slots, width=4)
        first = sched.claim()
        assert first == (0, 0)
        # Unit 0 is in flight and has not completed: nothing else is claimable.
        assert sched.claim() is None
        sched.complete(0, first, _Codes(0))
        assert sched.anchor_ready[0] is True
        assert sched.claim() == (0, 1)

    def test_a_stolen_unit_gets_the_first_take_as_its_history(self, batch_module):
        """The prompt a stolen unit sees is the sequential one."""
        slots = [_units(3)]
        sched = batch_module._UnitScheduler(slots, width=4)
        anchor_codes = _Codes(0)
        sched.complete(0, sched.claim(), anchor_codes)
        second = sched.claim()
        assert second == (0, 1)
        history = sched.history_for(0)
        assert len(history) == 1
        # Exactly the section's first take, not the previous unit's.
        assert history[0][1] is anchor_codes
        assert history[0][0] == slots[0][0]["text"]

    def test_the_anchor_does_not_move_as_later_units_finish(self, batch_module):
        slots = [_units(3)]
        sched = batch_module._UnitScheduler(slots, width=4)
        anchor = _Codes("anchor")
        sched.complete(0, sched.claim(), anchor)
        sched.complete(0, sched.claim(), _Codes(1))
        sched.complete(0, sched.claim(), _Codes(2))
        assert sched.anchor[0][1] is anchor, (
            "chaining to the previous take is what walked the voice away from "
            "the reference (job 12534aaa); only the first take may be history"
        )

    def test_history_is_empty_before_the_anchor_exists(self, batch_module):
        sched = batch_module._UnitScheduler([_units(2)], width=2)
        assert sched.history_for(0) == []

    def test_an_empty_first_take_leaves_later_units_unconditioned(self, batch_module):
        """Sequential execution prompts them with the reference alone."""
        slots = [_units(2)]
        sched = batch_module._UnitScheduler(slots, width=2)
        sched.complete(0, sched.claim(), _Codes(0, frames=0))
        assert sched.history_for(0) == []


# ── work stealing ─────────────────────────────────────────────────────────


class TestWorkStealing:
    def test_a_three_by_six_call_finishes_in_two_waves(self, batch_module):
        """Three anchors, then all fifteen remaining units at once."""
        slots = [_units(6) for _ in range(3)]
        sched = batch_module._UnitScheduler(slots, width=32, work_steal=True)
        assert _run_waves(sched) == 2

    def test_without_stealing_the_same_call_takes_six_waves(self, batch_module):
        slots = [_units(6) for _ in range(3)]
        sched = batch_module._UnitScheduler(slots, width=32, work_steal=False)
        assert _run_waves(sched) == 6, (
            "without stealing a section is one unit at a time, so the call is "
            "as long as its longest section"
        )

    def test_stealing_is_strictly_fewer_waves(self, batch_module):
        slots = [_units(6) for _ in range(3)]
        stolen = _run_waves(batch_module._UnitScheduler(slots, width=32, work_steal=True))
        strict = _run_waves(batch_module._UnitScheduler(slots, width=32, work_steal=False))
        assert stolen < strict, (stolen, strict)

    def test_the_longest_remaining_section_is_claimed_first(self, batch_module):
        slots = [_units(2, chars=100), _units(5, chars=100), _units(1, chars=100)]
        sched = batch_module._UnitScheduler(slots, width=8)
        # Anchors first, longest section first.
        assert sched.claim() == (1, 0)
        assert sched.claim() == (0, 0)
        assert sched.claim() == (2, 0)

    def test_every_unit_is_claimed_exactly_once(self, batch_module):
        slots = [_units(3), _units(5), _units(1)]
        sched = batch_module._UnitScheduler(slots, width=8)
        claimed: list[tuple[int, int]] = []
        while not sched.is_done():
            wave = []
            for lane in range(8):
                claim = sched.claim()
                if claim is None:
                    break
                wave.append((lane, claim))
            assert wave, "a wave must make progress"
            for lane, claim in wave:
                claimed.append(claim)
                sched.complete(lane, claim, _Codes(claim))
        assert sorted(claimed) == sorted(
            (s, u) for s, units in enumerate(slots) for u in range(len(units))
        )
        assert len(claimed) == len(set(claimed)), "a unit was claimed twice"


class TestCompletion:
    def test_takes_reassemble_in_section_and_unit_order(self, batch_module):
        """Out-of-order finishing must not reorder a section's audio."""
        slots = [_units(4), _units(3)]
        sched = batch_module._UnitScheduler(slots, width=8)
        anchor_a = sched.claim()
        anchor_b = sched.claim()
        sched.assign(0, anchor_a)
        sched.assign(1, anchor_b)
        # Section 1's anchor finishes first, so its unit 1 becomes claimable.
        sched.complete(1, anchor_b, _Codes((1, 0)))
        second = sched.claim()
        assert second == (1, 1)
        sched.assign(2, second)
        sched.complete(2, second, _Codes((1, 1)))
        sched.complete(0, anchor_a, _Codes((0, 0)))
        # The stored order is unit order, not finish order.
        assert [getattr(c, "index", None) for c in sched.codes[1]] == [(1, 0), (1, 1), None]
        assert [getattr(c, "index", None) for c in sched.codes[0]] == [(0, 0), None, None, None]

    def test_a_section_is_reported_ready_only_when_every_unit_landed(self, batch_module):
        slots = [_units(2)]
        sched = batch_module._UnitScheduler(slots, width=2)
        sched.complete(0, sched.claim(), _Codes(0))
        assert sched.finished == []
        sched.complete(0, sched.claim(), _Codes(1))
        assert sched.finished == [0]
        assert sched.take_finished() == 0
        assert sched.take_finished() is None

    def test_a_lane_is_free_after_its_unit_completes(self, batch_module):
        slots = [_units(3)]
        sched = batch_module._UnitScheduler(slots, width=4)
        claim = sched.claim()
        sched.assign(2, claim)
        assert 2 not in sched.idle_lanes()
        sched.complete(2, claim, _Codes(0))
        assert 2 in sched.idle_lanes()

    def test_the_scheduler_records_the_prompt_it_built(self, batch_module):
        slots = [_units(2)]
        sched = batch_module._UnitScheduler(slots, width=2)
        claim = sched.claim()
        sched.complete(0, claim, _Codes(0), prompt="PROMPT")
        assert sched.prompts[claim] == "PROMPT"
