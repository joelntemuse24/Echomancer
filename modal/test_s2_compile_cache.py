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
    format_compile_cache_boot_log,
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


class _Volume:
    def __init__(self) -> None:
        self.commits = 0
        self.reloads = 0

    def commit(self) -> None:
        self.commits += 1

    def reload(self) -> None:
        self.reloads += 1
        raise AssertionError("reload() with open cache files fails the snapshot hook")


def _fields(**overrides):
    fields = {
        "torch_version": "2.5.1",
        "gpu_name": "H100",
        "compute_capability": "9.0",
        "engine": "v9",
        "code": "stamp",
    }
    fields.update(overrides)
    return fields


def _prepare(tmp_path, load_mega=None, **overrides):
    return prepare_compile_cache(
        str(tmp_path),
        environ={},
        load_mega=load_mega,
        **_fields(**overrides),
    )


def _publish(tmp_path, **overrides):
    cache = _prepare(tmp_path, **overrides)
    with open(os.path.join(cache.inductor_dir, "graph.bin"), "wb") as handle:
        handle.write(b"kernel")
    volume = _Volume()
    cache.finish(
        compile_s=1.0,
        volume=volume,
        save_mega=lambda path: open(path, "wb").write(b"mega"),
    )
    assert volume.reloads == 0
    assert volume.commits == 1
    return cache


def test_inductor_files_without_a_mega_cache_are_a_hit_only_after_publish(tmp_path):
    first = _prepare(tmp_path, engine="v10")
    with open(os.path.join(first.inductor_dir, "graph.bin"), "wb") as handle:
        handle.write(b"kernel")
    first.finish(compile_s=1.0, volume=_Volume(), save_mega=lambda _path: None)
    second = _prepare(
        tmp_path,
        engine="v10",
        load_mega=lambda _path: (_ for _ in ()).throw(AssertionError("no mega file")),
    )
    assert second.hit == "hit"
    assert second.fallback == ""
    assert second.key == first.key
    assert second.inductor_dir == first.inductor_dir
    assert second.persist is False


def test_unpublished_files_are_not_a_hit(tmp_path):
    first = _prepare(tmp_path)
    with open(os.path.join(first.inductor_dir, "graph.bin"), "wb") as handle:
        handle.write(b"kernel")
    with open(first.mega_path, "wb") as handle:
        handle.write(b"partial")
    second = _prepare(
        tmp_path,
        load_mega=lambda _path: (_ for _ in ()).throw(AssertionError("partial mega")),
    )
    assert second.hit == "miss"
    assert second.fallback == "empty"
    assert second.root != first.root
    assert os.path.isfile(os.path.join(first.inductor_dir, "graph.bin"))
    assert not os.path.exists(os.path.join(second.inductor_dir, "graph.bin"))


def test_corrupt_published_mega_compiles_a_new_run_and_keeps_the_old(tmp_path):
    cache = _publish(tmp_path)
    with open(cache.mega_path, "wb") as handle:
        handle.write(b"not-a-cache")

    def boom(_path: str) -> None:
        raise ValueError("bad magic")

    fresh = _prepare(tmp_path, load_mega=boom)
    assert fresh.hit == "miss"
    assert fresh.fallback == "corrupt"
    assert fresh.root != cache.root
    assert os.path.isfile(os.path.join(cache.inductor_dir, "graph.bin"))
    assert os.path.isdir(cache.root)
    assert not os.path.exists(os.path.join(fresh.inductor_dir, "graph.bin"))
    assert "fallback=corrupt" in fresh.log_line()


def test_a_loaded_mega_cache_is_a_hit(tmp_path):
    cache = _publish(tmp_path)
    seen: list[str] = []

    def load(path: str) -> None:
        seen.append(path)

    loaded = _prepare(tmp_path, load_mega=load)
    assert loaded.hit == "hit"
    assert loaded.fallback == ""
    assert loaded.persist is False
    assert seen == [cache.mega_path]


def test_unsupported_mega_api_keeps_inductor_files(tmp_path):
    cache = _publish(tmp_path)
    with open(os.path.join(cache.triton_dir, "kernel.cubin"), "wb") as handle:
        handle.write(b"cubin")

    def unsupported(_path: str) -> None:
        raise CompileCacheUnsupported("no mega-cache")

    loaded = _prepare(tmp_path, load_mega=unsupported)
    assert loaded.hit == "hit"
    assert loaded.fallback == "unsupported"
    assert os.path.isfile(os.path.join(loaded.triton_dir, "kernel.cubin"))
    assert loaded.root == cache.root


def test_mismatched_torch_gpu_engine_or_code_does_not_load(tmp_path):
    base = _publish(tmp_path)

    def refuse(_path: str) -> None:
        raise AssertionError("mismatched key loaded a mega-cache")

    for overrides in (
        {"torch_version": "2.6.0+cu124"},
        {"gpu_name": "NVIDIA H200"},
        {"compute_capability": "10.0"},
        {"engine": "v10"},
        {"code": "other-stamp"},
    ):
        nxt = _prepare(tmp_path, load_mega=refuse, **overrides)
        assert nxt.hit == "miss", overrides
        assert nxt.key != base.key
        assert nxt.root != base.root
    assert os.path.isfile(os.path.join(base.inductor_dir, "graph.bin"))


def test_two_compiles_publish_separate_runs(tmp_path):
    first = _prepare(tmp_path)
    second = _prepare(tmp_path)
    assert first.root != second.root
    with open(os.path.join(first.inductor_dir, "from-a.bin"), "wb") as handle:
        handle.write(b"a")
    with open(os.path.join(second.inductor_dir, "from-b.bin"), "wb") as handle:
        handle.write(b"b")
    first.finish(compile_s=1, volume=_Volume(), save_mega=lambda path: open(path, "wb").write(b"a"))
    second.finish(compile_s=1, volume=_Volume(), save_mega=lambda path: open(path, "wb").write(b"b"))
    assert os.path.isfile(os.path.join(first.inductor_dir, "from-a.bin"))
    assert not os.path.exists(os.path.join(first.inductor_dir, "from-b.bin"))
    assert os.path.isfile(os.path.join(second.inductor_dir, "from-b.bin"))
    seen: list[str] = []
    hit = _prepare(tmp_path, load_mega=lambda path: seen.append(path))
    assert hit.hit == "hit"
    assert hit.root == second.root
    assert seen == [second.mega_path]


def test_unstamped_code_does_not_read_the_volume(tmp_path):
    (tmp_path / "sentinel").write_text("keep")
    cache = prepare_compile_cache(
        str(tmp_path),
        torch_version="2.5.1",
        gpu_name="H100",
        compute_capability="9.0",
        engine="v9",
        code="",
        environ={},
        load_mega=lambda _path: (_ for _ in ()).throw(AssertionError("unstamped load")),
    )
    assert cache.hit == "miss"
    assert cache.persist is False
    assert cache.fallback == "unstamped"
    assert cache.inductor_dir == "/opt/torchinductor"
    assert [path.name for path in tmp_path.iterdir()] == ["sentinel"]


def test_code_stamp_hashes_the_compiled_module_and_codegen_flags():
    import hashlib
    import importlib

    from conftest import _install_modal_stub

    # ``modal/`` is a namespace on the test path and has no ``Image``. The
    # decode module only needs the stub to import; the stamp is the file bytes.
    _install_modal_stub()
    sys.modules.pop("s2_batch", None)
    s2_batch = importlib.import_module("s2_batch")

    from s2_compile_cache import _compile_flag_lines, _compiled_module_bytes

    raw = _compiled_module_bytes()
    assert b"def _attn_decode" in raw
    assert b"def _decode_step" in raw
    assert b"def _fast" in raw
    assert b"def _sample" in raw
    lines = _compile_flag_lines()
    assert any(line.startswith("sdpa=") for line in lines)
    assert any(line.startswith("topk=") for line in lines)
    expect = hashlib.sha256(
        "\n".join(["file=" + hashlib.sha256(raw).hexdigest(), *lines]).encode()
    ).hexdigest()[:16]
    assert code_stamp() == expect
    assert code_stamp() == code_stamp()
    edited = hashlib.sha256(raw + b"\n# attn changed\n").hexdigest()
    assert code_stamp(sources=["file=" + edited, *lines]) != expect
    assert code_stamp(sources=["same"], flags=["sdpa=0"]) != code_stamp(
        sources=["same"], flags=["sdpa=1"]
    )
    assert s2_batch.GPU == "H100!"


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
    manifest = json.loads(
        (tmp_path / cache.key / "runs" / cache.run_id / "manifest.json").read_text()
    )
    assert manifest["complete"] is True
    assert manifest["run"] == cache.run_id
    assert manifest["compile_s"] == pytest.approx(88.2)
    assert manifest["engine"] == "v10"
    assert manifest["compute_capability"] == "9.0"
    current = json.loads((tmp_path / cache.key / "current.json").read_text())
    assert current == {"key": cache.key, "run": cache.run_id, "complete": True}
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


def test_restore_log_does_not_look_like_a_fresh_compile():
    """A restored container reprints the snapshot report after graphs=ok.

    Book containers logged ``hit=miss fallback=empty compile_s=973.99`` on a
    boot that only restored. That line is the build's compile, not this one.
    """
    report = {
        "hit": "miss",
        "key": "torch-h100",
        "compile_s": 973.99,
        "fallback": "empty",
    }
    line = format_compile_cache_boot_log(report, boot="unknown")
    assert "compiled=no" in line
    assert "compile_s=na" in line
    assert "snapshot_compile_s=973.99" in line
    assert "snapshot_hit=miss" in line
    assert "snapshot_fallback=empty" in line
    assert "hit=miss key=" not in line
    restored = format_compile_cache_boot_log(report, boot="restored")
    assert restored.startswith("[S2C] compile_cache boot=restored ")
    missing = format_compile_cache_boot_log(None, boot="unknown")
    assert "compiled=no" in missing
    assert "snapshot_compile_s=na" in missing


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


def test_restore_check_rejects_zero_graphs_and_a_missing_cold_mark():
    def zero():
        return _status(graphs="ok(0)")

    assert run_restore_check(
        zero,
        sleep=lambda _s: (_ for _ in ()).throw(AssertionError("slept")),
        log=lambda _line: None,
    ) is False

    rows = [
        _status(since_ready_s=None),
        _status(since_ready_s=0.4, container_id="cold"),
    ]

    def place():
        return rows.pop(0)

    slept: list[float] = []
    assert run_restore_check(place, scaledown=15, sleep=slept.append, log=lambda _line: None)
    assert len(slept) == 1
    assert rows == []

    def no_wall():
        row = _status()
        row.pop("wall_s")
        return row

    assert run_restore_check(no_wall, log=lambda _line: None) is False


def test_restore_check_rejects_recapture_only_when_the_wall_is_not_a_restore():
    rows = [
        _status(wall_s=40.0, graphs="recaptured(24)", since_ready_s=2),
    ]

    def place():
        return rows.pop(0)

    assert run_restore_check(place, log=lambda _line: None) is True
