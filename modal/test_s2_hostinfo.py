"""The boot host report is diagnostics, and diagnostics must never be fatal.

A page that renders at 8.8x on production and 32x on staging is otherwise
indistinguishable from a wider page, a page whose codec did not overlap, or a
page that landed next to a slower CPU. The report answers "which machine" and
these tests pin the two properties that make it safe to call from a boot hook:

1. it reads what `/proc` actually publishes (CPU model, GPU name, driver);
2. a missing file, an unreadable directory, or a malformed line degrades to
   an omitted key rather than an exception, because a container that cannot
   describe itself is still a container that can speak.
"""

from __future__ import annotations

import importlib
import sys

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


@pytest.fixture(scope="module")
def hostinfo():
    sys.path.insert(0, str(MODAL_DIR))
    sys.modules.pop("s2_hostinfo", None)
    module = importlib.import_module("s2_hostinfo")
    yield module
    sys.path.remove(str(MODAL_DIR))
    sys.modules.pop("s2_hostinfo", None)


_CPUINFO = """\
processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz
cpu MHz\t\t: 2600.000

processor\t: 1
model name\t: Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz
"""

_GPU_INFO = """\
IRQ: 0
Model:           NVIDIA H100 80GB HBM3
GPU UUID:        GPU-00000000-0000-0000-0000-000000000000
Bus Location:    00000000:07:00.0
"""

_NVIDIA_VERSION = """\
NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.95.05  Fri Sep 26 2025
GCC version:  gcc version 13.3.0
"""


def _write(tmp_path, name: str, text: str):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_cpu_model_reads_the_first_model_name_line(hostinfo, tmp_path):
    path = _write(tmp_path, "cpuinfo", _CPUINFO)
    assert hostinfo.cpu_model(path) == "Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz"


def test_cpu_model_accepts_the_arm_spelling(hostinfo, tmp_path):
    path = _write(tmp_path, "cpuinfo", "processor\t: 0\nModel\t\t: Cortex-A78AE\n")
    assert hostinfo.cpu_model(path) == "Cortex-A78AE"


def test_cpu_model_is_none_for_a_missing_file(hostinfo, tmp_path):
    assert hostinfo.cpu_model(str(tmp_path / "absent")) is None


def test_cpu_model_is_none_when_no_line_matches(hostinfo, tmp_path):
    path = _write(tmp_path, "cpuinfo", "processor\t: 0\nbogomips\t: 100\n")
    assert hostinfo.cpu_model(path) is None


def test_gpu_names_reads_each_information_file(hostinfo, tmp_path):
    first = tmp_path / "gpus" / "0000:07:00.0"
    second = tmp_path / "gpus" / "0000:0b:00.0"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    (first / "information").write_text(_GPU_INFO, encoding="utf-8")
    (second / "information").write_text(
        _GPU_INFO.replace("H100 80GB HBM3", "H100 80GB HBM3"), encoding="utf-8"
    )
    names = hostinfo.gpu_names(str(tmp_path / "gpus" / "*" / "information"))
    assert names == ["NVIDIA H100 80GB HBM3", "NVIDIA H100 80GB HBM3"]


def test_gpu_names_is_empty_when_the_glob_matches_nothing(hostinfo, tmp_path):
    assert hostinfo.gpu_names(str(tmp_path / "gpus" / "*" / "information")) == []


def test_driver_version_takes_the_module_token(hostinfo, tmp_path):
    path = _write(tmp_path, "version", _NVIDIA_VERSION)
    assert hostinfo.driver_version(path) == "580.95.05"


def test_driver_version_is_none_for_a_missing_file(hostinfo, tmp_path):
    assert hostinfo.driver_version(str(tmp_path / "absent")) is None


def test_driver_version_is_none_when_the_banner_is_unfamiliar(hostinfo, tmp_path):
    path = _write(tmp_path, "version", "something else entirely\n")
    assert hostinfo.driver_version(path) is None


def test_host_report_omits_unreadable_keys_instead_of_guessing(hostinfo, tmp_path):
    """A placeholder would be read as a measurement. An absent key cannot."""
    report = hostinfo.host_report(
        cpuinfo_path=str(tmp_path / "absent"),
        gpu_glob=str(tmp_path / "absent" / "*" / "information"),
        version_path=str(tmp_path / "absent"),
    )
    assert "cpu_model" not in report
    assert "gpu" not in report
    assert "driver" not in report
    # These do not depend on /proc and are always present.
    assert report["platform"]
    assert report["python"]
    assert isinstance(report["cpu_count"], int)


def test_host_report_reads_everything_it_can(hostinfo, tmp_path, monkeypatch):
    monkeypatch.setenv("MODAL_CONTAINER_ID", "ta-abc123")
    gpu_dir = tmp_path / "gpus" / "0000:07:00.0"
    gpu_dir.mkdir(parents=True)
    (gpu_dir / "information").write_text(_GPU_INFO, encoding="utf-8")
    report = hostinfo.host_report(
        cpuinfo_path=_write(tmp_path, "cpuinfo", _CPUINFO),
        gpu_glob=str(tmp_path / "gpus" / "*" / "information"),
        version_path=_write(tmp_path, "version", _NVIDIA_VERSION),
    )
    assert report["cloud"] == "modal"
    assert report["cpu_model"].startswith("Intel(R) Xeon(R)")
    assert report["gpu"] == "NVIDIA H100 80GB HBM3"
    assert report["driver"] == "580.95.05"


def test_host_report_leaves_cloud_out_when_not_on_modal(hostinfo, tmp_path, monkeypatch):
    monkeypatch.delenv("MODAL_CONTAINER_ID", raising=False)
    report = hostinfo.host_report(
        cpuinfo_path=str(tmp_path / "absent"),
        gpu_glob=str(tmp_path / "absent" / "*" / "information"),
        version_path=str(tmp_path / "absent"),
    )
    assert "cloud" not in report


def test_host_report_includes_torch_only_when_it_is_already_imported(hostinfo, monkeypatch):
    """Importing torch here would add seconds to a boot path that did not ask."""
    holder = type(sys)("torch")
    holder.version = type(sys)("torch.version")
    holder.version.torch = "2.15.0"
    holder.version.cuda = "13.0"
    holder.cuda = None
    monkeypatch.setitem(sys.modules, "torch", holder)
    report = hostinfo.host_report(
        cpuinfo_path="/nonexistent",
        gpu_glob="/nonexistent/*/information",
        version_path="/nonexistent",
    )
    assert report["torch"] == "2.15.0"
    assert report["cuda"] == "13.0"


def test_host_report_line_is_one_greppable_line(hostinfo):
    line = hostinfo.host_report_line(
        {"cpu_model": "Xeon 8358", "gpu": "H100", "driver": "580.95.05"}
    )
    assert line.startswith("[S2C] host ")
    assert "\n" not in line
    assert "cpu_model=Xeon 8358" in line
    assert "driver=580.95.05" in line


def test_host_report_line_handles_an_absent_report(hostinfo):
    assert hostinfo.host_report_line(None) == "[S2C] host=unknown"
    assert hostinfo.host_report_line({}) == "[S2C] host=unknown"


def test_hostinfo_is_stdlib_only(hostinfo):
    """It is imported on the boot path of the GPU class and the CPU probe."""
    source = (MODAL_DIR / "s2_hostinfo.py").read_text(encoding="utf-8")
    for banned in ("import numpy", "import torch", "import modal", "import fastapi"):
        assert banned not in source, f"{banned} must not be on the boot path"
