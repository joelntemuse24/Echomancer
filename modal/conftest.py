"""Shared fixtures for the Modal suites.

The container reads its decode-path switches once, at import, because they are
baked into a GPU snapshot. So a test that wants a particular engine must set
`S2C_ENGINE` **before** `s2_batch` is imported, and the module has to be loaded
fresh per engine.

That is what `engine` does: it imports `s2_batch` with `S2C_ENGINE=v9` or
`v10`, evicts it afterwards, and leaves the process as it found it. Without it
a suite silently tests whichever engine a previous file happened to import,
which is the sort of order-dependent failure that hides a real regression.

The environment is restored on teardown, so no test can leak a switch into
another.
"""

from __future__ import annotations

import importlib
import os
import sys
import types

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent

#: Every switch this build reads at import. Cleared before each engine import so
#: a leftover value from the shell cannot change what a test is measuring.
_ENGINE_ENV = (
    "S2C_ENGINE",
    "S2B_BUCKET",
    "S2B_WORK_STEAL",
    "S2B_EOS_CHECK_EVERY",
    "S2B_SDPA_DECODE",
    "S2B_TOPK_FAST_SAMPLE",
    "S2B_DAC_MICRO_BATCH",
    "S2B_PIPELINE_CODEC",
    "S2B_CODEC_TUNING",
    "S2B_FAST_DECODE",
    "S2B_BATCHED_PREFILL",
    "S2B_KV_BUCKET",
    "S2B_BATCH",
    "S2B_CUDAGRAPHS",
)


def _install_modal_stub() -> None:
    """The Modal API surface `s2_batch` touches at import time."""
    if "modal" in sys.modules and hasattr(sys.modules["modal"], "App"):
        return

    import contextlib

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


@pytest.fixture(scope="session")
def modal_stub():
    _install_modal_stub()
    return sys.modules["modal"]


@pytest.fixture
def engine(request, monkeypatch):
    """Import `s2_batch` for one engine: `@pytest.mark.engine("v10")`.

    Yields the fresh module. The module is evicted afterwards so the next test
    imports its own engine rather than inheriting this one's flags.
    """
    name = request.node.get_closest_marker("engine")
    engine_name = name.args[0] if name and name.args else "v9"
    for key in _ENGINE_ENV:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("S2C_ENGINE", engine_name)
    _install_modal_stub()
    sys.path.insert(0, str(MODAL_DIR))
    sys.modules.pop("s2_batch", None)
    try:
        module = importlib.import_module("s2_batch")
        yield module
    finally:
        sys.modules.pop("s2_batch", None)
        sys.path.remove(str(MODAL_DIR))
        for key in _ENGINE_ENV:
            os.environ.pop(key, None)


def pytest_configure(config) -> None:
    config.addinivalue_line(
        "markers", "engine(name): import s2_batch with S2C_ENGINE=name"
    )
