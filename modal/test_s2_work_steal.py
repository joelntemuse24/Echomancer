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
import types
import os
import sys

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


@pytest.fixture(scope="module")
def batch_module():
    """`s2_batch` imported for the v10 engine.

    Bucketing, work-stealing and the coarse KV buckets are v10 behaviour, so the
    module has to be imported with that engine selected — it reads its switches
    once, at import, because they are baked into a GPU snapshot.
    """
    from test_s2_unit_assembly import _install_stubs

    os.environ["S2C_ENGINE"] = "v10"
    sys.path.insert(0, str(MODAL_DIR))
    _install_stubs()
    sys.modules.pop("s2_batch", None)
    module = importlib.import_module("s2_batch")
    yield module
    sys.modules.pop("s2_batch", None)
    sys.path.remove(str(MODAL_DIR))
    os.environ.pop("S2C_ENGINE", None)


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
            # A 2-unit section still starts 1 lane: unit 1 cannot run until
            # unit 0 (its anchor) finishes, so `max(len(slots), sum(len-1))` is 1.
            (1, 2, 1),
            (2, 2, 4),     # two anchors plus two stolen units
            (1, 4, 4),     # one anchor, then three stolen units
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
        assert sched.lane[2] == claim
        assert claim in sched.inflight
        sched.complete(2, claim, _Codes(0))
        assert sched.lane[2] is None
        assert claim not in sched.inflight

    def test_the_scheduler_records_the_prompt_it_built(self, batch_module):
        slots = [_units(2)]
        sched = batch_module._UnitScheduler(slots, width=2)
        claim = sched.claim()
        sched.complete(0, claim, _Codes(0), prompt="PROMPT")
        assert sched.prompts[claim] == "PROMPT"


# ── the streamed codec fires before generation ends ────────────────────────
#
# The overlap itself lives inside `render`, which needs torch tensors and a GPU.
# What is testable without either is the *policy* `render` applies, and that is
# where the bug would be: a gate that never opens until generation has ended
# turns the streamed path back into the serial one. `test_s2_pipeline` covers the
# service half (that `on_section` is called on the GPU thread and reaches the
# encode pool); this covers when a section becomes decodable at all.


def test_the_codec_runs_before_generation_finishes(batch_module):
    """A section's decode must not wait for the slowest row.

    Uses `_UnitScheduler` directly plus the same flush policy `render` applies,
    so the assertion is about the rule rather than about torch plumbing: with
    two sections of one unit each, the first to finish is decodable immediately
    even though the other is still generating.
    """
    slots = [[{"text": "a", "pause": "para"}], [{"text": "b", "pause": "para"}]]
    sched = batch_module._UnitScheduler(slots, width=4, work_steal=True)
    pending: list[int] = []
    decoded: list[int] = []

    def flush(active_rows: int):
        units = sum(len(slots[s]) for s in pending)
        if pending and (active_rows <= batch_module.CODEC_TAIL_ROWS or units >= batch_module.CODEC_MIN_UNITS):
            decoded.extend(pending)
            pending.clear()

    a = sched.claim()
    b = sched.claim()
    sched.assign(0, a)
    sched.assign(1, b)

    # Section 0 finishes while section 1 is still in flight (2 active rows is
    # below the tail threshold, so the launch is allowed).
    sched.complete(0, a, type("C", (), {"shape": (2, 5)})())
    if 0 in sched.finished:
        pending.append(0)
    flush(active_rows=1)
    assert decoded == [0], "section 0 must be decodable before section 1 finishes"

    # Section 1 then finishes; nothing is left behind.
    sched.complete(1, b, type("C", (), {"shape": (2, 5)})())
    if 1 in sched.finished:
        pending.append(1)
    flush(active_rows=0)
    assert decoded == [0, 1]
    assert pending == []


class TestTheRealLoopRefills:
    """The GPU loop's own refill rule, not a harness's idea of it.

    The earlier scheduler tests drove `claim()` directly and claimed for every
    lane on every step, which a GPU loop only does if something asks it to. The
    shipped loop asks in exactly two places — the opening `start_lanes_batch()`
    and `refill_idle_lanes()` after each done-set — so those two are what this
    models. A 3-section call that only refilled the lane that finished would take
    one section per step, forever.
    """

    @staticmethod
    def _loop(sched, width: int, *, refill_every_tick: bool) -> int:
        """Run the loop's own shape: open, then tick until nothing is claimable.

        A tick is not "one unit per lane". The engine steps a lane's *whole unit*
        (which can be dozens of decode steps) and only then frees it, so a unit is
        one tick here. That is what makes the refill rule visible: after the
        opening wave, the lanes that were idle have no unit to finish, so only a
        refill can give them one.
        """
        # Opening wave: every idle lane claims, as `start_lanes_batch` does.
        for lane in range(width):
            claim = sched.claim()
            if claim is None:
                break
            sched.assign(lane, claim)
        ticks = 0
        while not sched.is_done():
            ticks += 1
            # Every lane holding a claim finishes its unit.
            for lane in range(width):
                held = sched.lane[lane]
                if held is not None:
                    sched.complete(lane, held, _Codes(held))
            if refill_every_tick:
                # `refill_idle_lanes`: every free lane claims again.
                for lane in range(width):
                    if sched.lane[lane] is not None:
                        continue
                    claim = sched.claim()
                    if claim is None:
                        continue
                    sched.assign(lane, claim)
            else:
                # Only the lane that just finished would restart itself, and only
                # for the section it already owned. With one section per lane and
                # nothing else claiming, the rest of the book never runs.
                for lane in range(width):
                    if sched.lane[lane] is not None:
                        continue
                    if lane >= len(sched.slots):
                        continue
                    claim = sched.claim()
                    if claim is None:
                        continue
                    sched.assign(lane, claim)
        return ticks

    def test_three_sections_of_six_units_take_two_steps(self, batch_module):
        slots = [_units(6) for _ in range(3)]
        sched = batch_module._UnitScheduler(slots, width=24, work_steal=True)
        assert self._loop(sched, 24, refill_every_tick=True) == 2

    def test_without_the_refill_the_call_creeps_one_section_per_step(self, batch_module):
        """The regression this test exists for.

        `finish` used to start only the lane that finished. With 3 sections and
        24 lanes, 21 lanes never finish anything, so nothing ever asks them to
        claim and the book advances one section's worth of units per step.
        """
        slots = [_units(6) for _ in range(3)]
        sched = batch_module._UnitScheduler(slots, width=24, work_steal=True)
        without = self._loop(sched, 24, refill_every_tick=False)
        sched2 = batch_module._UnitScheduler(slots, width=24, work_steal=True)
        with_refill = self._loop(sched2, 24, refill_every_tick=True)
        assert without > with_refill, (without, with_refill)
        assert with_refill == 2

    def test_the_opening_wave_uses_every_lane_it_can(self, batch_module):
        """A 12-section book must put 12 lanes to work on the first claim."""
        slots = [_units(2) for _ in range(12)]
        sched = batch_module._UnitScheduler(slots, width=24, work_steal=True)
        used = 0
        for lane in range(24):
            claim = sched.claim()
            if claim is None:
                break
            sched.assign(lane, claim)
            used += 1
        assert used >= 12, f"only {used} of 24 lanes got work"


class TestEmptyTakesKeepTheirPlace:
    """A zero-frame take must leave a hole, not shift its neighbours.

    `assemble_slot_audio` indexes takes by **unit number**. Handing it a compacted
    list — which is what "drop the zero-frame units" produces — moves every later
    take onto the previous unit's pause and drops the last one, so one immediate
    `<|im_end|>` changes the rest of the section.
    """

    def test_decoded_takes_are_scattered_back_to_unit_indexes(self, batch_module):
        class _Take:
            def __init__(self, frames: int) -> None:
                self.shape = (2, frames)

        codes = [[_Take(5), _Take(0), _Take(7)]]  # unit 1 is empty
        present = [
            u for u, c in enumerate(codes[0]) if c is not None and c.shape[1] > 0
        ]
        assert present == [0, 2]
        # The engine scatters with `zip(present, decoded)`; model that here.
        decoded = ["take-0", "take-2"]
        takes: list = [None] * len(codes[0])
        for u, samples in zip(present, decoded):
            takes[u] = samples
        assert takes == ["take-0", None, "take-2"], (
            "a compacted list would be ['take-0', 'take-2'] and the third unit "
            "would inherit unit 1's pause"
        )

    def test_assembly_with_a_hole_keeps_the_following_units_pauses(self, batch_module):
        import numpy

        rate = 1000
        units = [
            {"text": "a", "pause": "sentence"},
            {"text": "b", "pause": "para"},
            {"text": "c", "pause": "para"},
        ]
        take = numpy.zeros(200, dtype=numpy.float32)
        take[0:10] = 0.5
        # Unit 1 produced nothing; unit 2 must still get its own trim and no
        # trailing pause.
        out = batch_module.assemble_slot_audio(units, [take, None, take], rate)
        # trim(~50) + sentence gap(400) + trim(~50), and nothing after the last.
        assert 480 <= len(out) <= 520, len(out)


class _Shape:
    """Stand-in for a tensor: the replay only reads its first dimension."""

    def __init__(self, shape) -> None:
        self.shape = tuple(shape)

    def clone(self):
        return self


class TestDecodeShapes:
    """The warm-up set and the post-restore replay set must be the same set.

    A CUDA graph is keyed by tensor shape, so "warm 32-wide at every KV bucket"
    leaves every narrower call to record its own graph on a customer's request.
    Both the snapshot warm-up and `publish()`'s replay walk `decode_shapes()`, so
    a mismatch cannot arise — but the *content* still has to be the product, and
    that is what these pin.
    """

    def test_shapes_are_the_width_by_kv_product(self, batch_module):
        engine = object.__new__(batch_module._BatchEngine)
        engine.model = types.SimpleNamespace(max_seq_len=batch_module.MAX_SEQ_LEN)
        engine.cfg = types.SimpleNamespace()
        widths = engine._warm_widths()
        shapes = engine.decode_shapes()
        kv = sorted({k for _, k in shapes})
        assert kv == sorted(batch_module.KV_BUCKETS)
        assert sorted({w for w, _ in shapes}) == sorted(widths)
        assert len(shapes) == len(widths) * len(batch_module.KV_BUCKETS)
        assert len(shapes) == len(set(shapes)), "no duplicate shapes"

    def test_v10_has_six_widths_and_four_kv_buckets(self, batch_module):
        engine = object.__new__(batch_module._BatchEngine)
        engine.model = types.SimpleNamespace(max_seq_len=batch_module.MAX_SEQ_LEN)
        engine.cfg = types.SimpleNamespace()
        assert len(engine._warm_widths()) == 6
        assert len(engine.decode_shapes()) == 24

    def test_the_kv_dimension_never_exceeds_the_cached_prefix(self, batch_module):
        """A small cache must shrink the buckets, not index past them."""
        engine = object.__new__(batch_module._BatchEngine)
        engine.model = types.SimpleNamespace(max_seq_len=700)
        engine.cfg = types.SimpleNamespace()
        shapes = engine.decode_shapes()
        assert all(kv <= 700 for _, kv in shapes), shapes
        # Only the buckets that fit remain, so replay cannot over-attend.
        assert sorted({k for _, k in shapes}) == [512]

    def test_replay_walks_every_shape_not_just_the_widest(self, batch_module):
        """`_replay_decode_shapes` must cover the product, not a sample of it.

        The first version replayed each *width* once at the longest KV prefix, so
        a restore that broke the 1-wide/512-token graph was invisible. This counts
        the steps it actually takes.
        """
        engine = object.__new__(batch_module._BatchEngine)
        engine.model = types.SimpleNamespace(max_seq_len=batch_module.MAX_SEQ_LEN)
        engine.cfg = types.SimpleNamespace(num_codebooks=2)
        engine.device = "cpu"
        engine.dtype = "f32"
        engine.device_name = "stub"
        engine.codec_stream = object()  # pretend a GPU so the guard passes
        engine.selftest_stats = {}
        engine._kv_cache_len = lambda: batch_module.MAX_SEQ_LEN
        # This suite installs a thinner torch stub than the codec-probe one, so
        # lend `s2_batch` the three constructors the replay uses. They only need
        # to report a shape: the fake step reads `x.shape[0]` and `kv_len`.
        sys.modules["torch"].full = lambda shape, value, **kw: _Shape(shape)
        sys.modules["torch"].zeros = lambda shape, **kw: _Shape(shape)
        sys.modules["torch"].tensor = lambda data, **kw: _Shape((1,))
        if not hasattr(sys.modules["torch"], "compiler"):
            sys.modules["torch"].compiler = types.SimpleNamespace(
                cudagraph_mark_step_begin=lambda: None
            )
        elif not hasattr(sys.modules["torch"].compiler, "cudagraph_mark_step_begin"):
            sys.modules["torch"].compiler.cudagraph_mark_step_begin = lambda: None

        stepped: list[tuple[int, int]] = []

        def fake_step(x, pos, kv_len, prev, temp, topp):
            stepped.append((int(x.shape[0]), int(kv_len)))
            return x

        engine.step = fake_step
        # torch.zeros is stubbed by this suite, so the loop's buffers are cheap.
        replayed = engine._replay_decode_shapes()
        assert replayed == len(engine.decode_shapes())
        assert sorted(set(stepped)) == sorted(engine.decode_shapes()), (
            "the replay must visit every warmed (width, kv) pair"
        )


class TestTheBatchWidthCountsAnchors:
    """`sum(len(units))` over-counts: a later unit waits for its section's anchor."""

    def test_a_one_section_two_unit_call_uses_one_lane(self, batch_module):
        """`firstLight` is one section with two units; only unit 0 can start."""
        width = batch_module.choose_batch_width(
            [[{"text": "a"}, {"text": "b"}]], work_steal=True
        )
        assert width == 1

    def test_the_formula_is_the_anchors_plus_the_stealable_remainder(self, batch_module):
        for sections, units, expected in (
            (1, 4, 4),   # one anchor, then three stolen
            (2, 2, 4),   # two anchors, then two stolen
            (3, 6, 16),  # three anchors, then fifteen stolen
            (8, 1, 8),   # no remainder: one lane per section
        ):
            slots = [_units(units) for _ in range(sections)]
            assert batch_module.choose_batch_width(slots, work_steal=True) == expected

    def test_work_stealing_is_off_when_the_anchor_is_off(self, batch_module, monkeypatch):
        """A unit depends on its predecessor when the anchor is off, so it cannot
        start early — the independence work-stealing relies on does not exist."""
        monkeypatch.setattr(batch_module, "HISTORY_ANCHOR_FIRST", False)
        sched = batch_module._UnitScheduler([_units(3)], width=8)
        assert sched.work_steal is False
