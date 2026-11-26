"""The Kokoro CPU image bakes its cold-start downloads, with pinned versions.

misaki's English G2P runs `spacy.cli.download("en_core_web_sm")` on first use
when the package is missing, and `engine.py` asks `hf_hub_download` for
Kokoro's config, weights, `bm_george`, and `af_heart`. Those fetches used to happen
inside `@modal.enter` on a scaled-from-zero container, which put a Hub round
trip in front of the first section of a book.

The test reads the Dockerfile and the app sources. It does not build an image
and does not need Modal, torch, or spaCy installed.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def dockerfile() -> str:
    return (ROOT / "workers" / "sowell" / "Dockerfile").read_text()


def instruction_lines(text: str) -> list[str]:
    """Dockerfile instructions only: no comments, no blank lines."""
    return [
        line
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def test_spacy_model_is_installed_at_a_pinned_version_compatible_with_spacy() -> None:
    text = dockerfile()
    # The model is pinned by version, not by a moving `spacy download` alias.
    assert "SPACY_MODEL_VERSION=3.8.0" in text
    assert "en_core_web_sm-${SPACY_MODEL_VERSION}" in text
    # No moving `spacy download` at build or run time. Comments may name it;
    # an instruction may not.
    assert not any(
        "spacy.cli.download" in line or "spacy download" in line
        for line in instruction_lines(text)
    )
    # A pinned wheel URL, so the build does not ask pip to resolve a model.
    assert (
        "https://github.com/explosion/spacy-models/releases/download/"
        "en_core_web_sm-${SPACY_MODEL_VERSION}/"
        "en_core_web_sm-${SPACY_MODEL_VERSION}-py3-none-any.whl"
    ) in text
    # spaCy's major.minor decides which model wheel the image can load. A
    # mismatch fails the build instead of shipping an unusable G2P.
    assert "assert (v[0], v[1]) == ('3','8')" in text
    assert "spacy.load('en_core_web_sm')" in text


def test_hf_home_is_set_before_the_baked_hub_downloads() -> None:
    text = dockerfile()
    hf_home = text.index("ENV HF_HOME=/opt/hf")
    # The Kokoro weights and config are fetched into that cache.
    kokoro_fetch = text.index("hf_hub_download(repo_id='hexgrad/Kokoro-82M'")
    george_fetch = text.index("filename='voices/bm_george.pt'")
    heart_fetch = text.index("filename='voices/af_heart.pt'")
    assert hf_home < kokoro_fetch
    assert hf_home < george_fetch
    assert hf_home < heart_fetch
    assert "config.json" in text
    assert "kokoro-v1_0.pth" in text
    # Pinned revision, matching `scripts/sowell/pack.py`.
    pin = "f3ff3571791e39611d31c381e3a41a3af07b4987"
    pack = (ROOT / "scripts" / "sowell" / "pack.py").read_text()
    assert f'PINNED_REVISION = "{pin}"' in pack
    assert text.count(pin) >= 2


def test_espeak_and_ffmpeg_are_present_and_no_second_python_is_installed() -> None:
    text = dockerfile()
    assert "espeak-ng" in text
    assert "ffmpeg" in text
    assert "FROM python:3.11-slim-bookworm" in text
    assert "add_python" not in text
    # No nltk data to fetch: misaki does not use it, and baking a corpus that
    # nothing reads would only grow the image.
    assert not any("nltk" in line.lower() for line in instruction_lines(text))


def test_torch_threads_are_an_env_knob_with_four_as_the_default() -> None:
    text = dockerfile()
    # 4 threads on Modal's 2 physical cores: benchmarked ~1.5x faster than 2
    # on the deployed image (RTF 2.06-2.41 vs 1.46-1.57 on the harbor
    # paragraph). The OMP/BLAS/MKL variables stay in step.
    assert "ENV SOWELL_TORCH_THREADS=4" in text
    assert "ENV SOWELL_CPU_THREADS=4" in text
    assert "ENV SOWELL_TORCH_INTEROP_THREADS=1" in text
    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        assert f"ENV {name}=4" in text
    engine = (ROOT / "scripts" / "sowell" / "engine.py").read_text()
    assert "def apply_torch_threads() -> int:" in engine
    assert "torch.set_num_threads(n)" in engine
    # The fallback default is 4 in both readers, clamped to the local CPU count.
    assert 'os.environ.get("SOWELL_CPU_THREADS", "4")' in engine
    assert '"SOWELL_CPU_THREADS", "4"' in engine
    assert "os.cpu_count() or 4" in engine


def test_worker_applies_threads_before_loading_a_model() -> None:
    worker = (ROOT / "modal" / "sowell_worker.py").read_text()
    enter = worker.index("@modal.enter(snap=True)")
    threads = worker.index("apply_torch_threads()", enter)
    engine_load = worker.index("SowellEngine()", enter)
    assert threads < engine_load


def test_worker_fleet_and_idle_defaults() -> None:
    worker = (ROOT / "modal" / "sowell_worker.py").read_text()
    # Sixteen containers by default, matching the worker's sixteen book lanes.
    assert "MAX_CONTAINERS_DEFAULT = 16" in worker
    # The deploy knob is clamped to 1..16, so a typo cannot oversize the app.
    assert "MAX_CONTAINERS_CEILING = 16" in worker
    assert "max_containers=max_containers()" in worker
    # Five seconds of idle. The measured book's idle tail dominated its cost.
    assert "SCALEDOWN_DEFAULT = 5" in worker
    assert "scaledown_window=scaledown_seconds()" in worker
    # The idle knob is clamped to Modal's allowed 2..1200 range.
    assert "SCALEDOWN_MIN = 2" in worker
    assert "SCALEDOWN_MAX = 1200" in worker
    # Scale to zero stays the floor: warming is a click, not a standing fleet.
    assert "min_containers=0" in worker
    assert "memory=memory_mb()" in worker
    assert "TORCH_MEMORY_MB = 6144" in worker
    assert "cpu=2" in worker


def _load_worker_with_fake_modal(monkeypatch):
    """Import the app against a fake Modal client; returns the module.

    Mirrors `modal/test_cpu_image.py`: the decorator kwargs are what Modal
    would read from the deploy, without an account or an image build.
    """
    import importlib
    import sys
    import types

    class _Image:
        def __init__(self, *a, **k):
            pass

        @staticmethod
        def from_dockerfile(*a, **k):
            return _Image()

        def pip_install(self, *a, **k):
            return self

        def env(self, *a, **k):
            return self

    class App:
        def __init__(self, name):
            self.name = name
            self.cls_kwargs: dict = {}

        def cls(self, **kwargs):
            self.cls_kwargs = kwargs

            def decorate(cls):
                return cls

            return decorate

        def function(self, *args, **kwargs):
            def decorate(fn):
                return fn

            return decorate

    class _Volume:
        @classmethod
        def from_name(cls, *a, **k):
            return cls()

    modal = types.ModuleType("modal")
    modal.App = App
    modal.Image = _Image
    modal.Volume = _Volume
    modal.enter = lambda *a, **k: (lambda fn: fn)
    modal.method = lambda *a, **k: (lambda fn: fn)
    modal.fastapi_endpoint = lambda *a, **k: (lambda fn: fn)
    modal.concurrent = lambda *a, **k: (lambda fn: fn)
    modal.Secret = types.SimpleNamespace(from_name=lambda name: name)
    prior_modal = sys.modules.get("modal")
    sys.modules["modal"] = modal

    # The handler imports `fastapi.Request` at module scope and the response
    # classes inside the call. Only the import-time surface is needed here.
    fastapi = types.ModuleType("fastapi")
    fastapi.Request = object
    prior_fastapi = sys.modules.get("fastapi")
    sys.modules["fastapi"] = fastapi

    sys.path.insert(0, str(ROOT / "modal"))
    sys.modules.pop("sowell_worker", None)
    try:
        worker = importlib.import_module("sowell_worker")
    finally:
        sys.path.remove(str(ROOT / "modal"))
        sys.modules.pop("sowell_worker", None)
        if prior_fastapi is not None:
            sys.modules["fastapi"] = prior_fastapi
        else:
            sys.modules.pop("fastapi", None)
        if prior_modal is not None:
            sys.modules["modal"] = prior_modal
        else:
            sys.modules.pop("modal", None)
    return worker


def test_worker_class_resolves_with_the_declared_fleet(monkeypatch) -> None:
    monkeypatch.delenv("SOWELL_MAX_CONTAINERS", raising=False)
    monkeypatch.delenv("SOWELL_SCALEDOWN_SECONDS", raising=False)
    worker = _load_worker_with_fake_modal(monkeypatch)

    assert worker.APP_NAME == "echomancer-sowell"
    kwargs = worker.app.cls_kwargs
    # ONNX default: 16 calls / 4 streams = 4 containers, memory from the
    # measured ONNX constant (torch stays 6144 and one call per container).
    assert kwargs["max_containers"] == 4
    assert kwargs["scaledown_window"] == 5
    assert kwargs["min_containers"] == 0
    assert kwargs["memory"] == worker.ONNX_MEMORY_MB_DEFAULT
    assert kwargs["memory"] != worker.TORCH_MEMORY_MB
    assert kwargs["cpu"] == 2
    assert kwargs["enable_memory_snapshot"] is True
    assert "gpu" not in kwargs
    assert worker.TORCH_THREADS == "4"


def test_max_containers_env_is_honoured_up_to_sixteen(monkeypatch) -> None:
    """16 calls on ONNX are 4 containers (4 streams each)."""
    monkeypatch.setenv("KOKORO_RUNTIME", "onnx")
    monkeypatch.setenv("SOWELL_MAX_CONTAINERS", "16")
    worker = _load_worker_with_fake_modal(monkeypatch)
    assert worker.app.cls_kwargs["max_containers"] == 4


def test_max_containers_env_clamps_above_sixteen(monkeypatch) -> None:
    monkeypatch.setenv("KOKORO_RUNTIME", "onnx")
    monkeypatch.setenv("SOWELL_MAX_CONTAINERS", "64")
    worker = _load_worker_with_fake_modal(monkeypatch)
    assert worker.app.cls_kwargs["max_containers"] == 4


def test_max_containers_env_floors_and_ignores_junk(monkeypatch) -> None:
    monkeypatch.setenv("KOKORO_RUNTIME", "onnx")
    for value, expected in (("0", 1), ("-3", 1), ("abc", 4), ("", 4)):
        monkeypatch.setenv("SOWELL_MAX_CONTAINERS", value)
        worker = _load_worker_with_fake_modal(monkeypatch)
        assert worker.app.cls_kwargs["max_containers"] == expected, value


def test_max_containers_reads_a_respected_fleet_between_one_and_sixteen(monkeypatch) -> None:
    monkeypatch.setenv("KOKORO_RUNTIME", "onnx")
    # Calls, then ceil(calls / 4 streams).
    for n, expected in ((1, 1), (6, 2), (12, 3), (15, 4), (16, 4)):
        monkeypatch.setenv("SOWELL_MAX_CONTAINERS", str(n))
        worker = _load_worker_with_fake_modal(monkeypatch)
        assert worker.app.cls_kwargs["max_containers"] == expected


def test_torch_runtime_keeps_one_call_and_6144_mb(monkeypatch) -> None:
    monkeypatch.setenv("KOKORO_RUNTIME", "torch")
    monkeypatch.delenv("SOWELL_MAX_CONTAINERS", raising=False)
    worker = _load_worker_with_fake_modal(monkeypatch)
    assert worker.kokoro_streams() == 1
    assert worker.memory_mb() == 6144
    assert worker.app.cls_kwargs["max_containers"] == 16
    assert worker.app.cls_kwargs["memory"] == 6144


def test_scaledown_env_is_honoured_inside_modal_range(monkeypatch) -> None:
    for value, expected in (
        ("30", 30),
        ("1200", 1200),
        ("0", 2),
        ("-5", 2),
        ("1201", 1200),
        ("abc", 5),
        ("", 5),
    ):
        monkeypatch.setenv("SOWELL_SCALEDOWN_SECONDS", value)
        worker = _load_worker_with_fake_modal(monkeypatch)
        assert worker.app.cls_kwargs["scaledown_window"] == expected, value


def test_bench_app_is_cheap_and_gpu_free() -> None:
    bench = (ROOT / "modal" / "sowell_bench.py").read_text()
    assert "max_containers=1" in bench
    assert "min_containers=0" in bench
    assert "scaledown_window=10" in bench
    # No GPU anywhere in this app or its image.
    assert not re.search(r"\bgpu\s*=", bench)
    assert "A100" not in bench and "H100" not in bench
    # It must not read the production secret. The volume is the only mount.
    assert "modal.Secret.from_name" not in bench
    assert "modal.Volume.from_name" in bench
    assert "@app.local_entrypoint()" in bench
    assert "rtf" in bench
    # Same image as the production app, so the numbers mean something.
    assert 'workers" / "sowell" / "Dockerfile' in bench or "workers/sowell/Dockerfile" in bench
    # A default entrypoint command is documented.
    assert "modal run modal/sowell_bench.py --threads" in bench


def test_bench_app_imports_against_a_fake_modal_client() -> None:
    """`modal run` must resolve the app, the image, and the entrypoint.

    The fake mirrors `modal/test_cpu_image.py`: it records the image recipe and
    hands back the decorated function. No Modal account, no image build.
    """
    import importlib
    import sys
    import types

    class _Image:
        def __init__(self) -> None:
            self.from_dockerfile_calls: list[tuple] = []
            self.pip_calls: list[tuple] = []

        def pip_install(self, *args, **kwargs):
            self.pip_calls.append((args, kwargs))
            return self

    built = _Image()

    def from_dockerfile(*args, **kwargs):
        built.from_dockerfile_calls.append((args, kwargs))
        return built

    modal = types.ModuleType("modal")

    class Image:
        pass

    Image.from_dockerfile = staticmethod(from_dockerfile)

    class App:
        def __init__(self, name):
            self.name = name
            self.cls_kwargs: dict = {}
            self.entrypoints: list = []

        def cls(self, **kwargs):
            self.cls_kwargs = kwargs

            def decorate(obj):
                return obj

            return decorate

        def local_entrypoint(self, *args, **kwargs):
            def decorate(fn):
                self.entrypoints.append(fn)
                return fn

            return decorate

    class _Volume:
        @classmethod
        def from_name(cls, *args, **kwargs):
            return cls()

    modal.App = App
    modal.Image = Image
    modal.Volume = _Volume
    modal.enter = lambda *a, **k: (lambda fn: fn)
    modal.method = lambda *a, **k: (lambda fn: fn)
    # Save the suite's own stub so this file does not leak a narrower `modal`
    # (or a stub `fastapi`) into the S2 suites.
    prior_modal = sys.modules.get("modal")
    prior_bench = sys.modules.get("sowell_bench")
    sys.modules["modal"] = modal

    sys.path.insert(0, str(ROOT / "modal"))
    sys.modules.pop("sowell_bench", None)
    try:
        bench = importlib.import_module("sowell_bench")
    finally:
        sys.path.remove(str(ROOT / "modal"))
        sys.modules.pop("sowell_bench", None)
        if prior_bench is not None:
            sys.modules["sowell_bench"] = prior_bench
        if prior_modal is not None:
            sys.modules["modal"] = prior_modal
        else:
            sys.modules.pop("modal", None)

    assert bench.APP_NAME == "echomancer-sowell-bench"
    assert bench.app.name == "echomancer-sowell-bench"
    assert bench.app.cls_kwargs["max_containers"] == 1
    assert bench.app.cls_kwargs["min_containers"] == 0
    assert bench.app.cls_kwargs["scaledown_window"] == 10
    assert bench.app.cls_kwargs["cpu"] == 2
    assert "gpu" not in bench.app.cls_kwargs
    assert built.from_dockerfile_calls, "the bench must build the production image"
    args, kwargs = built.from_dockerfile_calls[0]
    assert args[0].name == "Dockerfile"
    assert kwargs["context_dir"] == ROOT
    # Three short texts, so one call is a few seconds of CPU.
    assert len(bench.TEXTS) == 3
    assert bench.app.entrypoints, "no local entrypoint was registered"


def test_no_gpu_references_in_the_cpu_app() -> None:
    worker = (ROOT / "modal" / "sowell_worker.py").read_text()
    assert "s2_clone" not in worker
    assert "S2C_" not in worker
    assert not re.search(r"\bgpu\s*=", worker)
