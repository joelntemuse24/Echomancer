"""The boot-time codec probe must hand `decode_codes` a real code-tensor shape.

This is the offline guard for the staging failure on `ac93f4f`:

    RuntimeError: torch.cat(): expected a non-empty list of Tensors

`selftest()` passed `torch.zeros((1, num_codebooks))` — one row of ten columns.
`decode_codes` takes a list of *units*, and a unit is what `render` slices out of
the decode buffer as `frames[1:, :end]`, i.e. `(num_codebooks, T)`. A transposed
dummy still looks plausible, so nothing type-checks it; it fails at runtime
inside the codec, on **every** container start, before any snapshot exists.

The earlier offline tests missed it for a specific reason worth recording: the
service import test drives a *fake* engine, so `selftest` was never executed and
the codec was never asked for a shape. These tests call the real `selftest` and
inspect exactly what reaches `decode_codes`.

No GPU and no torch build are needed: a small stub implements the four
operations `selftest` uses (`zeros`, `mm`, `cuda.synchronize`, and the dtype
marker), and `decode_codes` itself is replaced by a recorder that validates the
shape the way the real codec would.
"""

from __future__ import annotations

import sys
import types

import pytest


# ── a torch stub with just enough surface for `selftest` ────────────────────


class _Tensor:
    def __init__(self, shape: tuple[int, ...]) -> None:
        self.shape = shape

    def __repr__(self) -> str:  # keeps assertion messages readable
        return f"Tensor{self.shape}"


def _install_torch_stub() -> None:
    """Install a torch stub that is a superset of what every modal suite needs.

    Whichever suite imports first wins, so this must satisfy all of them — and
    in particular it must **replace** a thinner stub another suite may already
    have installed. Relying on `setdefault` made these tests pass alone and fail
    in a combined run, which is the worst kind of failure: it depends on file
    order rather than on the code.
    """
    existing = sys.modules.get("torch")
    if existing is not None and hasattr(existing, "no_grad"):
        return  # a real torch is installed; use it
    torch = existing if existing is not None else types.ModuleType("torch")
    torch.long = "torch.long"
    torch.float32 = "torch.float32"

    def zeros(shape, device=None, dtype=None):
        return _Tensor(tuple(shape))

    def mm(a, b):
        # cuBLAS would reject a mismatch; keep that contract so a bad probe fails.
        if a.shape[-1] != b.shape[0]:
            raise RuntimeError(
                f"mat1 and mat2 shapes cannot be multiplied ({a.shape} and {b.shape})"
            )
        return _Tensor((a.shape[0], b.shape[1]))

    def manual_seed(value) -> None:
        return None

    class _Cuda:
        @staticmethod
        def synchronize() -> None:
            return None

        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def memory_reserved() -> int:
            return 0

        @staticmethod
        def init() -> None:
            return None

        @staticmethod
        def manual_seed_all(value) -> None:
            return None

    # This stub is the superset, so set its members unconditionally. Merging on
    # the `cuda` object alone is not enough: a thinner stub can already own that
    # attribute and simply lack one method, which is exactly how these tests
    # passed alone and failed combined.
    existing_cuda = getattr(torch, "cuda", None)
    cuda = _Cuda()
    for method in (
        "synchronize",
        "is_available",
        "memory_reserved",
        "init",
        "manual_seed_all",
    ):
        if existing_cuda is not None and hasattr(existing_cuda, method):
            setattr(cuda, method, getattr(existing_cuda, method))
    torch.cuda = cuda
    torch.zeros = zeros
    torch.mm = mm
    torch.manual_seed = manual_seed
    for name in ("long", "float32"):
        if not hasattr(torch, name):
            setattr(torch, name, name)
    sys.modules["torch"] = torch


@pytest.fixture(scope="module")
def batch_module():
    _install_torch_stub()
    modal_dir = __import__("pathlib").Path(__file__).parent
    sys.path.insert(0, str(modal_dir))
    # `s2_batch` builds a Modal Image at import time, so the Modal stub from the
    # service-import suite has to be in place first. Reusing it keeps one
    # definition of the stubbed API surface.
    from test_s2_service_import import Recorder, _install_stubs

    _install_stubs(Recorder())
    sys.modules.pop("s2_batch", None)
    module = __import__("importlib").import_module("s2_batch")
    yield module
    sys.path.remove(str(modal_dir))


# ── the shape contract ─────────────────────────────────────────────────────


def test_probe_codes_are_num_codebooks_by_frames(batch_module):
    codes = batch_module.codec_probe_codes(10)
    assert codes.shape == (10, batch_module.CODEC_PROBE_FRAMES)


def test_probe_codes_are_not_the_transposed_dummy_that_broke_staging(batch_module):
    """The exact regression: `(1, num_codebooks)` is not a code unit."""
    num_codebooks = 10
    codes = batch_module.codec_probe_codes(num_codebooks)
    assert codes.shape != (1, num_codebooks), (
        "a (1, num_codebooks) dummy makes decode_codes stack a 1-D row and die "
        "in torch.cat before the codec runs"
    )
    assert codes.shape[0] == num_codebooks


def test_probe_frames_is_short_but_non_empty(batch_module):
    # Zero frames would be the same class of bug as an empty list.
    assert 1 <= batch_module.CODEC_PROBE_FRAMES <= 32


def test_decode_codes_contract_matches_what_selftest_provides(batch_module):
    """`decode_codes` slices `c.shape[1]` and stacks, so a unit is 2-D."""
    import inspect

    source = inspect.getsource(batch_module._BatchEngine._decode_group_to_device)
    # It reads the time axis from shape[1] and pads along the last dim; a 1-D
    # unit would raise IndexError there instead of in torch.cat.
    assert "c.shape[1]" in source
    # And it expects a list of units, which is why selftest wraps its probe.
    # The grouping walks the length-sorted order in micro-batch steps.
    assert "range(0, len(order), micro_batch)" in source
    # `decode_codes` is still the entry point callers and selftest use.
    entry = inspect.getsource(batch_module._BatchEngine.decode_codes)
    assert "_decode_group_to_device" in entry


# ── the real selftest, executed ────────────────────────────────────────────


class _Wqkv:
    """Minimal stand-in for the attention projection that failed on staging."""

    def __init__(self, in_features: int) -> None:
        self.in_features = in_features

    def __call__(self, x):
        if x.shape[-1] != self.in_features:
            raise RuntimeError(
                f"wqkv expected {self.in_features} features, got {x.shape[-1]}"
            )
        return _Tensor((*x.shape[:-1], self.in_features))


class _Layer:
    def __init__(self, in_features: int) -> None:
        self.attention = types.SimpleNamespace(wqkv=_Wqkv(in_features))


class _ProbeEngine:
    """`selftest` with a recorded `decode_codes`, so we see the real shapes.

    Everything else on `_BatchEngine` is bypassed on purpose: loading S2-Pro
    needs a GPU, and the shape contract is what regressed.
    """

    def __init__(self, num_codebooks: int = 10, hidden: int = 32) -> None:
        # A real torch without CUDA (a CPU test machine) rejects `device="cuda"`
        # before `selftest` gets to the shapes these tests are about.
        _torch = sys.modules["torch"]
        usable = _torch.cuda.is_available() if hasattr(_torch, "cuda") else False
        self.device = "cuda" if usable else "cpu"
        # Whichever `torch` is in play — the stub (`bfloat16 == "bf16"`) or a
        # real one installed for another suite — `selftest` must be handed a
        # dtype object that module accepts.
        self.dtype = sys.modules["torch"].bfloat16
        self.device_name = "stub-gpu"
        self.cfg = types.SimpleNamespace(num_codebooks=num_codebooks)
        self.model = types.SimpleNamespace(layers=[_Layer(hidden)])
        self.decode_calls: list[list[_Tensor]] = []
        self._hidden = hidden

    def decode_codes(self, code_list, micro_batch: int = 8):
        self.decode_calls.append(code_list)
        out = []
        for unit in code_list:
            # Mirror the first two lines of the real implementation. A 1-D unit
            # raises here exactly as `torch.cat` did in production.
            if len(unit.shape) < 2:
                raise RuntimeError(
                    "torch.cat(): expected a non-empty list of Tensors"
                )
            longest = unit.shape[1]
            padded = _Tensor((1, unit.shape[0], longest))
            if padded.shape[1] != self.cfg.num_codebooks:
                raise RuntimeError(
                    f"codec got {padded.shape[1]} channels, expected "
                    f"{self.cfg.num_codebooks}"
                )
            out.append(padded)
        return out

    def selftest(self):
        # The real body, bound to this fake `self`.
        return _BatchEngine_selftest(self)


def _BatchEngine_selftest(engine):
    """Run the production `selftest` with `engine` as `self`."""
    import s2_batch

    return s2_batch._BatchEngine.selftest(engine)


def test_selftest_runs_and_reports(batch_module, capsys):
    engine = _ProbeEngine()
    stats = engine.selftest()
    assert stats["ok"] is True
    assert stats["device"] == "stub-gpu"
    assert "selftest_s" in stats
    # And it announced itself, which is what the staging log triage greps for.
    assert "selftest" in capsys.readouterr().out


def test_selftest_hands_decode_codes_one_correctly_shaped_unit(batch_module):
    """The assertion the staging failure needed.

    This is the test that would have caught `(1, num_codebooks)`: it inspects the
    tensor that actually reaches `decode_codes`, not a mock of the engine.
    """
    engine = _ProbeEngine(num_codebooks=10)
    engine.selftest()

    assert len(engine.decode_calls) == 2, "selftest probes the codec twice"
    units = engine.decode_calls[0]
    assert len(units) == 1, "the shape probe is a single unit, wrapped in a list"
    unit = units[0]
    assert unit.shape[0] == 10, (
        f"code unit must be (num_codebooks, T); got {unit.shape}"
    )
    assert unit.shape[1] >= 1, "a unit needs at least one frame"
    # The channel dim is what the codec consumes, so prove it survived stacking.
    assert unit.shape != (1, 10)
    # The second call is the uneven-length pair: one short unit and one three
    # times longer, which is what exercises sort + right-pad on one micro-batch.
    pair = engine.decode_calls[1]
    assert len(pair) == 2
    assert pair[0].shape[1] < pair[1].shape[1]
    assert all(unit.shape[0] == 10 for unit in pair)


@pytest.mark.parametrize("num_codebooks", [1, 8, 10, 16])
def test_selftest_scales_with_the_model_config(batch_module, num_codebooks):
    engine = _ProbeEngine(num_codebooks=num_codebooks)
    engine.selftest()
    unit = engine.decode_calls[0][0]
    assert unit.shape == (num_codebooks, batch_module.CODEC_PROBE_FRAMES)


def test_a_transposed_probe_is_rejected_not_just_different(batch_module):
    """Prove the guard has teeth: feed the old shape and require a failure."""
    engine = _ProbeEngine(num_codebooks=10)
    with pytest.raises(RuntimeError, match="torch.cat|channels"):
        # The pre-fix call, verbatim.
        engine.decode_codes([_Tensor((1, 10))])
