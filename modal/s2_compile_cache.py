"""Disk cache for the clone GPU's torch.compile / Inductor / Triton artifacts.

A new Modal memory snapshot (a deploy, or a different H100 worker variant)
otherwise repeats the whole compile. The kernels are content-addressed; what
was missing was a place they survive the container. This module puts them on
the ``echomancer-compile-cache`` volume, under a key of torch version, GPU
name, compute capability, ``S2C_ENGINE``, and a stamp of the compiled source.
A mismatched machine or a changed decode step never reads another key.

A run is readable only after ``finish`` writes ``current.json``. That happens
after warm-up and self-test, so a crash mid-compile cannot be loaded.
``Volume.commit()`` runs in ``@modal.enter(snap=True)`` before the snapshot;
``reload()`` does not. A fresh container mounts the latest volume, and reload
fails while cache files are open. Published runs are left in place: deleting
volume files a snapshot restores from breaks the restore.

Empty and partial caches compile the ordinary way and are logged. A corrupt
mega-cache is left in place (a snapshot may still restore from that tree) but
Inductor and Triton files in the same published run are still used. A new run
directory is only for a published tree that has neither a loadable mega-cache
nor those files. Nothing here raises into ``@modal.enter``: a cache fault must
not take the book down with it, and it must not skip the snapshot. Two
compilers write distinct run directories and publish ``current.json`` last, so
they do not share files.

A different H100 worker variant builds its own memory snapshot. It still
reads this cache when the torch version, device name, and compute capability
match: the key includes those, and a hit points at the published run rather
than a fresh per-boot directory. ``TORCHINDUCTOR_CACHE_DIR`` is applied to
``torch._inductor.config`` as well as the environment, because Inductor reads
the directory at import and the image default is the local ``/opt/torchinductor``.

``S2C_COMPILE_CACHE=0`` keeps today's local ``/opt/torchinductor`` directory
and does not read or commit the volume.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Callable

COMPILE_CACHE_VOLUME_NAME = "echomancer-compile-cache"
COMPILE_CACHE_MOUNT = "/compile-cache"
#: Image-local directories used when the volume is missing, disabled, or corrupt
#: enough that we refuse to read it. These match the pre-volume layout.
LOCAL_INDUCTOR_DIR = "/opt/torchinductor"
LOCAL_TRITON_DIR = "/tmp/s2-triton-cache"
MEGA_CACHE_NAME = "mega-cache.bin"
MANIFEST_NAME = "manifest.json"
CURRENT_NAME = "current.json"
RUNS_DIR = "runs"

_TOKEN = re.compile(r"[^a-z0-9._+-]+")
_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


class CompileCacheUnsupported(Exception):
    """This torch build has no ``torch.compiler`` mega-cache API."""


class CompileCacheStampError(Exception):
    """The compiled source could not be stamped, so the volume must not be read."""


def _token(value: object) -> str:
    text = str(value or "").strip().lower()
    text = _TOKEN.sub("-", text).strip("-._")
    return text or "unknown"


def compile_cache_key(
    *,
    torch_version: str,
    gpu_name: str,
    compute_capability: str,
    engine: str,
    code: str,
) -> str:
    """Filesystem-safe cache key.

    The digest is the identity. The readable prefix is only so an operator can
    see why a directory exists; it is truncated, so two keys that share a
    prefix still differ in the hash.
    """
    canonical = "\n".join(
        (
            f"torch={_token(torch_version)}",
            f"gpu={_token(gpu_name)}",
            f"cc={_token(compute_capability)}",
            f"engine={_token(engine or 'v9')}",
            f"code={_token(code)}",
        )
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:20]
    readable = _token(
        "t{torch}-g{gpu}-c{cc}-e{engine}-k{code}".format(
            torch=_token(torch_version),
            gpu=_token(gpu_name),
            cc=_token(compute_capability),
            engine=_token(engine or "v9"),
            code=_token(code),
        )
    )[:80]
    key = f"{readable}--{digest}"
    if "/" in key or "\\" in key or key in (".", ".."):
        raise RuntimeError(f"compile cache key is not a single path segment: {key!r}")
    return key


def code_stamp(
    *, sources: list[str] | None = None, flags: list[str] | None = None
) -> str:
    """Stamp of the compiled decode step.

    Pass ``sources`` in tests. With no argument this hashes ``s2_batch.py``
    (the module ``torch.compile`` traces, including ``_attn_decode`` and the
    fast sampler) plus the codegen flags. A source change misses the cache
    even when ``S2C_ENGINE`` stays ``v9`` or ``v10``. An unreadable file raises
    ``CompileCacheStampError`` instead of sharing one ``unreadable`` key.
    """
    if sources is not None:
        chunks = list(sources)
    else:
        chunks = [_file_chunk(_compiled_module_bytes())]
    if flags is not None:
        chunks.extend(flags)
    elif sources is None:
        chunks.extend(_compile_flag_lines())
    if not chunks or any(not str(chunk).strip() for chunk in chunks):
        raise CompileCacheStampError("compile cache stamp has no source")
    return hashlib.sha256("\n".join(chunks).encode("utf-8")).hexdigest()[:16]


def _file_chunk(data: bytes) -> str:
    return "file=" + hashlib.sha256(data).hexdigest()


def _compiled_module_bytes() -> bytes:
    import s2_batch as batch

    path = getattr(batch, "__file__", None)
    if not path:
        raise CompileCacheStampError("s2_batch has no source file")
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError as err:
        raise CompileCacheStampError(f"s2_batch source unreadable: {err}") from err
    if (
        not data
        or b"def _decode_step" not in data
        or b"def _attn_decode" not in data
        or b"def _fast" not in data
    ):
        raise CompileCacheStampError("s2_batch source is not the compiled decode module")
    return data


def _compile_flag_lines() -> list[str]:
    """Env-selected codegen that does not show up as a source edit."""
    import s2_batch as batch

    flags = {
        "engine": batch.ENGINE,
        "fast": int(bool(batch.FAST_DECODE)),
        "codec": int(bool(batch.CODEC_TUNING)),
        "graphs": int(bool(batch.CUDAGRAPHS)),
        "batch": int(batch.BATCH),
        "kv": ",".join(str(int(v)) for v in batch.KV_BUCKETS),
        "legacy": int(bool(batch.LEGACY_RENDER)),
        "sdpa": int(bool(batch.SDPA_DECODE)),
        "topk": int(bool(batch.TOPK_FAST_SAMPLE)),
        "seq": int(batch.MAX_SEQ_LEN),
    }
    return [f"{name}={flags[name]}" for name in sorted(flags)]


def detect_compile_device(torch_mod=None) -> tuple[str, str, str]:
    """``(torch_version, gpu_name, compute_capability)``.

    CPU and a probe that throws become ``cpu`` / ``none`` (or ``unknown``),
    which is its own key and never aliases an H100 cache.
    """
    torch = torch_mod
    if torch is None:
        import torch as torch  # noqa: PLC0415
    version = str(getattr(torch, "__version__", "") or "unknown")
    cuda = getattr(torch, "cuda", None)
    available = getattr(cuda, "is_available", None)
    try:
        if cuda is None or not callable(available) or not available():
            return version, "cpu", "none"
        name = str(cuda.get_device_name(0))
        major, minor = cuda.get_device_capability(0)
        return version, name, f"{int(major)}.{int(minor)}"
    except Exception as err:
        print(
            f"[S2C] compile_cache device probe failed: {type(err).__name__}: {err}"
        )
        return version, "unknown", "unknown"


def format_compile_cache_log(report: dict | None) -> str:
    """The startup line. ``hit`` is ``hit`` or ``miss``; ``compile_s`` is seconds."""
    data = report or {}
    hit = data.get("hit")
    if hit not in ("hit", "miss"):
        hit = "miss"
    key = data.get("key") or "-"
    fallback = data.get("fallback") or "-"
    compile_s = data.get("compile_s")
    if compile_s is None:
        shown = "na"
    else:
        try:
            shown = f"{float(compile_s):.2f}"
        except (TypeError, ValueError):
            shown = "na"
    return (
        f"[S2C] compile_cache hit={hit} key={key} "
        f"compile_s={shown} fallback={fallback}"
    )


def cache_disabled(environ: dict | None = None) -> bool:
    env = os.environ if environ is None else environ
    return str(env.get("S2C_COMPILE_CACHE", "1")).strip() == "0"


@dataclass
class CompileCache:
    key: str
    root: str
    inductor_dir: str
    triton_dir: str
    mega_path: str
    hit: str
    fallback: str
    persist: bool
    torch_version: str = ""
    gpu_name: str = ""
    compute_capability: str = ""
    engine: str = ""
    compile_s: float | None = None
    committed: bool = False
    key_root: str = ""
    run_id: str = ""

    def report(self) -> dict:
        compile_s = None if self.compile_s is None else round(float(self.compile_s), 2)
        return {
            "hit": self.hit,
            "key": self.key,
            "fallback": self.fallback,
            "compile_s": compile_s,
        }

    def log_line(self) -> str:
        return format_compile_cache_log(self.report())

    def finish(
        self,
        *,
        compile_s: float,
        volume=None,
        save_mega: Callable[[str], None] | None = None,
    ) -> None:
        """Record compile seconds and, after a real compile, commit the volume.

        Called only once the snapshot path's warm-up and self-test have
        succeeded. A save or commit error is logged and swallowed.
        """
        try:
            self.compile_s = float(compile_s)
        except (TypeError, ValueError):
            self.compile_s = None
        print(self.log_line())
        if not self.persist or not self.root:
            return
        try:
            saver = save_mega or default_save_mega
            saver(self.mega_path)
        except CompileCacheUnsupported as err:
            print(f"[S2C] compile_cache mega-cache save skipped: {err}")
        except Exception as err:
            print(
                f"[S2C] compile_cache mega-cache save failed: "
                f"{type(err).__name__}: {err}"
            )
            if not self.fallback:
                self.fallback = f"save-{type(err).__name__}"
        try:
            _publish(self)
        except Exception as err:
            print(
                f"[S2C] compile_cache manifest failed: {type(err).__name__}: {err}"
            )
            return
        if volume is None:
            return
        # commit() only. reload() fails with "volume busy" while Inductor has
        # these files open, and that error inside enter(snap=True) would skip
        # the snapshot. A new container mounts the latest volume on its own.
        commit = getattr(volume, "commit", None)
        if not callable(commit):
            print("[S2C] compile_cache volume has no commit(); artifacts stay local")
            return
        try:
            commit()
            self.committed = True
            print(f"[S2C] compile_cache committed key={self.key}")
        except Exception as err:
            print(
                f"[S2C] compile_cache volume commit failed: "
                f"{type(err).__name__}: {err}"
            )


def prepare_compile_cache(
    root: str,
    *,
    torch_version: str,
    gpu_name: str,
    compute_capability: str,
    engine: str,
    code: str,
    environ: dict | None = None,
    load_mega: Callable[[str], None] | None = None,
) -> CompileCache:
    """Point Inductor and Triton at a published run under ``root/<key>``.

    Never raises. An empty or partial volume is a miss. A corrupt mega-cache
    is left in place. Inductor and Triton files in that published run are
    still used; a new run is only created when those directories are empty.
    """
    env = os.environ if environ is None else environ
    try:
        if not str(code or "").strip():
            cache = _local_cache(
                torch_version=torch_version,
                gpu_name=gpu_name,
                compute_capability=compute_capability,
                engine=engine,
                code="unstamped",
                fallback="unstamped",
                persist=False,
            )
            _point_cache_env(cache, env)
            print(cache.log_line())
            return cache
        if cache_disabled(env):
            cache = _local_cache(
                torch_version=torch_version,
                gpu_name=gpu_name,
                compute_capability=compute_capability,
                engine=engine,
                code=code,
                fallback="disabled",
                persist=False,
            )
            _point_cache_env(cache, env)
            print(cache.log_line())
            return cache
        return _prepare_compile_cache(
            root,
            torch_version=torch_version,
            gpu_name=gpu_name,
            compute_capability=compute_capability,
            engine=engine,
            code=code,
            environ=env,
            load_mega=load_mega,
        )
    except Exception as err:
        print(
            f"[S2C] compile_cache prepare failed: {type(err).__name__}: {err}; "
            "compiling without the volume"
        )
        cache = _local_cache(
            torch_version=torch_version,
            gpu_name=gpu_name,
            compute_capability=compute_capability,
            engine=engine,
            code=code,
            fallback=f"volume-{type(err).__name__}",
            persist=False,
        )
        try:
            _point_cache_env(cache, env)
        except Exception as point_err:
            print(
                f"[S2C] compile_cache local fallback failed: "
                f"{type(point_err).__name__}: {point_err}"
            )
        print(cache.log_line())
        return cache


def open_compile_cache(
    mount: str,
    *,
    engine: str,
    code: str,
    torch_mod=None,
    environ: dict | None = None,
    load_mega: Callable[[str], None] | None = None,
) -> CompileCache:
    """What ``@modal.enter(snap=True)`` calls before ``_BatchEngine``."""
    version, gpu, cc = detect_compile_device(torch_mod)
    return prepare_compile_cache(
        mount,
        torch_version=version,
        gpu_name=gpu,
        compute_capability=cc,
        engine=engine,
        code=code,
        environ=environ,
        load_mega=load_mega,
    )


def _prepare_compile_cache(
    root: str,
    *,
    torch_version: str,
    gpu_name: str,
    compute_capability: str,
    engine: str,
    code: str,
    environ: dict,
    load_mega: Callable[[str], None] | None,
) -> CompileCache:
    key = compile_cache_key(
        torch_version=torch_version,
        gpu_name=gpu_name,
        compute_capability=compute_capability,
        engine=engine,
        code=code,
    )
    key_root = os.path.join(root, key)
    published = _published_run(key_root, key)
    loader = load_mega or default_load_mega
    if published is not None:
        run_root, run_id = published
        cache = _cache_at(
            run_root,
            key,
            torch_version=torch_version,
            gpu_name=gpu_name,
            compute_capability=compute_capability,
            engine=engine,
            hit="miss",
            fallback="",
            persist=False,
            key_root=key_root,
            run_id=run_id,
        )
        # Point the process at this run before the mega-cache load.
        # torch 2.15 `cache_dir()` reads TORCHINDUCTOR_CACHE_DIR on every
        # call and `populate_cache` writes there. Loading first drops the
        # bytes into the image default (`/opt/torchinductor`), then the
        # retarget points compile at a directory those bytes never reached.
        had_files = _dirs_have_files(cache.inductor_dir, cache.triton_dir)
        _point_cache_env(cache, environ)
        mega_state = _try_mega(cache.mega_path, loader)
        # A failed load can write a partial file into the run. That file is
        # not a reason to reuse an otherwise empty tree.
        if mega_state == "loaded" or had_files:
            cache.hit = "hit"
            cache.persist = False
            if mega_state == "corrupt":
                cache.fallback = "mega-corrupt"
            elif mega_state == "unsupported":
                cache.fallback = "unsupported"
            else:
                cache.fallback = ""
            _point_cache_env(cache, environ)
            print(cache.log_line())
            return cache
        # Leave the published tree. A snapshot may still restore from it, and
        # Modal documents that deleting those files breaks the restore.
        print(
            f"[S2C] compile_cache published run unusable key={key} "
            f"mega={mega_state}; compiling a new run"
        )
        fallback = "corrupt" if mega_state == "corrupt" else (
            "unsupported" if mega_state == "unsupported" else "empty"
        )
    else:
        fallback = "empty"
    run_id = f"{time.time_ns()}-{os.getpid()}"
    if not _RUN_ID.match(run_id):
        raise RuntimeError(f"compile cache run id is not a single path segment: {run_id!r}")
    run_root = os.path.join(key_root, RUNS_DIR, run_id)
    cache = _cache_at(
        run_root,
        key,
        torch_version=torch_version,
        gpu_name=gpu_name,
        compute_capability=compute_capability,
        engine=engine,
        hit="miss",
        fallback=fallback,
        persist=True,
        key_root=key_root,
        run_id=run_id,
    )
    os.makedirs(cache.inductor_dir, exist_ok=True)
    os.makedirs(cache.triton_dir, exist_ok=True)
    _point_cache_env(cache, environ)
    print(cache.log_line())
    return cache


def _cache_at(
    root: str,
    key: str,
    *,
    torch_version: str,
    gpu_name: str,
    compute_capability: str,
    engine: str,
    hit: str,
    fallback: str,
    persist: bool,
    key_root: str = "",
    run_id: str = "",
) -> CompileCache:
    return CompileCache(
        key=key,
        root=root,
        inductor_dir=os.path.join(root, "inductor"),
        triton_dir=os.path.join(root, "triton"),
        mega_path=os.path.join(root, MEGA_CACHE_NAME),
        hit=hit,
        fallback=fallback,
        persist=persist,
        torch_version=torch_version,
        gpu_name=gpu_name,
        compute_capability=compute_capability,
        engine=engine,
        key_root=key_root,
        run_id=run_id,
    )


def _local_cache(
    *,
    torch_version: str,
    gpu_name: str,
    compute_capability: str,
    engine: str,
    code: str,
    fallback: str,
    persist: bool,
) -> CompileCache:
    try:
        key = compile_cache_key(
            torch_version=torch_version,
            gpu_name=gpu_name,
            compute_capability=compute_capability,
            engine=engine,
            code=code,
        )
    except Exception:
        key = "local"
    return CompileCache(
        key=key,
        root="",
        inductor_dir=LOCAL_INDUCTOR_DIR,
        triton_dir=LOCAL_TRITON_DIR,
        mega_path="",
        hit="miss",
        fallback=fallback,
        persist=persist,
        torch_version=torch_version,
        gpu_name=gpu_name,
        compute_capability=compute_capability,
        engine=engine,
    )


def _point_cache_env(cache: CompileCache, environ: dict) -> None:
    if cache.inductor_dir and _ensure_dir(cache.inductor_dir):
        environ["TORCHINDUCTOR_CACHE_DIR"] = cache.inductor_dir
    if cache.triton_dir and _ensure_dir(cache.triton_dir):
        environ["TRITON_CACHE_DIR"] = cache.triton_dir
    environ["TORCHINDUCTOR_FX_GRAPH_CACHE"] = "1"
    environ["TORCHINDUCTOR_AUTOGRAD_CACHE"] = "1"
    environ["TORCHINDUCTOR_COMPILE_THREADS"] = "1"
    # Inductor and Triton both snapshot these paths at import. The image env
    # points them at local directories, and `import torch` has already run by
    # the time a restored worker reaches this, so the config objects have to
    # be rewritten or a hit still compiles into /opt/torchinductor.
    _point_inductor_config(cache.inductor_dir)
    _point_triton_cache(cache.triton_dir)


def _ensure_dir(path: str) -> bool:
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as err:
        print(f"[S2C] compile_cache mkdir {path} failed: {err}")
        return False
    return True


def _point_inductor_config(cache_dir: str) -> None:
    """Some torch builds read the cache directory once into ``inductor.config``."""
    if not cache_dir:
        return
    try:
        import torch
    except Exception:
        return
    try:
        config = torch._inductor.config
    except Exception as err:
        print(f"[S2C] compile_cache inductor config unavailable: {type(err).__name__}: {err}")
        return
    try:
        if hasattr(config, "cache_dir"):
            config.cache_dir = cache_dir
        if hasattr(config, "fx_graph_cache"):
            config.fx_graph_cache = True
        if hasattr(config, "autograd_cache"):
            config.autograd_cache = True
    except Exception as err:
        print(f"[S2C] compile_cache inductor config skipped: {type(err).__name__}: {err}")


def _point_triton_cache(cache_dir: str) -> None:
    """Point Triton at ``cache_dir`` even when it was imported against the image default."""
    if not cache_dir:
        return
    try:
        import triton
    except Exception:
        return
    try:
        knobs = getattr(triton, "knobs", None)
        cache = getattr(knobs, "cache", None) if knobs is not None else None
        if cache is not None and hasattr(cache, "dir"):
            cache.dir = cache_dir
    except Exception as err:
        print(f"[S2C] compile_cache triton knobs skipped: {type(err).__name__}: {err}")
    try:
        from triton.runtime import cache as triton_cache
    except Exception:
        return
    try:
        for name in ("cache_dir", "default_cache_dir"):
            current = getattr(triton_cache, name, None)
            # Triton 3.8 reads the directory from knobs (set above). These
            # names, when present, are sometimes functions. Replacing a
            # function with a path string makes the next caller fail.
            if isinstance(current, str):
                setattr(triton_cache, name, cache_dir)
        for name in ("default_cache_manager", "file_cache_manager"):
            manager = getattr(triton_cache, name, None)
            if manager is not None and hasattr(manager, "cache_dir"):
                manager.cache_dir = cache_dir
    except Exception as err:
        print(f"[S2C] compile_cache triton cache skipped: {type(err).__name__}: {err}")


def _is_cache_artifact(name: str) -> bool:
    """A lock or a temp file is not a compiled kernel."""
    if not name or name.startswith("."):
        return False
    lowered = name.lower()
    return not (
        lowered.endswith(".lock") or lowered.endswith(".tmp") or lowered.endswith(".part")
    )


def _dirs_have_files(*paths: str) -> bool:
    for path in paths:
        if not path or not os.path.isdir(path):
            continue
        for _dir, _dirs, files in os.walk(path):
            if any(_is_cache_artifact(name) for name in files):
                return True
    return False


def _published_run(key_root: str, key: str) -> tuple[str, str] | None:
    """The run ``finish`` published, or None when nothing complete is there."""
    current = _read_json(os.path.join(key_root, CURRENT_NAME))
    if not current or current.get("complete") is not True or current.get("key") != key:
        return None
    run_id = str(current.get("run") or "")
    if not _RUN_ID.match(run_id):
        return None
    run_root = os.path.join(key_root, RUNS_DIR, run_id)
    if not _is_inside(key_root, run_root):
        return None
    manifest = _read_json(os.path.join(run_root, MANIFEST_NAME))
    if (
        not manifest
        or manifest.get("complete") is not True
        or manifest.get("key") != key
        or manifest.get("run") != run_id
    ):
        return None
    return run_root, run_id


def _is_inside(parent: str, child: str) -> bool:
    try:
        return os.path.commonpath(
            [os.path.abspath(parent), os.path.abspath(child)]
        ) == os.path.abspath(parent)
    except ValueError:
        return False


def _read_json(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _try_mega(path: str, loader: Callable[[str], None]) -> str:
    if not path or not os.path.isfile(path) or os.path.getsize(path) <= 0:
        return "absent"
    try:
        loader(path)
        return "loaded"
    except CompileCacheUnsupported as err:
        print(f"[S2C] compile_cache mega-cache unavailable: {err}")
        return "unsupported"
    except Exception as err:
        print(
            f"[S2C] compile_cache corrupt mega {path}: {type(err).__name__}: {err}"
        )
        _reset_compiler_state()
        return "corrupt"


def _run_usable(mega_state: str, inductor: str, triton: str) -> bool:
    """A loaded mega-cache is enough. Disk artifacts still count when it is not.

    A corrupt mega-cache used to force a fresh run directory, so the Inductor
    and Triton files sitting next to it were never read and ``compile_s`` stayed
    a full compile. Those files are the cache a different H100 worker variant
    can actually reuse. Only an empty tree starts a new run.
    """
    if mega_state == "loaded":
        return True
    return _dirs_have_files(inductor, triton)


def _publish(cache: CompileCache) -> None:
    """Point ``current.json`` at this run only after its manifest is in place."""
    if not cache.root or not cache.key_root or not _RUN_ID.match(cache.run_id):
        raise RuntimeError("compile cache run cannot be published")
    if not _is_inside(cache.key_root, cache.root):
        raise RuntimeError("compile cache run escapes its key")
    _write_manifest(cache)
    payload = {"key": cache.key, "run": cache.run_id, "complete": True}
    path = os.path.join(cache.key_root, CURRENT_NAME)
    tmp = os.path.join(cache.key_root, f".{CURRENT_NAME}.{cache.run_id}.tmp")
    os.makedirs(cache.key_root, exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _reset_compiler_state() -> None:
    """Drop a mega-cache load that failed part-way through.

    A corrupt file can mutate Inductor before it raises. Resetting Dynamo
    puts the process back on the ordinary compile path. Missing torch, or a
    torch build without Dynamo, is ignored.
    """
    try:
        import torch
    except Exception:
        return
    reset = getattr(getattr(torch, "_dynamo", None), "reset", None)
    if not callable(reset):
        return
    try:
        reset()
    except Exception as err:
        print(
            f"[S2C] compile_cache dynamo reset failed: {type(err).__name__}: {err}"
        )


def _write_manifest(cache: CompileCache) -> None:
    if not cache.root:
        return
    os.makedirs(cache.root, exist_ok=True)
    payload = {
        "key": cache.key,
        "run": cache.run_id,
        "complete": True,
        "hit": cache.hit,
        "fallback": cache.fallback,
        "compile_s": cache.compile_s,
        "torch": cache.torch_version,
        "gpu": cache.gpu_name,
        "compute_capability": cache.compute_capability,
        "engine": cache.engine,
        "written_at": time.time(),
    }
    path = os.path.join(cache.root, MANIFEST_NAME)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.replace(tmp, path)


def default_load_mega(path: str) -> None:
    """Load ``torch.compiler`` mega-cache bytes. Raises on a bad file.

    ``load_cache_artifacts`` unpickles its argument. Passing the path (a
    ``str``) raises ``TypeError: a bytes-like object is required, not 'str'``
    and does not install the cache, so a later compile is a full one even
    when the log said ``hit=hit``. The file is read in binary and only those
    bytes are passed.
    """
    load = _mega_api("load_cache_artifacts")
    if load is None:
        raise CompileCacheUnsupported(
            "torch.compiler.load_cache_artifacts is not available"
        )
    with open(path, "rb") as handle:
        payload = handle.read()
    if not isinstance(payload, (bytes, bytearray)) or len(payload) == 0:
        raise ValueError("mega-cache is empty")
    # torch 2.15 catches a bad payload inside deserialize and returns None
    # instead of raising. Treating that as a successful load logs hit=hit
    # and then compiles against an empty directory.
    loaded = load(bytes(payload))
    if loaded is None:
        raise ValueError("mega-cache was not installed")


def default_save_mega(path: str) -> None:
    """Write the mega-cache when this torch build can export one."""
    save = _mega_api("save_cache_artifacts")
    if save is None:
        raise CompileCacheUnsupported(
            "torch.compiler.save_cache_artifacts is not available"
        )
    saved = None
    try:
        saved = save(path)
    except TypeError:
        # torch 2.15: save_cache_artifacts() -> (bytes, CacheInfo) | None.
        saved = save()
    payload = _artifact_bytes(saved)
    if not payload:
        print("[S2C] compile_cache mega-cache save returned nothing")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _artifact_bytes(saved) -> bytes | None:
    """Bytes from ``save_cache_artifacts``.

    Torch 2.15 returns ``(bytes, CacheInfo)`` or ``None``. An older build may
    return the bytes directly. A path-accepting build may return ``None``
    after writing the file itself.
    """
    if isinstance(saved, tuple):
        saved = saved[0] if saved else None
    if isinstance(saved, (bytes, bytearray)) and len(saved) > 0:
        return bytes(saved)
    return None


def _mega_api(name: str):
    try:
        import torch
    except Exception:
        return None
    compiler = getattr(torch, "compiler", None)
    fn = getattr(compiler, name, None) if compiler is not None else None
    return fn if callable(fn) else None
