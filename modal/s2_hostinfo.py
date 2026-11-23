"""What host a GPU container actually landed on.

A page call that reports 8.8x instead of the 32x measured in staging is
indistinguishable from a page that was simply wider, a page whose codec
did not overlap, or a page that landed on a slower CPU next to the H100.
The container can answer the last one cheaply and honestly: which CPU, how
many cores, which GPU, which driver. Print it once at container start and
attach it to every `performance` block, so a slow call can be compared with
a fast one instead of guessed at.

Stdlib only, and every reader is optional. A missing `/proc` entry, a
sandboxed filesystem, or a `torch` that was never imported must degrade to
`null` rather than raise: this is diagnostics on the boot path, and a
container that cannot describe itself is still a container that can speak.
"""

from __future__ import annotations

import glob
import os
import platform
import sys

#: Where the driver publishes its own version. Present whenever the NVIDIA
#: kernel module is loaded, which is always the case for a GPU container.
_NVIDIA_VERSION = "/proc/driver/nvidia/version"
#: One directory per GPU, each with an `information` file whose `Model:` line
#: is the marketing name (e.g. `NVIDIA H100 80GB HBM3`).
_NVIDIA_GPU_GLOB = "/proc/driver/nvidia/gpus/*/information"
_CPUINFO = "/proc/cpuinfo"


def _read(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def cpu_model(cpuinfo_path: str = _CPUINFO) -> str | None:
    """The `model name` line of the first processor, trimmed.

    ARM kernels publish `model name` too, but some publish only `Model`, so
    both spellings are accepted. A name that is empty or longer than a
    sensible machine string is dropped rather than logged.
    """
    for line in _read(cpuinfo_path).splitlines():
        key, _, value = line.partition(":")
        if key.strip().lower() not in ("model name", "model"):
            continue
        name = value.strip()
        if not name:
            continue
        return name[:120]
    return None


def gpu_names(pattern: str = _NVIDIA_GPU_GLOB) -> list[str]:
    """Marketing names of the GPUs this container can see, in glob order."""
    names: list[str] = []
    for path in sorted(glob.glob(pattern)):
        for line in _read(path).splitlines():
            key, _, value = line.partition(":")
            if key.strip().lower() == "model" and value.strip():
                names.append(value.strip()[:120])
                break
    return names


def driver_version(version_path: str = _NVIDIA_VERSION) -> str | None:
    """The NVIDIA driver version from the kernel module banner.

    The file reads `NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.95.05
    <date>`, so the module version is the token after `Kernel Module`.
    """
    text = _read(version_path)
    marker = "Kernel Module"
    at = text.find(marker)
    if at < 0:
        return None
    rest = text[at + len(marker) :].split()
    return rest[0][:40] if rest else None


def _torch_info() -> dict:
    """`torch`/CUDA versions, but only when torch is already imported.

    Importing torch here would add seconds to a boot path that has not asked
    for it. By the time `host_report()` is called on the GPU thread torch is
    always in `sys.modules`, so this is free in practice and absent in a
    stdlib-only test.
    """
    module = sys.modules.get("torch")
    if module is None:
        return {}
    out: dict = {}
    version = getattr(module, "version", None)
    for key, attr in (("torch", "torch"), ("cuda", "cuda"), ("cudnn", "cudnn")):
        value = getattr(version, attr, None) if version is not None else None
        if value:
            out[key] = str(value)[:40]
    try:
        if getattr(module, "cuda", None) is not None and module.cuda.is_available():
            out.setdefault("gpu_count", int(module.cuda.device_count()))
    except Exception:
        pass
    return out


def host_report(
    *,
    cpuinfo_path: str = _CPUINFO,
    gpu_glob: str = _NVIDIA_GPU_GLOB,
    version_path: str = _NVIDIA_VERSION,
) -> dict:
    """A small, JSON-safe description of this container's machine.

    Never raises. Keys that cannot be read are omitted rather than set to a
    placeholder, so "we could not tell" is not reported as a value.
    """
    report: dict = {
        # Modal runs the app as pid 2 in a container of its own, so this is
        # not a claim about the cloud from an env var a caller could set.
        "cloud": "modal" if os.environ.get("MODAL_CONTAINER_ID") else None,
        "platform": f"{platform.system()}-{platform.release()}",
        "machine": platform.machine() or None,
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
    }
    model = cpu_model(cpuinfo_path)
    if model:
        report["cpu_model"] = model
    names = gpu_names(gpu_glob)
    if names:
        report["gpu"] = names[0]
        if len(names) > 1:
            report["gpus"] = names
    driver = driver_version(version_path)
    if driver:
        report["driver"] = driver
    report.update(_torch_info())
    return {key: value for key, value in report.items() if value is not None}


def host_report_line(report: dict | None) -> str:
    """One log line, so a container's machine is greppable in Modal's logs."""
    if not report:
        return "[S2C] host=unknown"
    parts = [f"{key}={report[key]}" for key in sorted(report)]
    return "[S2C] host " + " ".join(parts)
