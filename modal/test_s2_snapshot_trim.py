"""What the snapshot is allowed to capture, and why that is a cost question.

A GPU memory snapshot is a copy of the process's CUDA address space, so every
allocator-cached block becomes pages that must be written on build and paged in
on restore. On 2026-11-22 a container spent ~7.5 minutes building a ~72 GB
image and billed 9.70 GPU-minutes for a book it never served, so the size of
that image is not a detail: it is the failure.

`reset_state` runs inside `@modal.enter(snap=True)`, immediately before Modal
captures the image. It already dropped the KV cache contents and the last audio
("cheap to rebuild", "one customer's speech"); it now also returns the
allocator's cached blocks to the driver, and reports what that gave back.

These tests are CPU-only and use a torch stub, because the rule under test is
"which calls are made, in what order, and what is published" — not numerics.
"""

from __future__ import annotations

import importlib
import sys
import types

import pytest


def _stub_modal() -> None:
    """`s2_batch` imports `modal` at module scope."""
    if "modal" in sys.modules and hasattr(sys.modules["modal"], "App"):
        return
    import contextlib

    class _Object:
        @classmethod
        def from_name(cls, *args, **kwargs):
            return cls()

    class _Image:
        def __init__(self, *a, **k):
            pass

        def __getattr__(self, name):
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

    modal = types.ModuleType("modal")
    modal.App = lambda *a, **k: types.SimpleNamespace(
        cls=lambda **kw: (lambda obj: obj),
        function=lambda **kw: (lambda obj: obj),
        local_entrypoint=lambda *a, **k: (lambda fn: fn),
    )
    modal.Image = types.SimpleNamespace(
        Image=_Image, debian_slim=staticmethod(lambda *a, **k: _Image())
    )
    modal.Volume = type("Volume", (_Object,), {})
    modal.Dict = type(
        "Dict", (_Object,), {"items": lambda self: [], "pop": lambda self, k, d=None: d}
    )
    modal.Secret = type("Secret", (_Object,), {})
    modal.enter = lambda *a, **k: (lambda fn: fn)
    modal.exit = lambda *a, **k: (lambda fn: fn)
    modal.method = lambda *a, **k: (lambda fn: fn)
    modal.fastapi_endpoint = lambda *a, **k: (lambda fn: fn)
    modal.concurrent = lambda *a, **k: (lambda fn: fn)
    modal.Cron = lambda *a, **k: None
    sys.modules.setdefault("modal", modal)


def _load_batch(monkeypatch, *, trim: str | None, torch_mod=None):
    _stub_modal()
    if trim is None:
        monkeypatch.delenv("S2B_SNAPSHOT_TRIM", raising=False)
    else:
        monkeypatch.setenv("S2B_SNAPSHOT_TRIM", trim)
    if torch_mod is not None:
        monkeypatch.setitem(sys.modules, "torch", torch_mod)
    sys.modules.pop("s2_batch", None)
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        return importlib.import_module("s2_batch")
    finally:
        sys.path.remove(str(Path(__file__).resolve().parent))


class _FakeTensor:
    def zero_(self) -> "_FakeTensor":
        return self


class _FakeCache:
    def __init__(self) -> None:
        self.k_cache = _FakeTensor()
        self.v_cache = _FakeTensor()


class _FakeAttention:
    def __init__(self) -> None:
        self.kv_cache = _FakeCache()


class _FakeLayer:
    def __init__(self) -> None:
        self.attention = _FakeAttention()


class _FakeModel:
    def __init__(self, layers: int = 3) -> None:
        self.layers = [_FakeLayer() for _ in range(layers)]


def _engine(batch, with_model: bool = True) -> object:
    engine = object.__new__(batch._BatchEngine)
    engine._last_audio = {"stale": object()}
    engine.model = _FakeModel() if with_model else None
    return engine


def _torch_with_allocator(*, available: bool, before: int, after: int):
    calls: list[str] = []

    class _Cuda:
        """Models a real allocator: `empty_cache()` makes reserved drop."""

        def __init__(self) -> None:
            self.reserved = before

        def is_available(self) -> bool:
            return available

        def memory_reserved(self) -> int:
            return self.reserved

        def empty_cache(self) -> None:
            calls.append("empty_cache")
            self.reserved = after

    torch = types.ModuleType("torch")
    torch.cuda = _Cuda()
    return torch, calls


def test_reset_state_releases_cached_blocks_before_the_snapshot(monkeypatch):
    """The image should not carry the warm-up's scratch allocations.

    Weights and captured graphs are live and cannot be released; the blocks the
    warm-up used for prompt prep and codec probes are dead by this point. Handing
    them back is the only lever this code has on the image size, and the reported
    pair is what an operator needs to decide whether more is possible.
    """
    torch, calls = _torch_with_allocator(available=True, before=72_000_000_000, after=61_500_000_000)
    batch = _load_batch(monkeypatch, trim=None, torch_mod=torch)
    engine = _engine(batch)

    engine.reset_state()

    assert calls == ["empty_cache"]
    assert engine.snapshot_trim == {
        "reserved_before_gb": 72.0,
        "reserved_after_gb": 61.5,
    }
    assert engine._last_audio == {}


def test_reset_state_reports_no_trim_when_the_allocator_keeps_everything(monkeypatch):
    """A trim that frees nothing must say so, not claim a win."""
    torch, calls = _torch_with_allocator(available=True, before=72_000_000_000, after=72_000_000_000)
    batch = _load_batch(monkeypatch, trim=None, torch_mod=torch)
    engine = _engine(batch)

    engine.reset_state()

    assert calls == ["empty_cache"]
    assert engine.snapshot_trim["reserved_before_gb"] == 72.0
    assert engine.snapshot_trim["reserved_after_gb"] == 72.0


def test_snapshot_trim_off_restores_the_old_behaviour(monkeypatch):
    """`S2B_SNAPSHOT_TRIM=0` is the A/B switch for image size."""
    torch, calls = _torch_with_allocator(available=True, before=1, after=1)
    batch = _load_batch(monkeypatch, trim="0", torch_mod=torch)
    engine = _engine(batch)

    engine.reset_state()

    assert calls == []
    assert not hasattr(engine, "snapshot_trim")


def test_reset_state_still_clears_state_with_no_model_or_cuda(monkeypatch):
    """CPU and stubbed suites must not fail on a missing allocator."""
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)
    batch = _load_batch(monkeypatch, trim=None, torch_mod=torch)
    engine = _engine(batch, with_model=False)

    engine.reset_state()

    assert engine._last_audio == {}
    assert not hasattr(engine, "snapshot_trim")


def test_snapshot_trim_survives_an_allocator_that_raises(monkeypatch):
    """A trim is an optimisation; it must never fail the snapshot hook."""

    def boom() -> None:
        raise RuntimeError("allocator is unhappy")

    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: True,
        memory_reserved=lambda: 1,
        empty_cache=boom,
    )
    batch = _load_batch(monkeypatch, trim=None, torch_mod=torch)
    engine = _engine(batch)

    engine.reset_state()  # must not raise

    assert engine._last_audio == {}
    assert not hasattr(engine, "snapshot_trim")
