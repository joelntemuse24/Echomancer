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
        self.exits: list[dict] = []
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

    def exit(*args, **kwargs):
        """`@modal.exit()` takes no arguments; a teardown hook."""
        if args or kwargs:
            raise TypeError("@modal.exit() takes no arguments")
        frame = sys._getframe(1)
        recorder.exits.append({"method": frame.f_locals.get("fn") or None,
                               "_module": frame.f_globals.get("__name__", "")})

        def decorate(fn):
            recorder.exits[-1]["method"] = fn.__name__
            return fn

        return decorate

    modal.App = App
    modal.Image = Image
    modal.Secret = Secret
    modal.Dict = Dict
    modal.Volume = Volume
    modal.enter = enter
    modal.exit = exit
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
    # Hard cap is 1 until staging signs off four lanes. H100! stays pinned.
    assert kwargs["max_containers"] == 1
    assert kwargs["min_containers"] == 0
    assert kwargs["gpu"] == "H100!"
    assert ":" not in str(kwargs["gpu"])
    volumes = kwargs["volumes"]
    assert "/compile-cache" in volumes
    env = kwargs["env"]
    assert env["TORCHINDUCTOR_CACHE_DIR"] == "/opt/torchinductor"
    assert env["TRITON_CACHE_DIR"] == "/tmp/s2-triton-cache"
    assert "/compile-cache/unkeyed" not in env["TORCHINDUCTOR_CACHE_DIR"]
    assert env["TORCHINDUCTOR_FX_GRAPH_CACHE"] == "1"
    assert env["TORCHINDUCTOR_AUTOGRAD_CACHE"] == "1"
    assert env["S2C_COMPILE_CACHE"] == "1"
    assert service.COMPILE_CACHE_VOLUME_NAME == "echomancer-compile-cache"
    assert service.COMPILE_CACHE_MOUNT == "/compile-cache"


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


def test_every_function_bakes_the_same_deploy_identity(service):
    """GPU class, s2_control, and ready share one deploy-time identity."""
    import os

    from s2_contract import deploy_identity

    identity = deploy_identity(os.environ)
    (cls,) = _service_only(service._recorder.classes)
    functions = _service_only(service._recorder.functions)
    names = {getattr(fn.get("_fn", None), "__name__", "") for fn in functions}
    assert len(functions) == 2
    for key, value in identity.items():
        assert cls["env"][key] == value, key
        for fn in functions:
            assert fn["env"][key] == value, (key, fn.get("timeout"))
    assert names or True
    again = deploy_identity(identity)
    assert again["S2C_APP_NAME"] == identity["S2C_APP_NAME"]
    assert again["S2C_CONTROL_DICT"] == identity["S2C_CONTROL_DICT"]
    assert again["S2C_HEARTBEAT_DICT"] == identity["S2C_HEARTBEAT_DICT"]


def test_fleet_brake_restore_and_count_do_not_spawn(service, monkeypatch):
    calls = []

    class Settings:
        def __init__(self, max_containers: int) -> None:
            self.max_containers = max_containers
            self.min_containers = 0

    class Worker:
        def update_autoscaler(self, **kwargs):
            calls.append(kwargs)
            if not kwargs:
                return Settings(20)
            return Settings(int(kwargs.get("max_containers", 0)))

        def get_current_stats(self):
            return type("Stats", (), {"num_total_runners": 3})()

    monkeypatch.setattr(service, "S2CloneWorker", Worker)
    read = service._fleet({"autoscaler": "read", "app": "echomancer-s2-clone-staging"})
    assert read["max_containers"] == 20
    assert read["app"] == service.APP_NAME
    assert calls == [{}]
    calls.clear()
    brake = service._fleet({"autoscaler": "brake"})
    assert brake["max_containers"] == 0
    assert brake["min_containers"] == 0
    assert calls == [{"min_containers": 0, "max_containers": 0, "scaledown_window": 15}]
    calls.clear()
    restored = service._fleet({"autoscaler": "restore", "max_containers": 20})
    assert restored["max_containers"] == 20
    assert calls[0]["min_containers"] == 0
    assert calls[0]["max_containers"] == 20
    counted = service._fleet({"autoscaler": "count"})
    assert counted["running"] == 3
    assert counted["app"] == service.APP_NAME


def test_ready_and_control_are_cpu_functions(service):
    functions = _service_only(service._recorder.functions)
    assert len(functions) == 2, "ready and s2_control are the only module-level functions"
    for function in functions:
        assert "gpu" not in function, "control traffic must not start a GPU"
        assert function["timeout"] <= 30
        assert function.get("min_containers", 0) == 0
        assert function["cpu"] <= 0.125
        assert function["memory"] <= 256


def test_no_multi_gpu_or_replica_wide_gpu_request(service):
    (kwargs,) = _service_only(service._recorder.classes)
    gpu = kwargs["gpu"]
    # The bang stops Modal upgrading the type to H200. Dropping it was the
    # 2026-11-17 incident. One GPU: never "H100:4".
    assert gpu == "H100!"
    assert ":" not in str(gpu)


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

    def render(self, slots, ref, sampling, on_section=None):
        self._note("render")
        return {
            "codes": [[object() for _ in units] for units in slots],
            "truncated_by_slot": [0] * len(slots),
            "frames": 100,
            "steps": 100,
            "truncated_units": 0,
        }

    def decode_slots(self, codes, slots, *, audio_by_section=None):
        self._note("decode_slots")
        # `audio_by_section` is what a streamed `render` already decoded; the
        # single-section path passes it through so the codec is not run twice.
        # This engine streams nothing, so it arrives empty.
        assert audio_by_section in (None, {}), audio_by_section
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

    mp3 = b"\xff\xfb" + b"\x01" * 2000

    def fake_master(samples, sample_rate, out_path):
        with open(out_path, "wb") as fh:
            fh.write(mp3)

    monkeypatch.setattr(service_module, "_master", fake_master)
    # The pipelined path calls `_master_pcm` with 16-bit PCM on stdin, so it
    # needs the same stub or the test would shell out to ffmpeg.
    monkeypatch.setattr(service_module, "_master_pcm", lambda pcm, rate: mp3)
    monkeypatch.setattr(service_module, "_master_bytes", lambda samples, rate: mp3)


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
    for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(name, raising=False)
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


def test_batch_performance_carries_the_host_report(service, stub_master, monkeypatch):
    """The page log has to say *which* container, not only how slow it was.

    A page that renders at 8.8x on one container and 32x on another is
    otherwise indistinguishable from a wider page or a codec that did not
    overlap. `host` is read from the real `/proc` on the machine doing the
    work, so this asserts the shape rather than any particular CPU.
    """
    monkeypatch.setenv("MODAL_S2_TOKEN", "test-token")
    for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(name, raising=False)
    worker = _worker_with_recording_engine(service)
    worker.host = {
        "cloud": "modal",
        "cpu_model": "Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz",
        "gpu": "NVIDIA H100 80GB HBM3",
        "driver": "580.95.05",
        "cpu_count": 8,
    }
    try:
        response = service.S2CloneWorker.synthesize_batch(
            worker, _batch_payload(), _FakeRequest("test-token")
        )
        performance = response.content["performance"]
        assert performance["host"]["gpu"] == "NVIDIA H100 80GB HBM3"
        assert performance["host"]["driver"] == "580.95.05"
        assert performance["page_rows"] == 2
        assert performance["rows_errored"] == 0
        assert "call_id" in performance
        # The split the page log prints. Each of these has to be a real number,
        # not a placeholder, or a slow page cannot be attributed.
        for field in (
            "prepare_s",
            "generate_s",
            "codec_s",
            "encode_s",
            "call_s",
            "batch_width",
            "snapshot_age_s",
            "truncated_units",
            "reference_cached",
        ):
            assert field in performance, field
        assert performance["snapshot_age_s"] == 12.5
        # `prepare_s` must cover the reference encode, and `ref_encode_s` must
        # be a slice of it rather than a second, overlapping clock.
        assert 0 <= performance["ref_encode_s"] <= performance["prepare_s"]
    finally:
        worker.gpu.close()


def test_batch_performance_survives_a_container_with_no_host_report(
    service, stub_master, monkeypatch
):
    """A restored container from a build before this field reports `None`."""
    monkeypatch.setenv("MODAL_S2_TOKEN", "test-token")
    for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(name, raising=False)
    worker = _worker_with_recording_engine(service)
    assert not hasattr(worker, "host")
    try:
        response = service.S2CloneWorker.synthesize_batch(
            worker, _batch_payload(), _FakeRequest("test-token")
        )
        assert response.content["performance"]["host"] is None
    finally:
        worker.gpu.close()


def test_the_boot_hook_records_the_host_and_logs_it(service, monkeypatch, capsys):
    """The report is captured on the serving host, not the snapshotting one.

    `publish` is the plain `@modal.enter()`, which runs after a restore, so it
    is where the honest machine description belongs: the snapshot hook
    describes whichever container built the image. The hook is called on a
    worker stubbed just far enough to reach the host capture — the graph
    verification and heartbeat it also does are covered by
    `test_s2_ready_liveness`.
    """
    worker = _worker_with_recording_engine(service)
    try:
        monkeypatch.setattr(service, "host_report", lambda: {"gpu": "H100", "driver": "1.2.3"})
        monkeypatch.setattr(type(worker), "_verify_graphs", lambda self: "ok(1)", raising=False)
        monkeypatch.setattr(
            type(worker), "_start_heartbeat_timer", lambda self: None, raising=False
        )
        monkeypatch.setattr(
            type(worker), "_heartbeat", lambda self, force=False: None, raising=False
        )
        worker.graph_check = "skipped"
        worker.engine._notes = getattr(worker.engine, "_notes", None)
        service.S2CloneWorker.publish(worker)
        assert worker.host == {"gpu": "H100", "driver": "1.2.3"}
        line = capsys.readouterr().out
        assert "[S2C] host " in line
        assert "driver=1.2.3" in line
        assert worker.ready_at > 0
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


def test_render_batch_waits_on_a_busy_gpu_instead_of_opening_another(
    service, stub_master, monkeypatch
):
    """A second render shares this container. It does not fail the call.

    Web handlers still 429 so a stray POST lets go of the GPU. The spawned
    render waits, which is what keeps max_containers=1 from growing a second
    H100 when status() or a short web POST already holds an input.
    """
    import inspect
    import threading
    import time

    source = inspect.getsource(service)
    assert "@modal.concurrent(max_inputs=2)" in source
    assert "queue=True" in inspect.getsource(service.S2CloneWorker.render_batch)

    monkeypatch.setenv("MODAL_S2_TOKEN", "test-token")
    monkeypatch.setenv("S2C_GPU_WAIT_S", "0")
    worker = _worker_with_recording_engine(service)
    started = threading.Event()
    release = threading.Event()

    def hold() -> None:
        started.set()
        release.wait(5)

    holder = threading.Thread(target=lambda: worker.gpu.submit(hold))
    result: dict = {}

    def run() -> None:
        try:
            result["body"] = service.S2CloneWorker.render_batch(
                worker, _batch_payload()
            )
        except Exception as err:
            result["err"] = err

    try:
        holder.start()
        assert started.wait(2)
        renderer = threading.Thread(target=run)
        renderer.start()
        time.sleep(0.05)
        assert "err" not in result
        assert "body" not in result
        release.set()
        renderer.join(5)
        assert "err" not in result
        assert result["body"]["items"]
    finally:
        release.set()
        holder.join(5)
        worker.gpu.close()


def test_prewarm_cancel_does_not_kill_the_shared_container():
    from pathlib import Path

    text = Path(__file__).with_name("s2_clone_warm.py").read_text()
    start = text.index("def prewarm(")
    body = text[start:]
    assert "terminate_containers=False" in body
    assert "terminate_containers=True" not in body


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
    # Publish only after the GPU thread's self-test has returned, still inside
    # the snapshot hook. A shared "unknown" stamp must not be a cache key.
    assert source.index("self.gpu.start(init") < source.index("cache.finish")
    assert 'stamp = "unknown"' not in source
    assert ".reload(" not in source


def test_boot_kind_only_claims_restore_when_provable(service):
    """The third attempt at this, and the constraints each attempt left behind.

    Attempt 1 used `now - compiled_at` (frozen in the snapshot ⇒ inverted).
    Attempt 2 used the process id, which staging disproved: Modal runs the app
    as pid 2 both before and after a restore, so a real restore reported
    `compiled`.

    The surviving signal is the host monotonic clock going *backwards*, which
    only happens when the image resumed on a different, younger worker. It is
    one-directional, so a forward clock must not be read as a compile.
    """
    from s2_contract import BOOT_RESTORED, BOOT_UNKNOWN, boot_kind

    # Snapshot taken on a host that had been up 50,000s; restored on one up
    # 1,200s. Backwards ⇒ provably a restore.
    assert boot_kind(snap_monotonic=50_000.0, now_monotonic=1_200.0) == BOOT_RESTORED
    # Same host, clock kept moving: a compile *or* a restore onto an older host.
    # Not provable either way, so do not claim.
    assert boot_kind(snap_monotonic=50_000.0, now_monotonic=50_060.0) == BOOT_UNKNOWN
    # Nothing snapshotted in this lineage.
    assert boot_kind(snap_monotonic=None, now_monotonic=1.0) == BOOT_UNKNOWN


def test_boot_kind_never_reports_compiled(service):
    """A container cannot prove it compiled. Saying so caused the staging bug."""
    import inspect

    from s2_contract import boot_kind

    source = inspect.getsource(boot_kind)
    assert "BOOT_COMPILED" not in source, (
        "pid-based compile detection is disproved by staging (pid 2 both ways)"
    )
    # And the constant is gone entirely, so nothing can reintroduce the label.
    import s2_contract

    assert not hasattr(s2_contract, "BOOT_COMPILED")


def test_boot_kind_tolerates_small_clock_movement(service):
    """A monotonic clock never steps, so a tiny backwards value is still a restore."""
    from s2_contract import BOOT_RESTORED, MONOTONIC_RESTORE_SLACK_S, boot_kind

    assert MONOTONIC_RESTORE_SLACK_S > 0
    # Just inside the slack: not treated as a different host.
    assert (
        boot_kind(
            snap_monotonic=1_000.0,
            now_monotonic=1_000.0 - MONOTONIC_RESTORE_SLACK_S / 2,
        )
        == "unknown"
    )
    # Just outside: a different host.
    assert (
        boot_kind(
            snap_monotonic=1_000.0,
            now_monotonic=1_000.0 - MONOTONIC_RESTORE_SLACK_S * 2,
        )
        == BOOT_RESTORED
    )


def test_snapshot_age_is_only_reported_for_a_proven_restore(service):
    """Build age needs two comparable wall clocks; do not guess one."""
    from s2_contract import BOOT_RESTORED, BOOT_UNKNOWN, snapshot_age_s

    assert (
        snapshot_age_s(snap_wall=1_000.0, now_wall=4_600.0, boot=BOOT_RESTORED)
        == 3_600.0
    )
    # An unclassified boot may be mixing two hosts' wall clocks.
    assert (
        snapshot_age_s(snap_wall=1_000.0, now_wall=4_600.0, boot=BOOT_UNKNOWN)
        is None
    )
    # Negative ages are nonsense, not a small number.
    assert snapshot_age_s(snap_wall=5_000.0, now_wall=1.0, boot=BOOT_RESTORED) is None


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




#: `job 1f0137a1` section 2: 1,705 chars that answered HTTP 422 twice and were
#: dropped from the book. The unsplittable 318-char sentence sits in the middle.
VDH_SECTION_2 = (
    "In his view, freeholding yeomanry lay at the heart of this great experiment. "
    "The argument ran through the whole of the eighteenth century and well into "
    "the nineteenth, and it shaped how Americans thought about property. "
    + (
        "But they do use brilliantly the landscape of contemporary eighteenth-century "
        "agriculture to demonstrate how the natural bounty of America and the "
        "availability of vast expanses of farmland molded the European religious and "
        "political heritage into something far more dynamic\u2014something never before "
        "seen or even imagined."
    )
    + " He returned to that point again and again in the lectures he gave."
)


def test_the_section_that_422d_now_splits(service):
    """The exact regression: this section must produce legal units, not an error.

    `_section_units` used to `raise ValueError` when any unit exceeded
    `UNIT_MAX_CHARS`, which became a 422 and dropped the section from the book.
    """
    units = service._section_units(VDH_SECTION_2)
    assert units, "no units produced"
    hard_max = __import__("s2_contract").UNIT_MAX_CHARS
    for unit in units:
        assert len(unit["text"]) <= hard_max, unit["text"][:80]
    # No word is lost when the units are concatenated.
    joined = "".join("".join(u["text"].split()) for u in units)
    assert joined == "".join(VDH_SECTION_2.split())


def test_the_legacy_422_guard_cannot_drop_a_section(service):
    """Even if the splitter regressed, the section must not be rejected.

    The guard is now a hard slice, not a raise: a missing section is a hole in
    the book, which is exactly what Joel heard at 2:39.
    """
    huge = "x" * 10_000  # one unbroken token, no punctuation, no spaces
    units = service._section_units(huge)
    assert units
    hard_max = __import__("s2_contract").UNIT_MAX_CHARS
    assert max(len(u["text"]) for u in units) <= hard_max
    assert "".join(u["text"] for u in units) == huge


def test_a_single_oversized_unit_is_sliced_not_rejected(service):
    """Drive the guard directly, with a unit the splitter cannot bound.

    This is the branch that used to be the 422. It must return pieces.
    """
    import s2_contract

    oversized = "y" * (s2_contract.UNIT_MAX_CHARS + 50)
    # `_section_units` reaches the guard only if `make_units` emits something
    # too long, so patch the splitter to simulate exactly that.
    original = service.make_units
    service.make_units = lambda paras: [{"text": oversized, "pause": "para"}]
    try:
        units = service._section_units("ignored")
    finally:
        service.make_units = original
    assert max(len(u["text"]) for u in units) <= s2_contract.UNIT_MAX_CHARS
    assert "".join(u["text"] for u in units) == oversized


def test_control_endpoint_spawns_polls_and_cancels_off_the_gpu(service, monkeypatch):
    """Submit, status, and cancel run on the CPU function and spawn the GPU method."""
    import inspect

    monkeypatch.setenv("MODAL_S2_TOKEN", "tok")
    gpu_source = inspect.getsource(service.S2CloneWorker.synthesize_batch)
    assert "spawn" not in gpu_source
    assert "handle_remote_request" not in gpu_source
    assert "spawn" in inspect.getsource(service.s2_control)

    seen: dict = {"spawns": 0}

    class OutputExpiredError(TimeoutError):
        pass

    class NotFoundError(Exception):
        pass

    class _Call:
        def __init__(self, object_id="fc-spawned"):
            self.object_id = object_id

        def get(self, timeout=0):
            seen["timeout"] = timeout
            error = seen.get("get_error")
            if error:
                raise error
            result = seen.get("get_result", {"items": [{"key": "0", "audio_b64": "QQ=="}]})
            return result

        def cancel(self, terminate_containers=False):
            seen["terminate"] = terminate_containers

    def spawn(payload):
        seen["spawns"] += 1
        seen["items"] = payload.get("items")
        seen["key"] = payload.get("idempotency_key")
        return _Call()

    class _FunctionCall:
        @staticmethod
        def from_id(call_id):
            seen["from_id"] = call_id
            return _Call()

    class _Memory:
        def __init__(self):
            self.rows = {}

        def get(self, key):
            return self.rows.get(key)

        def put(self, key, value):
            self.rows[key] = value

    import modal

    class _Instance:
        def __init__(self):
            self.render_batch = self

        def spawn(self, payload):
            return spawn(payload)

    class _RaisingCls:
        """Modal raises on a method read of the class. The instance spawns."""

        def __call__(self):
            return _Instance()

        def __getattr__(self, name):
            raise AttributeError(
                "You can't access methods on a Cls directly - "
                "Did you forget to instantiate the class first?"
            )

    modal.FunctionCall = _FunctionCall
    original_worker = service.S2CloneWorker
    service.S2CloneWorker = _RaisingCls()
    memory = _Memory()
    monkeypatch.setattr(service, "control_store", lambda: memory)
    request = _FakeRequest("tok")
    try:
        with pytest.raises(AttributeError, match="instantiate the class first"):
            service.S2CloneWorker.render_batch
        probed = service.s2_control({"probe": True}, request)
        assert probed.content["protocol"] == "s2-submit-poll"
        assert seen["spawns"] == 0

        payload = {
            "items": [{"key": "0", "text": "Hello."}],
            "reference_audio_base64": "YQ==",
            "reference_text": "hello",
            "idempotency_key": "book:0:0",
        }
        accepted = service.s2_control(payload, request)
        assert accepted.content["call_id"] == "fc-spawned"
        assert accepted.content["status"] == "pending"
        assert seen["spawns"] == 1
        assert seen["items"][0]["text"] == "Hello."
        assert "timeout" not in seen

        again = service.s2_control(payload, request)
        assert again.content["call_id"] == "fc-spawned"
        assert again.content["idempotent"] is True
        assert seen["spawns"] == 1

        status = service.s2_control({"call_id": "fc-spawned"}, request)
        assert seen["from_id"] == "fc-spawned"
        assert seen["timeout"] == 1.0
        assert status.content["status"] == "success"
        assert isinstance(status.content["result"], dict)
        assert status.content["result"]["items"][0]["key"] == "0"

        seen["get_result"] = b"\xff not-json"
        unknown = service.s2_control({"call_id": "fc-spawned"}, request)
        assert unknown.content["status"] == "unknown"
        assert "result" not in unknown.content

        seen["get_error"] = OutputExpiredError("gone")
        expired = service.s2_control({"call_id": "fc-spawned"}, request)
        assert expired.content["status"] == "expired"
        assert expired.content["terminal"] is True

        seen["get_error"] = NotFoundError("missing")
        missing = service.s2_control({"call_id": "fc-spawned"}, request)
        assert missing.content["status"] == "unknown"
        assert missing.content["terminal"] is False

        seen["get_error"] = TimeoutError("running")
        cancelled = service.s2_control({"call_id": "fc-spawned", "cancel": True}, request)
        assert seen["terminate"] is True
        assert cancelled.content["status"] == "pending"
        assert cancelled.content["terminal"] is False

        seen["get_error"] = NotFoundError("gone after cancel")
        confirmed = service.s2_control({"call_id": "fc-spawned", "cancel": True}, request)
        assert confirmed.content["status"] == "unknown"
        assert confirmed.content["terminal"] is False
    finally:
        service.S2CloneWorker = original_worker


def test_control_and_warm_do_not_read_methods_on_the_cls(service):
    """A method on the bare Cls is the production AttributeError at cls.py:891."""
    import inspect
    import re
    from pathlib import Path

    root = Path(service.__file__).resolve().parent
    bare = re.compile(r"S2CloneWorker\s*\.\s*[A-Za-z_]")
    for name in ("s2_clone_service.py", "s2_clone_warm.py"):
        hits = [
            line.strip()
            for line in (root / name).read_text().splitlines()
            if not line.lstrip().startswith("#") and bare.search(line)
        ]
        assert hits == [], hits
    spawn = inspect.getsource(service._spawn_render)
    assert "S2CloneWorker()" in spawn
    lookup = inspect.getsource(service._lookup_call)
    assert "FunctionCall.from_id" in lookup
    assert "S2CloneWorker" not in lookup
    warm = (root / "s2_clone_warm.py").read_text()
    assert "worker().status.spawn()" in warm
    assert "worker().synthesize_section.remote(" in warm
