"""The read-only snapshot preflight an owner runs before taking traffic.

A deploy (and a Modal eviction) invalidates every GPU memory snapshot. When a
book is the next thing to arrive, it pays to build one: on 2026-11-22 that was
~7.5 minutes of H100 time and 9.70 billed GPU-minutes for a book that never
heard a word.

`snapshot_state` is the check that makes that visible *before* a customer
arrives. It must be strictly read-only — no container start, no autoscaler
write, no GPU input — because its whole purpose is to avoid spending money.
These tests pin that, and pin what an operator is told in each case.
"""

from __future__ import annotations

import importlib
import sys
import types

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


@pytest.fixture(scope="module")
def warm_mod():
    from test_s2_service_import import Recorder, _install_stubs

    recorder = Recorder()
    _install_stubs(recorder)
    sys.path.insert(0, str(MODAL_DIR))
    for name in ("s2_contract", "s2_batch", "s2_mastering", "s2_clone_service", "s2_clone_warm"):
        sys.modules.pop(name, None)
    module = importlib.import_module("s2_clone_warm")
    module._recorder = recorder  # type: ignore[attr-defined]
    yield module
    sys.path.remove(str(MODAL_DIR))


def _run(warm_mod, monkeypatch, body):
    """Invoke the entrypoint body with `Function.from_name` stubbed.

    Returns (exit_code, stdout, stderr). `SystemExit` is how the entrypoint
    reports "not ready", which is what a wrapper checks.
    """
    import contextlib
    import io

    calls: list[tuple[str, str]] = []

    class _Function:
        @classmethod
        def from_name(cls, app, name):
            calls.append((app, name))
            return cls()

        def remote(self):
            return body

    fake = types.SimpleNamespace(Function=_Function)
    # The entrypoint imports `modal` inside its own body, so the module global
    # is not what it reads. Patch the `modal` module that import resolves to.
    monkeypatch.setattr(sys.modules["modal"], "Function", _Function, raising=False)

    out, err = io.StringIO(), io.StringIO()
    code = 0
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            warm_mod.snapshot_state()
        except SystemExit as exit_:
            code = int(exit_.code or 0)
    return code, out.getvalue(), err.getvalue(), calls


def test_warm_snapshot_exits_zero_and_reads_only_the_cpu_function(warm_mod, monkeypatch):
    body = {
        "ready": True,
        "warm_containers": 1,
        "starting_containers": 0,
        "max_containers": 1,
        "build": "abc123",
    }
    code, out, _err, calls = _run(warm_mod, monkeypatch, body)

    assert code == 0
    assert "warm=1" in out
    assert "starting=0" in out
    assert "ready: a restored container" in out
    # It read the CPU `ready` function, and nothing on the GPU class.
    assert [name for _app, name in calls] == ["ready"]


def test_no_snapshot_fails_and_names_the_consequence(warm_mod, monkeypatch):
    """The incident in one line: a book placed now would build one."""
    body = {
        "ready": False,
        "warm_containers": 0,
        "starting_containers": 0,
        "max_containers": 1,
    }
    code, _out, err, _calls = _run(warm_mod, monkeypatch, body)

    assert code == 1
    assert "NO WARM SNAPSHOT" in err
    assert "build one on the customer's bill" in err


def test_a_build_in_progress_is_reported_as_waiting(warm_mod, monkeypatch):
    body = {
        "ready": False,
        "warm_containers": 0,
        "starting_containers": 1,
        "max_containers": 1,
    }
    code, out, err, _calls = _run(warm_mod, monkeypatch, body)

    assert code == 1
    assert "starting=1" in out
    assert "wait behind the build in progress" in err


def test_a_json_bytes_body_is_understood(warm_mod, monkeypatch):
    """`/ready` may arrive as raw bytes through a different client path."""
    import json

    body = json.dumps(
        {
            "ready": True,
            "warm_containers": 2,
            "starting_containers": 0,
            "max_containers": 1,
            "build": "abc123",
        }
    ).encode()
    code, out, _err, _calls = _run(warm_mod, monkeypatch, body)

    assert code == 0
    assert "warm=2" in out


def test_an_unexpected_body_fails_rather_than_guessing(warm_mod, monkeypatch):
    code, _out, err, _calls = _run(warm_mod, monkeypatch, "not a payload")

    assert code == 1
    assert "unexpected /ready body" in err


def test_the_preflight_never_names_a_gpu_method(warm_mod):
    """A read-only preflight must not be able to start a container."""
    import inspect
    import re

    source = inspect.getsource(warm_mod.snapshot_state)
    assert "Function.from_name" in source
    for forbidden in ("Cls.from_name", ".spawn(", ".remote(", "render_batch", "update_autoscaler"):
        # `.remote()` on the CPU `ready` function is the one allowed read.
        if forbidden == ".remote(":
            continue
        assert forbidden not in source, forbidden
    # And it must not reference the GPU class at all.
    assert "CLASS_NAME" not in source
