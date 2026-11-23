"""Trim the allocator before the snapshot is captured, and measure it.

`reset_state` clears the KV cache's *values*. It does not hand the blocks back
to the driver, so the warm-up's scratch is still reserved when Modal captures
the image — and every cached block is memory in that image. `empty_cache` before
the snapshot returns the unoccupied ones.

Two properties matter and are pinned here:

1. the trim never raises, because a container that cannot report its allocator
   is still a container that can speak, and a failed trim must not fail a build
   that is otherwise ready;
2. it reports what it did (`reserved_before_gb` / `reserved_after_gb`), so the
   effect is a measurement rather than a claim, and `S2B_SNAPSHOT_TRIM=0` is a
   real A/B control.
"""

from __future__ import annotations

import importlib
import sys
import types

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


@pytest.fixture(scope="module")
def batch():
    """`s2_batch` with the Modal API stubbed, as the rest of the suite does."""
    from test_s2_service_import import Recorder, _install_stubs

    _install_stubs(Recorder())
    sys.path.insert(0, str(MODAL_DIR))
    sys.modules.pop("s2_batch", None)
    module = importlib.import_module("s2_batch")
    yield module
    sys.path.remove(str(MODAL_DIR))
    for name in ("s2_batch", "s2_contract", "s2_mastering", "s2_clone_service"):
        sys.modules.pop(name, None)


def _engine(batch):
    """An engine with just the attributes `release_scratch` touches."""
    engine = object.__new__(batch._BatchEngine)
    return engine


class _FakeCuda:
    def __init__(self, *, before=70.0, after=62.0, available=True, explode=None):
        self.before = before * 1024**3
        self.after = after * 1024**3
        self.available = available
        self.explode = explode
        self.empty_calls = 0
        self.sync_calls = 0

    def is_available(self):
        return self.available

    def memory_reserved(self):
        return self.after if self.empty_calls else self.before

    def synchronize(self):
        self.sync_calls += 1

    def empty_cache(self):
        if self.explode:
            raise self.explode
        self.empty_calls += 1

    def ipc_collect(self):
        raise RuntimeError("no ipc on this box")


@pytest.fixture
def fake_torch(monkeypatch):
    def install(cuda):
        module = types.ModuleType("torch")
        module.cuda = cuda
        monkeypatch.setitem(sys.modules, "torch", module)
        return module

    return install


def test_it_returns_scratch_and_reports_both_sides(batch, fake_torch, monkeypatch):
    monkeypatch.delenv("S2B_SNAPSHOT_TRIM", raising=False)
    cuda = _FakeCuda(before=70.0, after=62.0)
    fake_torch(cuda)
    out = _engine(batch).release_scratch()
    assert out["trimmed"] is True
    assert out["reserved_before_gb"] == 70.0
    assert out["reserved_after_gb"] == 62.0
    assert out["freed_gb"] == 8.0
    assert cuda.empty_calls == 1
    # A synchronise before the trim, so the numbers describe settled memory.
    assert cuda.sync_calls == 1


def test_a_disabled_trim_does_not_touch_the_allocator(batch, fake_torch, monkeypatch):
    """`S2B_SNAPSHOT_TRIM=0` is the A/B control."""
    monkeypatch.setenv("S2B_SNAPSHOT_TRIM", "0")
    cuda = _FakeCuda()
    fake_torch(cuda)
    out = _engine(batch).release_scratch()
    assert out["trimmed"] is False
    assert out["reason"] == "disabled"
    assert cuda.empty_calls == 0


def test_a_failing_empty_cache_does_not_raise(batch, fake_torch, monkeypatch):
    monkeypatch.delenv("S2B_SNAPSHOT_TRIM", raising=False)
    fake_torch(_FakeCuda(explode=RuntimeError("allocator busy")))
    out = _engine(batch).release_scratch()
    assert out["trimmed"] is False
    assert "allocator busy" in out["reason"]


def test_no_cuda_is_not_an_error(batch, fake_torch, monkeypatch):
    monkeypatch.delenv("S2B_SNAPSHOT_TRIM", raising=False)
    fake_torch(_FakeCuda(available=False))
    out = _engine(batch).release_scratch()
    assert out["trimmed"] is False


def test_a_missing_ipc_collect_is_tolerated(batch, fake_torch, monkeypatch):
    """Single-process containers have no IPC handles; that is not a failure."""
    monkeypatch.delenv("S2B_SNAPSHOT_TRIM", raising=False)
    cuda = _FakeCuda()
    fake_torch(cuda)
    out = _engine(batch).release_scratch()
    # `ipc_collect` raises in the fixture, and the trim still succeeded.
    assert out["trimmed"] is True
    assert cuda.empty_calls == 1


def test_a_growing_reservation_reports_zero_freed(batch, fake_torch, monkeypatch):
    """`freed_gb` must not go negative if the allocator grew between reads."""
    monkeypatch.delenv("S2B_SNAPSHOT_TRIM", raising=False)
    fake_torch(_FakeCuda(before=60.0, after=64.0))
    out = _engine(batch).release_scratch()
    assert out["freed_gb"] == 0.0
    assert out["reserved_after_gb"] == 64.0


def test_the_kv_cache_is_roughly_eighteen_gib(batch):
    """The number the trim is measured against, not the 0.02 GB that was wrong."""
    from s2_contract import kv_cache_gb

    assert 15 < kv_cache_gb() < 22


def test_release_scratch_is_on_the_engine_not_the_handler(batch):
    """It touches the allocator, so it must run on the GPU-owning thread."""
    assert callable(getattr(batch._BatchEngine, "release_scratch", None))
    source = (MODAL_DIR / "s2_clone_service.py").read_text(encoding="utf-8")
    # Called inside the `init()` closure that runs on `self.gpu`, before the
    # snapshot hook returns.
    assert "self.engine.release_scratch()" in source
    init_body = source[source.index("def init() -> None:") : source.index("self.boot_started")]
    assert "release_scratch" in init_body, (
        "the trim must run inside the GPU-thread init, before the snapshot"
    )
