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
import time
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

    # `_apply_seed` reseeds torch so a restored snapshot cannot repeat a take.
    # The GPU image has torch; a laptop does not, so stub just the calls used.
    torch = types.ModuleType("torch")
    torch.manual_seed = lambda value: None

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

        @staticmethod
        def manual_seed_all(value) -> None:
            return None

        @staticmethod
        def init() -> None:
            return None

        @staticmethod
        def synchronize() -> None:
            return None

    torch.cuda = _Cuda()
    sys.modules.setdefault("torch", torch)


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


# ── GPU thread affinity ────────────────────────────────────────────────────


class _FakeRequest:
    def __init__(self, token: str) -> None:
        self.headers = {"x-echomancer-token": token}


class _RecordingEngine:
    """Stands in for `_BatchEngine`, recording which thread ran each CUDA call.

    This is the whole point of the test: the staging bug was not "CUDA is
    broken", it was "CUDA ran on the wrong thread". Recording thread identity
    is the only way to assert that without a GPU.
    """

    def __init__(self) -> None:
        import threading

        self.sample_rate = 44100
        self.cfg = types.SimpleNamespace(num_codebooks=10)
        self.threads: list[tuple[str, int]] = []
        self._threading = threading

    def _note(self, what: str) -> None:
        self.threads.append((what, self._threading.get_ident()))

    def encode_reference(self, audio: bytes):
        self._note("encode_reference")
        return ("ref", audio[:4])

    def transcribe_reference(self, audio: bytes) -> str:
        self._note("transcribe_reference")
        return "transcribed words"

    def render(self, slots, ref, sampling):
        self._note("render")
        return {
            "codes": [[object() for _ in units] for units in slots],
            "truncated_by_slot": [0] * len(slots),
            "frames": 100,
            "steps": 100,
            "truncated_units": 0,
        }

    def decode_slots(self, codes, slots):
        self._note("decode_slots")
        # `_master` and `duration_s` only need a sized sequence.
        return [[0.0] * 1000 for _ in slots]


def _worker_with_recording_engine(service, *, busy_before: bool = False):
    """A real `S2CloneWorker` instance wired to the recording engine.

    Bypasses `__init__` because Modal constructs the class; every attribute the
    handlers use is attached explicitly, so this test fails loudly if one is
    added and not accounted for.
    """
    import threading

    import s2_contract

    worker = object.__new__(service.S2CloneWorker)
    worker.gpu = s2_contract.GpuExecutor("t-handler")
    worker.gpu.start()
    worker.engine = _RecordingEngine()
    worker.ref_cache = {}
    worker.transcripts = {}
    worker.container_id = "container-test"
    worker.calls = 0
    worker.boot_kind = "restored"
    worker.snapshot_age_s = 12.5
    worker.ready_at = time.time()
    worker._heartbeat_at = 0.0
    worker._heartbeat = lambda force=False: None  # type: ignore[method-assign]
    assert threading.get_ident() != worker.gpu.thread_ident
    return worker


def _batch_payload(keys=("0", "1")):
    import base64

    from s2_contract import WARM_REFERENCE_TEXT, warm_reference_wav

    return {
        "items": [{"key": key, "text": "The river had not moved for three days."} for key in keys],
        "reference_audio_base64": base64.b64encode(warm_reference_wav()).decode(),
        "reference_text": WARM_REFERENCE_TEXT,
        "sampling": "0.9,0.9",
        "job_id": "job-test",
    }


@pytest.fixture
def stub_master(monkeypatch):
    """Replace the ffmpeg mastering pass with bytes; it is not what we assert."""
    import s2_clone_service as service_module

    def fake_master(samples, sample_rate, out_path):
        with open(out_path, "wb") as fh:
            fh.write(b"\xff\xfb" + b"\x01" * 2000)

    monkeypatch.setattr(service_module, "_master", fake_master)


def test_batch_handler_runs_every_gpu_call_on_the_owner_thread(
    service, stub_master, monkeypatch
):
    """The regression staging found, asserted without a GPU.

    `POST /synthesize_batch` on a restored container used to run
    `_resolve_reference` / `engine.render` / `engine.decode_slots` on the FastAPI
    worker thread and die with `CUBLAS_STATUS_ALLOC_FAILED`. Every one of them
    must now happen on the one thread that owns the context.
    """
    monkeypatch.setenv("MODAL_S2_TOKEN", "test-token")
    worker = _worker_with_recording_engine(service)
    try:
        response = service.S2CloneWorker.synthesize_batch(
            worker, _batch_payload(), _FakeRequest("test-token")
        )
        owner = worker.gpu.thread_ident
        assert worker.engine.threads, "no engine call was recorded"
        for what, ident in worker.engine.threads:
            assert ident == owner, f"{what} ran off the GPU thread"
        # And the handler itself really was on a different thread.
        import threading

        assert owner != threading.get_ident()
        assert len(response.content["items"]) == 2
        assert all(row["audio_b64"] for row in response.content["items"])
        assert response.content["boot"] == "restored"
    finally:
        worker.gpu.close()


def test_single_section_handler_also_stays_on_the_owner_thread(
    service, stub_master, monkeypatch
):
    monkeypatch.setenv("MODAL_S2_TOKEN", "test-token")
    worker = _worker_with_recording_engine(service)
    try:
        payload = _batch_payload(keys=("0",))
        service.S2CloneWorker.synthesize(
            worker,
            {
                "text": payload["items"][0]["text"],
                "reference_audio_base64": payload["reference_audio_base64"],
                "reference_text": payload["reference_text"],
                "json": True,
                "job_id": "job-test",
            },
            _FakeRequest("test-token"),
        )
        owner = worker.gpu.thread_ident
        for what, ident in worker.engine.threads:
            assert ident == owner, f"{what} ran off the GPU thread"
    finally:
        worker.gpu.close()


def test_a_busy_lane_answers_429_instead_of_queueing_forever(
    service, stub_master, monkeypatch
):
    """One call per container: a second concurrent one is a retryable 429."""
    import threading

    monkeypatch.setenv("MODAL_S2_TOKEN", "test-token")
    monkeypatch.setenv("S2C_GPU_WAIT_S", "0")
    worker = _worker_with_recording_engine(service)
    started = threading.Event()
    release = threading.Event()

    def hold() -> None:
        started.set()
        release.wait(5)

    holder = threading.Thread(target=lambda: worker.gpu.submit(hold))
    try:
        holder.start()
        started.wait(2)
        import fastapi

        with pytest.raises(fastapi.HTTPException) as err:
            service.S2CloneWorker.synthesize_batch(
                worker, _batch_payload(), _FakeRequest("test-token")
            )
        assert err.value.status_code == 429
        assert err.value.detail["code"] == "lane_busy"
    finally:
        release.set()
        holder.join(5)
        worker.gpu.close()


def test_the_snapshot_hook_owns_the_gpu_thread_before_any_cuda(service):
    import inspect

    source = inspect.getsource(service.S2CloneWorker.load)
    # The thread is started, and `init` — where CUDA is first touched — is
    # handed to it rather than run inline.
    assert "self.gpu.start(init" in source
    assert "torch.cuda.init()" in source
    # CUDA must not be initialised outside `init`.
    after_start = source.split("self.gpu.start(init", 1)[1]
    assert "torch.cuda.init()" not in after_start
    # The allocator paths that failed are exercised at boot, not on a request.
    assert "selftest()" in source


def test_boot_kind_distinguishes_restore_from_compile(service):
    from s2_contract import BOOT_COMPILED, BOOT_RESTORED, boot_kind

    # A restore resumes the image in a NEW process, so the pid captured while
    # snapshotting no longer matches. That is the only honest signal, because a
    # restored container did not exist for most of its own boot.
    assert boot_kind(snap_pid=100, current_pid=200, snap_mark=1.0) == BOOT_RESTORED
    assert boot_kind(snap_pid=100, current_pid=100, snap_mark=1.0) == BOOT_COMPILED
    # Nothing snapshotted in this lineage: claim neither.
    assert boot_kind(snap_pid=None, current_pid=100, snap_mark=None) == "unknown"


def test_no_metric_called_restored_s_is_derived_from_the_snapshot_mark(service):
    """The inverted metric must not come back.

    `restored_s` was `now - compiled_at`, but `compiled_at` is frozen in the
    snapshot, so restores looked huge and compiles looked small. Anything named
    like a restore duration must not be derived from that mark.
    """
    import inspect

    source = inspect.getsource(service)
    assert "restored_s" not in source, (
        "restored_s was measured from the frozen snapshot mark and was inverted; "
        "use boot kind and snapshot_age_s"
    )
    # The age is reported, and it is explicitly labelled as an age.
    assert "snapshot_age_s" in source


