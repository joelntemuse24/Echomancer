"""Disk cache for the clone GPU's torch.compile / Inductor / Triton artifacts.

A new Modal memory snapshot (a deploy, or a different H100 worker variant)
otherwise repeats the whole compile. The kernels are content-addressed; what
was missing was a place they survive the container. This module puts them on
the ``echomancer-compile-cache`` volume, under a key of torch version, GPU
name, compute capability, ``S2C_ENGINE``, and a stamp of the compiled source.
A mismatched machine or a changed decode step never reads another key.

Empty, unreadable, and corrupt caches compile the ordinary way and are logged.
Nothing here raises into ``@modal.enter``: a cache fault must not take the book
down with it, and it must not skip the snapshot.

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

_TOKEN = re.compile(r"[^a-z0-9._+-]+")


class CompileCacheUnsupported(Exception):
    """This torch build has no ``torch.compiler`` mega-cache API."""


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


def code_stamp(*, sources: list[str] | None = None) -> str:
    """Stamp of the compiled decode step.

    Pass ``sources`` in tests. With no argument this reads the live engine, so
    a source change misses the cache even when ``S2C_ENGINE`` stays ``v9`` or
    ``v10``.
    """
    chunks = list(sources) if sources is not None else _engine_sources()
    return hashlib.sha256("\n".join(chunks).encode("utf-8")).hexdigest()[:16]


def _engine_sources() -> list[str]:
    import inspect

    import s2_batch as batch

    chunks = [
        f"engine={batch.ENGINE}",
        f"fast={int(batch.FAST_DECODE)}",
        f"codec={int(batch.CODEC_TUNING)}",
        f"graphs={int(batch.CUDAGRAPHS)}",
        f"batch={batch.BATCH}",
        f"kv={','.join(str(v) for v in batch.KV_BUCKETS)}",
        f"legacy={int(batch.LEGACY_RENDER)}",
    ]
    for name in ("_decode_step", "_embed", "_compile_step", "_logits_to_probs"):
        fn = getattr(batch._BatchEngine, name, None)
        try:
            chunks.append(inspect.getsource(fn) if fn is not None else f"{name}:missing")
        except (OSError, TypeError):
            chunks.append(f"{name}:unreadable")
    return chunks


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
            _write_manifest(self)
        except Exception as err:
            print(
                f"[S2C] compile_cache manifest failed: {type(err).__name__}: {err}"
            )
        if volume is None:
            return
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
    """Point Inductor and Triton at ``root/<key>`` and load a mega-cache.

    Never raises. An empty volume is a miss. A corrupt mega-cache is quarantined
    and the compile runs against an empty key directory.
    """
    env = os.environ if environ is None else environ
    try:
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
    cache = _cache_at(
        root,
        key,
        torch_version=torch_version,
        gpu_name=gpu_name,
        compute_capability=compute_capability,
        engine=engine,
        hit="miss",
        fallback="empty",
        persist=True,
    )
    os.makedirs(cache.inductor_dir, exist_ok=True)
    os.makedirs(cache.triton_dir, exist_ok=True)
    loader = load_mega or default_load_mega
    mega_state = "absent"
    if os.path.isfile(cache.mega_path) and os.path.getsize(cache.mega_path) > 0:
        try:
            loader(cache.mega_path)
            mega_state = "loaded"
        except CompileCacheUnsupported as err:
            mega_state = "unsupported"
            print(f"[S2C] compile_cache mega-cache unavailable: {err}")
        except Exception as err:
            mega_state = "corrupt"
            print(
                f"[S2C] compile_cache corrupt key={key}: {type(err).__name__}: {err}; "
                "quarantining and compiling from scratch"
            )
            _reset_compiler_state()
            _quarantine(cache.root)
            os.makedirs(cache.inductor_dir, exist_ok=True)
            os.makedirs(cache.triton_dir, exist_ok=True)
    if mega_state == "corrupt":
        cache.hit = "miss"
        cache.fallback = "corrupt"
    elif mega_state == "loaded" or _dirs_have_files(cache.inductor_dir, cache.triton_dir):
        cache.hit = "hit"
        cache.fallback = "" if mega_state != "unsupported" else "unsupported"
    else:
        cache.hit = "miss"
        cache.fallback = "unsupported" if mega_state == "unsupported" else "empty"
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
) -> CompileCache:
    base = os.path.join(root, key)
    return CompileCache(
        key=key,
        root=base,
        inductor_dir=os.path.join(base, "inductor"),
        triton_dir=os.path.join(base, "triton"),
        mega_path=os.path.join(base, MEGA_CACHE_NAME),
        hit=hit,
        fallback=fallback,
        persist=persist,
        torch_version=torch_version,
        gpu_name=gpu_name,
        compute_capability=compute_capability,
        engine=engine,
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
    _point_inductor_config(cache.inductor_dir)


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
    except Exception as err:
        print(f"[S2C] compile_cache inductor config skipped: {type(err).__name__}: {err}")


def _dirs_have_files(*paths: str) -> bool:
    for path in paths:
        if not path or not os.path.isdir(path):
            continue
        for _dir, _dirs, files in os.walk(path):
            if files:
                return True
    return False


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


def _quarantine(path: str) -> None:
    if not path or not os.path.exists(path):
        return
    dest = f"{path}.corrupt-{time.time_ns()}"
    try:
        os.rename(path, dest)
        print(f"[S2C] compile_cache quarantined {path} -> {dest}")
    except OSError as err:
        print(f"[S2C] compile_cache quarantine failed: {err}")
        raise


def _write_manifest(cache: CompileCache) -> None:
    if not cache.root:
        return
    os.makedirs(cache.root, exist_ok=True)
    payload = {
        "key": cache.key,
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
    """Load ``torch.compiler`` mega-cache bytes. Raises on a bad file."""
    load = _mega_api("load_cache_artifacts")
    if load is None:
        raise CompileCacheUnsupported(
            "torch.compiler.load_cache_artifacts is not available"
        )
    try:
        load(path)
        return
    except TypeError:
        pass
    with open(path, "rb") as handle:
        payload = handle.read()
    if not payload:
        raise ValueError("mega-cache is empty")
    load(payload)


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
    with open(path, "wb") as handle:
        handle.write(payload)


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
