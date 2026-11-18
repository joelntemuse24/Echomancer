"""Compile-cache key, empty/corrupt fallback, and the one-call restore check.

No GPU and no Modal network. Load and save hooks stand in for torch.
"""

from __future__ import annotations

import json
import os
import sys

import pytest


@pytest.fixture(scope="module", autouse=True)
def _release_real_torch():
    """Do not leave a real torch import for the stubbed Modal suites.

    Cache prepare probes ``torch`` when it is installed, and the stamp reads
    ``s2_batch``. Those suites only install their torch stub when the name is
    absent, and a later test that finds the real module mutates it
    (``no_grad``) and then traces Inductor.
    """
    before = set(sys.modules)
    yield
    for name in list(sys.modules):
        if name in before:
            continue
        if (
            name == "torch"
            or name.startswith("torch.")
            or name in {"s2_batch", "s2_clone_service"}
        ):
            sys.modules.pop(name, None)

from s2_compile_cache import (
    COMPILE_CACHE_MOUNT,
    COMPILE_CACHE_VOLUME_NAME,
    CompileCacheUnsupported,
    _artifact_bytes,
    code_stamp,
    compile_cache_key,
    default_save_mega,
    format_compile_cache_log,
    prepare_compile_cache,
)
from s2_contract import (
    COLD_SINCE_READY_S,
    fresh_gap_s,
    run_restore_check,
)


def _key(**overrides) -> str:
    fields = {
        "torch_version": "2.5.1+cu124",
        "gpu_name": "NVIDIA H100 80GB HBM3",
        "compute_capability": "9.0",
        "engine": "v9",
        "code": "abc123",
    }
    fields.update(overrides)
    return compile_cache_key(**fields)


def test_cache_key_is_stable_and_filesystem_safe():
    assert _key() == _key()
    key = _key()
    assert "/" not in key and "\\" not in key and " " not in key
    assert key.count("--") == 1


def test_cache_key_changes_with_torch_gpu_capability_engine_and_code():
    base = _key()
    assert base != _key(torch_version="2.6.0+cu124")
    assert base != _key(gpu_name="NVIDIA H200")
    assert base != _key(compute_capability="9.1")
    assert base != _key(engine="v10")
    assert base != _key(code="def456")
    assert _key(engine="") != _key(engine="v10")


def test_code_stamp_tracks_source_and_ignores_order_only_when_equal():
    assert code_stamp(sources=["alpha", "beta"]) == code_stamp(sources=["alpha", "beta"])
    assert code_stamp(sources=["alpha"]) != code_stamp(sources=["alpha", "changed"])


def test_empty_volume_is_a_miss_and_points_env_at_the_key(tmp_path):
    env: dict[str, str] = {}
    cache = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="NVIDIA H100 80GB HBM3",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ=env,
        load_mega=lambda _path: (_ for _ in ()).throw(AssertionError("no mega-cache")),
    )
    assert cache.hit == "miss"
    assert cache.fallback == "empty"
    assert cache.persist is True
    assert os.path.isdir(cache.inductor_dir)
    assert os.path.isdir(cache.triton_dir)
    assert env["TORCHINDUCTOR_CACHE_DIR"] == cache.inductor_dir
    assert env["TRITON_CACHE_DIR"] == cache.triton_dir
    assert env["TORCHINDUCTOR_FX_GRAPH_CACHE"] == "1"
    assert env["TORCHINDUCTOR_AUTOGRAD_CACHE"] == "1"
    assert env["TORCHINDUCTOR_COMPILE_THREADS"] == "1"
    assert cache.key in cache.inductor_dir
    assert "compile_cache hit=miss" in cache.log_line()
    assert "fallback=empty" in cache.log_line()


def test_inductor_files_without_a_mega_cache_are_a_hit(tmp_path):
    env: dict[str, str] = {}
    first = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v10",
        code="stamp",
        environ=env,
    )
    with open(os.path.join(first.inductor_dir, "graph.bin"), "wb") as handle:
        handle.write(b"kernel")
    second = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v10",
        code="stamp",
        environ=env,
        load_mega=lambda _path: (_ for _ in ()).throw(AssertionError("no mega file")),
    )
    assert second.hit == "hit"
    assert second.fallback == ""
    assert second.key == first.key


def test_corrupt_mega_cache_is_quarantined_and_compiles_empty(tmp_path):
    env: dict[str, str] = {}
    cache = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ=env,
    )
    with open(os.path.join(cache.inductor_dir, "stale.bin"), "wb") as handle:
        handle.write(b"stale")
    with open(cache.mega_path, "wb") as handle:
        handle.write(b"not-a-cache")

    def boom(_path: str) -> None:
        raise ValueError("bad magic")

    fresh = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ=env,
        load_mega=boom,
    )
    assert fresh.hit == "miss"
    assert fresh.fallback == "corrupt"
    assert not os.path.exists(os.path.join(fresh.inductor_dir, "stale.bin"))
    quarantined = [
        name for name in os.listdir(tmp_path) if ".corrupt-" in name
    ]
    assert len(quarantined) == 1
    assert os.path.isdir(fresh.inductor_dir)
    assert env["TORCHINDUCTOR_CACHE_DIR"] == fresh.inductor_dir
    assert "fallback=corrupt" in fresh.log_line()


def test_a_loaded_mega_cache_is_a_hit(tmp_path):
    seen: list[str] = []

    def load(path: str) -> None:
        seen.append(path)

    cache = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ={},
    )
    with open(cache.mega_path, "wb") as handle:
        handle.write(b"artifacts")
    loaded = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ={},
        load_mega=load,
    )
    assert loaded.hit == "hit"
    assert loaded.fallback == ""
    assert seen == [cache.mega_path]


def test_unsupported_mega_api_keeps_inductor_files(tmp_path):
    cache = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ={},
    )
    with open(os.path.join(cache.triton_dir, "kernel.cubin"), "wb") as handle:
        handle.write(b"cubin")
    with open(cache.mega_path, "wb") as handle:
        handle.write(b"artifacts")

    def unsupported(_path: str) -> None:
        raise CompileCacheUnsupported("no mega-cache")

    loaded = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ={},
        load_mega=unsupported,
    )
    assert loaded.hit == "hit"
    assert loaded.fallback == "unsupported"
    assert os.path.isfile(os.path.join(loaded.triton_dir, "kernel.cubin"))


def test_unwritable_root_falls_back_without_raising(tmp_path):
    blocked = tmp_path / "not-a-dir"
    blocked.write_text("file")
    cache = prepare_compile_cache(
        str(blocked),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ={},
    )
    assert cache.hit == "miss"
    assert cache.persist is False
    assert cache.fallback.startswith("volume-")
    assert "compile_s=na" in cache.log_line()


def test_mega_cache_save_writes_bytes_from_the_torch_tuple(tmp_path, monkeypatch):
    """torch 2.15 returns ``(bytes, CacheInfo)``, not the bytes alone."""
    assert _artifact_bytes((b"cache-bytes", {"info": 1})) == b"cache-bytes"
    assert _artifact_bytes(b"plain") == b"plain"
    assert _artifact_bytes(None) is None
    assert _artifact_bytes((b"", None)) is None

    def save(*_args):
        if _args:
            raise TypeError("path is not accepted")
        return (b"cache-bytes", {"info": 1})

    monkeypatch.setattr(
        "s2_compile_cache._mega_api",
        lambda name: save if name == "save_cache_artifacts" else None,
    )
    path = tmp_path / "nested" / "mega-cache.bin"
    default_save_mega(str(path))
    assert path.read_bytes() == b"cache-bytes"


def test_disabled_switch_does_not_load_or_commit(tmp_path):
    loaded = False

    def load(_path: str) -> None:
        nonlocal loaded
        loaded = True

    env = {"S2C_COMPILE_CACHE": "0"}
    cache = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ=env,
        load_mega=load,
    )
    assert loaded is False
    assert cache.hit == "miss"
    assert cache.fallback == "disabled"
    assert cache.persist is False
    commits: list[str] = []

    class Volume:
        def commit(self) -> None:
            commits.append("commit")

    cache.finish(compile_s=12.5, volume=Volume(), save_mega=lambda _path: None)
    assert commits == []
    assert cache.compile_s == 12.5
    assert "hit=miss" in cache.log_line()
    assert "compile_s=12.50" in cache.log_line()
    assert list(tmp_path.iterdir()) == []


def test_finish_writes_manifest_and_commits(tmp_path):
    saved: list[str] = []
    commits: list[str] = []

    cache = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v10",
        code="stamp",
        environ={},
    )

    class Volume:
        def commit(self) -> None:
            commits.append(cache.key)

    cache.finish(
        compile_s=88.2,
        volume=Volume(),
        save_mega=lambda path: saved.append(path),
    )
    assert saved == [cache.mega_path]
    assert commits == [cache.key]
    assert cache.committed is True
    manifest = json.loads((tmp_path / cache.key / "manifest.json").read_text())
    assert manifest["compile_s"] == pytest.approx(88.2)
    assert manifest["engine"] == "v10"
    assert manifest["compute_capability"] == "9.0"
    assert "hit=miss" in format_compile_cache_log(cache.report())
    assert "compile_s=88.20" in format_compile_cache_log(cache.report())


def test_finish_survives_a_failing_save_and_a_failing_commit(tmp_path):
    cache = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="stamp",
        environ={},
    )

    class Volume:
        def commit(self) -> None:
            raise RuntimeError("volume down")

    def save(_path: str) -> None:
        raise OSError("disk full")

    cache.finish(compile_s=3, volume=Volume(), save_mega=save)
    assert cache.committed is False
    assert cache.compile_s == 3.0
    assert os.path.isfile(os.path.join(cache.root, "manifest.json"))


def test_startup_log_line_reports_hit_and_compile_seconds():
    line = format_compile_cache_log(
        {"hit": "hit", "key": "k", "compile_s": 4, "fallback": ""}
    )
    assert line == "[S2C] compile_cache hit=hit key=k compile_s=4.00 fallback=-"
    missing = format_compile_cache_log(None)
    assert missing.startswith("[S2C] compile_cache hit=miss ")
    assert "compile_s=na" in missing


def test_volume_name_and_mount_are_the_documented_ones():
    assert COMPILE_CACHE_VOLUME_NAME == "echomancer-compile-cache"
    assert COMPILE_CACHE_MOUNT == "/compile-cache"


def _status(**overrides):
    row = {
        "wall_s": 40.0,
        "graphs": "ok(24)",
        "boot": "unknown",
        "since_ready_s": 1.2,
        "container_id": "c1",
    }
    row.update(overrides)
    return row


def test_restore_check_passes_on_one_cold_restore():
    calls = []

    def place():
        calls.append("place")
        return _status()

    slept: list[float] = []
    assert run_restore_check(place, sleep=slept.append, log=lambda _line: None) is True
    assert calls == ["place"]
    assert slept == []


def test_restore_check_compiles_once_then_requires_one_cold_restore():
    rows = [
        _status(wall_s=900.0, since_ready_s=0.4, container_id="builder"),
        _status(wall_s=55.0, since_ready_s=0.8, container_id="restored"),
    ]

    def place():
        return rows.pop(0)

    slept: list[float] = []
    assert run_restore_check(place, scaledown=15, sleep=slept.append, log=lambda _line: None)
    assert rows == []
    assert slept == [fresh_gap_s(15)]


def test_restore_check_does_not_loop_when_the_second_call_compiles():
    rows = [
        _status(wall_s=400.0, graphs="ok(24)"),
        _status(wall_s=800.0, graphs="ok(24)", container_id="again"),
    ]

    def place():
        return rows.pop(0)

    assert run_restore_check(place, sleep=lambda _s: None, log=lambda _line: None) is False
    assert rows == []


def test_restore_check_fails_closed_on_missing_graphs_and_errors():
    def missing():
        return _status(graphs="skipped")

    assert run_restore_check(missing, sleep=lambda _s: (_ for _ in ()).throw(AssertionError("slept")), log=lambda _line: None) is False

    def errored():
        return {"error": "boom", "wall_s": 10}

    assert run_restore_check(errored, log=lambda _line: None) is False


def test_restore_check_treats_an_already_warm_container_as_not_cold():
    rows = [
        _status(since_ready_s=COLD_SINCE_READY_S + 5, container_id="warm"),
        _status(since_ready_s=0.5, container_id="cold", wall_s=48),
    ]

    def place():
        return rows.pop(0)

    slept: list[float] = []
    assert run_restore_check(place, scaledown=15, sleep=slept.append, log=lambda _line: None)
    assert len(slept) == 1
    assert rows == []


def test_restore_check_rejects_recapture_only_when_the_wall_is_not_a_restore():
    rows = [
        _status(wall_s=40.0, graphs="recaptured(24)", since_ready_s=2),
    ]

    def place():
        return rows.pop(0)

    assert run_restore_check(place, log=lambda _line: None) is True
