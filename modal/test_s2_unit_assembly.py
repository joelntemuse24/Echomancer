"""How a row's unit takes become one section file.

Two things here are load-bearing for how the finished book sounds, and neither
is visible from the text splitter alone:

1. **Where silence is inserted.** `_trim_silence` removes each take's own
   leading and trailing silence, so the pause spliced in afterwards *is* the gap
   a listener hears — and nothing else is. Pauses belong **between** units only;
   a pause after the last unit of a row is digital silence sitting in front of
   the app's crossfade join, which is heard as the narrator stopping before the
   next section starts.

2. **That the whole row is still there.** Longer units mean fewer, larger
   generations, so a bug that drops or reorders one is a bigger hole than it used
   to be. Every unit of every row must appear, in order.

Runs on a laptop: numpy is the only dependency, and the engine is replaced by a
fake that returns a click at a known offset per unit, so the assembled file can
be measured sample by sample. `s2_batch` is imported through the same Modal stub
the other suites use, because it imports `modal` at module scope.
"""

from __future__ import annotations

import contextlib
import importlib
import sys
import types

import pytest

numpy = pytest.importorskip("numpy")

MODAL_DIR = __import__("pathlib").Path(__file__).parent


# ── a minimal Modal / torch stub, enough to import `s2_batch` ───────────────


class _Object:
    @classmethod
    def from_name(cls, *args, **kwargs):
        return cls()

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return lambda *a, **k: self


class _Image:
    def __init__(self, *a, **k):
        pass

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return lambda *a, **k: self

    @staticmethod
    def imports():
        @contextlib.contextmanager
        def ctx():
            try:
                yield
            except ImportError:
                pass

        return ctx()


def _install_stubs() -> None:
    if "modal" not in sys.modules:
        modal = types.ModuleType("modal")
        modal.Image = types.SimpleNamespace(
            Image=_Image, debian_slim=staticmethod(lambda *a, **k: _Image())
        )
        modal.App = lambda *a, **k: types.SimpleNamespace(
            cls=lambda **kw: (lambda obj: obj),
            function=lambda **kw: (lambda obj: obj),
            local_entrypoint=lambda *a, **k: (lambda fn: fn),
        )
        modal.Volume = type("Volume", (_Object,), {})
        modal.Dict = type(
            "Dict",
            (_Object,),
            {"items": lambda self: [], "pop": lambda self, k, d=None: d},
        )
        modal.Secret = type("Secret", (_Object,), {})
        modal.enter = lambda *a, **k: (lambda fn: fn)
        modal.exit = lambda *a, **k: (lambda fn: fn)
        modal.method = lambda *a, **k: (lambda fn: fn)
        modal.fastapi_endpoint = lambda *a, **k: (lambda fn: fn)
        sys.modules["modal"] = modal

    if "torch" not in sys.modules:
        torch = types.ModuleType("torch")
        torch.long = "long"
        torch.float32 = "f32"
        torch.bfloat16 = "bf16"
        torch.cuda = types.SimpleNamespace(
            init=lambda: None,
            is_available=lambda: False,
            synchronize=lambda: None,
            get_device_name=lambda *a: "stub",
            manual_seed_all=lambda *a: None,
            memory_reserved=lambda: 0,
        )
        torch.device = lambda *a, **k: "cpu"
        torch.compile = lambda fn, **k: fn
        torch._inductor = types.SimpleNamespace(
            config=types.SimpleNamespace(
                triton=types.SimpleNamespace(cudagraph_dynamic_shape_warn_limit=None)
            )
        )
        torch.inference_mode = lambda: contextlib.nullcontext()
        torch.no_grad = lambda: contextlib.nullcontext()
        torch.autocast = lambda **k: contextlib.nullcontext()
        torch.manual_seed = lambda *a: None
        torch.zeros = lambda *a, **k: None
        torch.arange = lambda *a, **k: None
        torch.tensor = lambda *a, **k: None
        sys.modules["torch"] = torch


@pytest.fixture(scope="module")
def batch():
    sys.path.insert(0, str(MODAL_DIR))
    _install_stubs()
    return importlib.import_module("s2_batch")


#: One sample per millisecond, so a length in samples reads as a length in ms.
SR = 1000


def _assemble(batch_module, slots, takes, sample_rate=SR):
    """Run the production `decode_slots` with a pre-decoded take per unit.

    `takes` is aligned with `slots`: `takes[s][u]` is that unit's decoded
    samples, or `None` for a unit the decoder did not return. `decode_slots`
    flattens in exactly that order, so the fake decoder hands back the same
    samples in the same order.
    """
    codes = [
        [
            None if takes[s][u] is None else numpy.zeros((1, 1), dtype="int64")
            for u in range(len(units))
        ]
        for s, units in enumerate(slots)
    ]
    order = [
        (s, u)
        for s, units in enumerate(codes)
        for u in range(len(units))
        if codes[s][u] is not None
    ]
    engine = types.SimpleNamespace(
        sample_rate=sample_rate,
        decode_codes=lambda picked, micro_batch=8: [
            takes[s][u] for s, u in order[: len(picked)]
        ],
        _last_audio={},
    )
    return batch_module._BatchEngine.decode_slots(engine, codes, slots)


#: `_trim_silence` keeps the 10 ms analysis window that holds the click plus a
#: 40 ms margin on each side, so a click of this shape always measures TRIM_MS.
TRIM_MS = 50


def _take(ms=200, click_ms=10, amp=0.5):
    """Silence with a loud click at the start, so trimming is measurable."""
    audio = numpy.zeros(ms, dtype=numpy.float32)
    audio[:click_ms] = amp
    return audio


def _peaks(audio, sample_rate=SR):
    """One peak per surviving take, in order.

    The trim keeps a margin either side of the loud run, so each take is a short
    burst of near-zero samples followed by its click; the take boundary is where
    a run of exact silence (the inserted pause) separates them.
    """
    peaks: list[float] = []
    run: list[float] = []
    for value in audio:
        magnitude = abs(float(value))
        if magnitude > 0.05:
            run.append(magnitude)
        elif run:
            peaks.append(max(run))
            run = []
    if run:
        peaks.append(max(run))
    return peaks


class TestPauseInsertion:
    def test_pauses_are_inserted_between_units_only(self, batch):
        """No trailing pause after a row's last take.

        A trailing pause is pure padding: the app crossfades this row into the
        next section and the row already ends where the model stopped speaking.
        A paragraph-length block of digital silence first is heard as the
        narrator stopping.
        """
        slots = [[
            {"text": "One.", "pause": "para"},
            {"text": "Two.", "pause": "para"},
        ]]
        out = _assemble(batch, slots, [[_take(), _take()]])
        # Two trimmed takes plus one 0.96 s paragraph gap, and nothing after the
        # last take. A trailing pause would add another 960.
        expected = TRIM_MS + 960 + TRIM_MS
        assert len(out[0]) == pytest.approx(expected, abs=8), len(out[0])

    def test_a_single_unit_row_gets_no_pause_at_all(self, batch):
        # The common case now: a section under the ceiling is one take.
        slots = [[{"text": "The whole paragraph.", "pause": "para"}]]
        out = _assemble(batch, slots, [[_take()]])
        assert len(out[0]) == pytest.approx(TRIM_MS, abs=2), len(out[0])

    def test_every_unit_of_every_row_is_present_in_order(self, batch):
        slots = [
            [{"text": f"s0u{u}", "pause": "sentence"} for u in range(4)],
            [{"text": f"s1u{u}", "pause": "sentence"} for u in range(3)],
        ]
        # Distinct amplitude per unit so both presence and order are checkable.
        takes = [
            [_take(amp=0.1 * (1 + s * 10 + u)) for u in range(len(units))]
            for s, units in enumerate(slots)
        ]
        out = _assemble(batch, slots, takes)
        assert len(out) == 2
        for s, units in enumerate(slots):
            expected = [round(0.1 * (1 + s * 10 + u), 2) for u in range(len(units))]
            # One peak per take, in the order the units were rendered.
            assert [round(peak, 2) for peak in _peaks(out[s])] == expected

    @pytest.mark.parametrize(
        "kind,expected_ms",
        [("sentence", 400), ("clause", 220), ("para", 960), ("nonsense", 220)],
    )
    def test_the_inserted_gap_is_the_configured_one(self, batch, kind, expected_ms):
        slots = [[
            {"text": "One.", "pause": kind},
            {"text": "Two.", "pause": "para"},
        ]]
        out = _assemble(batch, slots, [[_take(), _take()]])
        expected = TRIM_MS * 2 + expected_ms
        assert len(out[0]) == pytest.approx(expected, abs=8), len(out[0])

    def test_a_missing_take_does_not_add_trailing_silence(self, batch):
        # One unit the decoder could not render: the row still ends cleanly.
        slots = [[{"text": f"u{u}", "pause": "para"} for u in range(3)]]
        out = _assemble(batch, slots, [[_take(), None, _take()]])
        expected = TRIM_MS + 960 + TRIM_MS
        assert len(out[0]) == pytest.approx(expected, abs=8), len(out[0])


class TestTrimSilence:
    def test_strips_leading_and_trailing_padding(self, batch):
        audio = numpy.zeros(500, dtype=numpy.float32)
        audio[100:300] = 0.5
        out = batch._trim_silence(audio, SR)
        # The 10 ms analysis window is kept whole, plus a 40 ms margin each side.
        assert 200 <= len(out) <= 280, len(out)
        assert float(numpy.max(numpy.abs(out))) == pytest.approx(0.5, abs=0.01)

    def test_a_fully_silent_take_is_returned_unchanged_not_dropped(self, batch):
        # Returning empty would silently remove a unit from the book.
        out = batch._trim_silence(numpy.zeros(500, dtype=numpy.float32), SR)
        assert len(out) == 500
