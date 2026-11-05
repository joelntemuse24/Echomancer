"""Import the deployable modules against stubbed Modal / FastAPI APIs.

This is the cheapest way to catch the mistakes that otherwise only show up as a
failed deploy or a broken container: a kwargs name Modal does not accept, two
`snap=True` hooks, a third `@modal.enter()`, a method annotated in a way the
web endpoint cannot serve, or an import that only resolves inside the GPU image.

The stubs record every decorator call so the tests can assert on the shape. The
signatures are the ones documented at
https://modal.com/docs/reference/modal.enter and
https://modal.com/docs/guide/lifecycle-functions as of 2026-11-05:

    enter(*, snap=False)          -> only `snap`, and it is keyword-only
    app.cls(...)                  -> min_containers / max_containers /
                                     scaledown_window / buffer_containers /
                                     enable_memory_snapshot / experimental_options

Run with:  python3 -m pytest modal -q
"""

from __future__ import annotations

import contextlib
import importlib
import sys
import types

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


class Recorder:
    """Collects decorator kwargs so a test can assert on them."""

    def __init__(self) -> None:
        self.classes: list[dict] = []
        self.functions: list[dict] = []
        self.enters: list[dict] = []
        self.methods = 0
        self.endpoints: list[dict] = []


def _install_stubs(recorder: Recorder) -> None:
    modal = types.ModuleType("modal")

    class _Object:
        @classmethod
        def from_name(cls, *args, **kwargs):
            return cls()

        def __getattr__(self, name):
            if name.startswith("__"):
                raise AttributeError(name)

            def _call(*args, **kwargs):
                return self

            return _call

    class App(_Object):
        def __init__(self, name=None, **kwargs):
            self.name = name

        def cls(self, **kwargs):
            frame = sys._getframe(1)
            recorder.classes.append(
                {**kwargs, "_module": frame.f_globals.get("__name__", "")}
            )

            def decorate(obj):
                return obj

            return decorate

        def function(self, **kwargs):
            frame = sys._getframe(1)
            recorder.functions.append(
                {**kwargs, "_module": frame.f_globals.get("__name__", "")}
            )

            def decorate(obj):
                return obj

            return decorate

        def local_entrypoint(self, *args, **kwargs):
            def decorate(obj):
                return obj

            return decorate

    class Image(_Object):
        def pip_install(self, *args, **kwargs):
            return self

        def apt_install(self, *args, **kwargs):
            return self

        def run_commands(self, *args, **kwargs):
            return self

        def env(self, *args, **kwargs):
            return self

        def add_local_python_source(self, *args, **kwargs):
            return self

        @contextlib.contextmanager
        def imports(self):
            # The real helper binds remote-only imports and tolerates a missing
            # module outside the GPU image; keep that behaviour.
            try:
                yield
            except ImportError:
                pass

    def enter(*args, **kwargs):
        if args:
            raise TypeError("@modal.enter() takes no positional arguments")
        unknown = set(kwargs) - {"snap"}
        if unknown:
            raise TypeError(f"@modal.enter() got unexpected kwargs: {unknown}")
        frame = sys._getframe(1)
        recorder.enters.append(
            {**kwargs, "_module": frame.f_globals.get("__name__", "")}
        )

        def decorate(fn):
            return fn

        return decorate

    def method(*args, **kwargs):
        recorder.methods += 1

        def decorate(fn):
            return fn

        return decorate

    def fastapi_endpoint(*args, **kwargs):
        frame = sys._getframe(1)
        unknown = set(kwargs) - {"method", "docs", "label"}
        if unknown:
            raise TypeError(f"@modal.fastapi_endpoint got unexpected kwargs: {unknown}")
        entry = {
            "args": args,
            "kwargs": kwargs,
            "_module": frame.f_globals.get("__name__", ""),
        }
        recorder.endpoints.append(entry)

        def decorate(fn):
            return fn

        return decorate

    class Secret(_Object):
        pass

    class Dict(_Object):
        def items(self):
            return []

        def __setitem__(self, key, value):
            return None

        def pop(self, key, default=None):
            return default

    class Volume(_Object):
        def commit(self):
            return None

        def listdir(self, *args, **kwargs):
            return []

        def read_file(self, *args, **kwargs):
            return []

    def _passthrough_decorator(*args, **kwargs):
        def decorate(fn):
            return fn

        return decorate

    modal.App = App
    modal.Image = Image
    modal.Secret = Secret
    modal.Dict = Dict
    modal.Volume = Volume
    modal.enter = enter
    modal.method = method
    modal.fastapi_endpoint = fastapi_endpoint
    modal.concurrent = _passthrough_decorator
    modal.batched = _passthrough_decorator
    modal.Cron = lambda *a, **k: None

    class _ImageFactory:
        @staticmethod
        def debian_slim(*args, **kwargs):
            return Image()

    modal.Image.debian_slim = _ImageFactory.debian_slim
    sys.modules["modal"] = modal

    # FastAPI is only present in the web image.
    fastapi = types.ModuleType("fastapi")

    class _HTTPException(Exception):
        def __init__(self, status_code: int = 400, detail=None):
            super().__init__(str(detail))
            self.status_code = status_code
            self.detail = detail

    class Request:
        headers: dict = {}

    fastapi.Request = Request
    fastapi.HTTPException = _HTTPException
    sys.modules["fastapi"] = fastapi

    responses = types.ModuleType("fastapi.responses")

    class JSONResponse:
        def __init__(self, content=None, status_code: int = 200):
            self.content = content
            self.status_code = status_code

    class Response:
        def __init__(self, content=None, media_type=None, headers=None):
            self.content = content
            self.media_type = media_type
            self.headers = headers or {}

    responses.JSONResponse = JSONResponse
    responses.Response = Response
    sys.modules["fastapi.responses"] = responses


@pytest.fixture(scope="module")
def service():
    """Import the clone service once with stubs installed."""
    recorder = Recorder()
    _install_stubs(recorder)
    sys.path.insert(0, str(MODAL_DIR))
    for name in ("s2_contract", "s2_batch", "s2_mastering", "s2_clone_service"):
        sys.modules.pop(name, None)
    module = importlib.import_module("s2_clone_service")
    module._recorder = recorder  # type: ignore[attr-defined]
    yield module
    sys.path.remove(str(MODAL_DIR))


def _service_only(items: list[dict]) -> list[dict]:
    return [item for item in items if item.get("_module") == "s2_clone_service"]


def test_module_imports_with_the_stubbed_apis(service):
    assert service.APP_NAME.startswith("echomancer-s2-clone")
    assert service.S2C_VERSION
    assert service._BUILD_ENV["S2C_BUILD"]


def test_class_shape_matches_the_documented_autoscaler_options(service):
    (kwargs,) = _service_only(service._recorder.classes)
    allowed = {
        "image",
        "gpu",
        "cpu",
        "memory",
        "secrets",
        "scaledown_window",
        "timeout",
        "min_containers",
        "max_containers",
        "buffer_containers",
        "enable_memory_snapshot",
        "experimental_options",
        "env",
        "volumes",
        "retries",
        "_module",
    }
    assert set(kwargs) <= allowed, set(kwargs) - allowed
    # Scale to zero when idle, and the snapshot is on.
    assert kwargs["min_containers"] == 0
    assert kwargs["enable_memory_snapshot"] is True
    assert kwargs["experimental_options"] == {"enable_gpu_snapshot": True}
    # Hard cap is 1 until staging signs off four lanes.
    assert kwargs["max_containers"] == 1


def test_only_one_snapshot_hook_and_one_post_restore_hook(service):
    enters = _service_only(service._recorder.enters)
    snap = [entry for entry in enters if entry.get("snap") is True]
    plain = [entry for entry in enters if not entry.get("snap")]
    assert len(snap) == 1, "exactly one @modal.enter(snap=True) is allowed"
    assert len(plain) == 1, "exactly one post-restore @modal.enter() is allowed"
    assert len(enters) == 2, "a third lifecycle hook silently changes snapshot scope"


def test_web_endpoints_declare_a_method(service):
    endpoints = _service_only(service._recorder.endpoints)
    assert endpoints, "the service must expose at least one web endpoint"
    methods = {entry["kwargs"].get("method") for entry in endpoints}
    assert methods <= {"POST", "GET"}
    for entry in endpoints:
        assert entry["kwargs"].get("docs") is False


def test_the_ready_probe_is_a_cpu_function(service):
    (function,) = _service_only(service._recorder.functions)
    assert "gpu" not in function, "the readiness probe must not start a GPU"
    assert function["timeout"] <= 30


def test_no_multi_gpu_or_replica_wide_gpu_request(service):
    (kwargs,) = _service_only(service._recorder.classes)
    gpu = kwargs["gpu"]
    # One GPU per container: "H100!" or "H100", never "H100:4".
    assert ":" not in str(gpu), f"multi-GPU is incompatible with GPU snapshots: {gpu}"


def test_container_limits_come_from_env_not_hardcoded(service):
    import s2_contract

    # The decorator reads the same helper the health output does, so a single
    # env var changes both and they cannot disagree.
    assert service._max_containers() == s2_contract.container_limits(
        __import__("os").environ
    )["max_containers"]


def test_reference_helpers_reject_before_gpu_work(service):
    from s2_contract import ReferenceClipError, ReferenceTextError

    with pytest.raises(ReferenceClipError):
        service._prepare_reference(b"", "words")
    with pytest.raises(ReferenceTextError):
        service._prepare_reference(
            service.warm_reference_wav(), "   "
        )
    # A good pair passes and returns the trimmed transcript.
    assert service._prepare_reference(
        service.warm_reference_wav(), "  hello there  "
    ) == "hello there"


def test_build_fingerprint_changes_with_config(service):
    first = service._BUILD_ENV["S2C_BUILD"]
    assert len(first) == 12
    from s2_contract import snapshot_fingerprint

    other = snapshot_fingerprint({"app": "x", "version": "5"})
    assert other != first
