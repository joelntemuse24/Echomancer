"""`/ready` must count containers that are actually alive.

Staging saw `warm_containers` exceed `max_containers` briefly after a container
scaled down. The cause was structural, not a rounding error: a heartbeat was
only written when a container *served a call*, so the TTL had to be long (420 s)
to avoid dropping a warm-but-idle container — and a 420 s TTL means a container
that scaled down lingers in the count for seven minutes.

Two changes make a short TTL safe and the count honest:

1. a container refreshes its own heartbeat on a timer, so idle ≠ stale;
2. `@modal.exit()` removes the entry the moment a container stops.

The TTL stays as the backstop for an ungraceful kill, which cannot run a hook.
"""

from __future__ import annotations

import importlib
import sys
import threading
import time
import types

import pytest


MODAL_DIR = __import__("pathlib").Path(__file__).parent


class _FakeHeartbeatDict:
    """Stand-in for `modal.Dict`, recording writes and removals."""

    def __init__(self) -> None:
        self.data: dict[str, dict] = {}
        self.writes = 0
        self.pops = 0
        self._lock = threading.Lock()

    def __setitem__(self, key, value):
        with self._lock:
            self.data[key] = dict(value)
            self.writes += 1

    def __getitem__(self, key):
        return self.data[key]

    def items(self):
        with self._lock:
            return list(self.data.items())

    def pop(self, key, default=None):
        with self._lock:
            self.pops += 1
            return self.data.pop(key, default)


@pytest.fixture(scope="module")
def service():
    """The real service module, imported against the shared stubs."""
    from test_s2_service_import import Recorder, _install_stubs

    recorder = Recorder()
    _install_stubs(recorder)
    sys.path.insert(0, str(MODAL_DIR))
    for name in ("s2_contract", "s2_batch", "s2_mastering", "s2_clone_service"):
        sys.modules.pop(name, None)
    module = importlib.import_module("s2_clone_service")
    # So tests can assert on which lifecycle hooks were decorated.
    module._recorder = recorder  # type: ignore[attr-defined]
    yield module
    sys.path.remove(str(MODAL_DIR))


def _live(build: str, registry=None):
    """Live count for one build, against the fake registry."""
    import s2_clone_service

    return s2_clone_service._live_containers(build, registry=registry)


@pytest.fixture
def fake_heartbeats(service, monkeypatch):
    fake = _FakeHeartbeatDict()
    monkeypatch.setattr(service, "heartbeats", fake)
    return fake


def _worker(service, *, container_id: str = "c-test"):
    """A worker with just the attributes the liveness hooks touch."""
    worker = object.__new__(service.S2CloneWorker)
    worker.container_id = container_id
    worker.boot_kind = "restored"
    worker.snapshot_age_s = 12.0
    worker.calls = 0
    worker._heartbeat_at = 0.0
    worker._stopped = threading.Event()
    return worker


# ── the exit hook ─────────────────────────────────────────────────────────


def test_exit_removes_the_heartbeat_immediately(service, fake_heartbeats):
    worker = _worker(service)
    worker._heartbeat(force=True)
    assert worker.container_id in fake_heartbeats.data

    service.S2CloneWorker.exit(worker)

    assert worker.container_id not in fake_heartbeats.data, (
        "a stopped container must not keep counting toward warm_containers"
    )
    assert fake_heartbeats.pops == 1


def test_exit_stops_the_heartbeat_timer(service, fake_heartbeats, monkeypatch):
    import s2_clone_service

    monkeypatch.setattr(s2_clone_service, "HEARTBEAT_MIN_INTERVAL", 5)
    worker = _worker(service)
    worker.exit_hook_threads = []
    service.S2CloneWorker._start_heartbeat_timer(worker)
    thread = worker._heartbeat_thread
    assert thread.is_alive()

    service.S2CloneWorker.exit(worker)

    assert worker._stopped.is_set()
    thread.join(5)
    assert not thread.is_alive(), "the timer must not outlive the container"


def test_exit_survives_a_dict_failure(service, monkeypatch):
    """Teardown must never raise; a lost pop costs at most a stale count."""
    broken = _FakeHeartbeatDict()

    def boom(key, default=None):
        raise RuntimeError("control plane unavailable")

    broken.pop = boom  # type: ignore[method-assign]
    monkeypatch.setattr(service, "heartbeats", broken)
    worker = _worker(service)
    service.S2CloneWorker.exit(worker)  # must not raise


def test_exit_does_not_tear_down_the_gpu_executor(service, fake_heartbeats, monkeypatch):
    """A request may still be finishing inside Modal's grace period.

    Closing the executor here would kill it for no benefit: the process is
    going away, and `/ready` only reads the heartbeat. Pinned so a future
    "tidy-up" does not reintroduce a way to fail an in-flight section.
    """
    worker = _worker(service)
    closed = {"called": False}

    class _Gpu:
        def close(self):
            closed["called"] = True

    worker.gpu = _Gpu()
    service.S2CloneWorker.exit(worker)
    assert closed["called"] is False


def test_exit_is_registered_as_a_modal_hook(service):
    recorded = [e for e in service._recorder.exits]
    assert any(e["method"] == "exit" for e in recorded), (
        "the teardown hook must be decorated, or Modal never calls it"
    )


# ── the timer ─────────────────────────────────────────────────────────────


def test_the_timer_keeps_an_idle_container_fresh(service, fake_heartbeats):
    """This is what allows a short TTL without dropping a warm idle container."""
    worker = _worker(service)
    service.S2CloneWorker._heartbeat(worker, force=True)
    first = fake_heartbeats.data[worker.container_id]["at"]

    # Simulate the timer firing after the TTL would have expired.
    time.sleep(0.01)
    worker._heartbeat_at = 0.0
    service.S2CloneWorker._heartbeat(worker, force=True)
    second = fake_heartbeats.data[worker.container_id]["at"]

    assert second >= first
    assert fake_heartbeats.writes >= 2


def test_the_timer_is_a_daemon_so_it_cannot_block_exit(service, fake_heartbeats):
    worker = _worker(service)
    service.S2CloneWorker._start_heartbeat_timer(worker)
    try:
        assert worker._heartbeat_thread.daemon is True
    finally:
        worker._stopped.set()


# ── the ready count ───────────────────────────────────────────────────────


def test_ready_counts_only_live_containers_of_this_build(
    service, fake_heartbeats, monkeypatch
):
    import s2_clone_service

    monkeypatch.setattr(s2_clone_service, "HEARTBEAT_TTL_SECONDS", 90)
    build = service._BUILD_ENV["S2C_BUILD"]
    now = int(time.time())
    fake_heartbeats.data["live"] = {
        "build": build, "state": "ready", "at": now, "boot": "restored"
    }
    fake_heartbeats.data["stale"] = {
        "build": build, "state": "ready", "at": now - 200, "boot": "restored"
    }
    fake_heartbeats.data["old-build"] = {
        "build": "0ldbui1d", "state": "ready", "at": now, "boot": "restored"
    }

    live = _live(build, fake_heartbeats)
    # Exactly one entry, and it is the live one: the stale entry is past the TTL
    # and the other entry belongs to a different build.
    assert len(live) == 1


def test_a_stale_entry_is_excluded_well_before_the_old_ttl(
    service, fake_heartbeats, monkeypatch
):
    """The bug: 420 s TTL meant a scaled-down container counted for minutes."""
    import s2_clone_service

    monkeypatch.setattr(s2_clone_service, "HEARTBEAT_TTL_SECONDS", 90)
    build = "abc123def456"
    # A container that scaled down 200 s ago.
    fake_heartbeats.data["gone"] = {
        "build": build, "state": "ready", "at": int(time.time()) - 200
    }
    assert _live(build, fake_heartbeats) == [], (
        "a container idle for 200s must not count once the TTL is 90s"
    )


def test_the_default_ttl_is_short_enough_to_bound_the_count(service):
    """Regression guard on the number itself, with the reason recorded."""
    assert service.HEARTBEAT_TTL_SECONDS <= 180, (
        "a long TTL lets a scaled-down container inflate warm_containers; the "
        "timer now keeps live entries fresh, so the TTL can be short"
    )
    # And it must be comfortably longer than the refresh interval, or a healthy
    # container would flap out of /ready between ticks.
    assert service.HEARTBEAT_TTL_SECONDS >= service.HEARTBEAT_MIN_INTERVAL * 2


def test_ready_does_not_report_more_than_max_containers_after_scale_down(
    service, fake_heartbeats, monkeypatch
):
    """End-to-end shape of the reported symptom.

    Two containers warm, `max_containers=1`: one is a zombie entry. After its
    exit hook runs the count must be back within the cap.
    """
    import s2_clone_service

    monkeypatch.setattr(s2_clone_service, "HEARTBEAT_TTL_SECONDS", 90)
    build = service._BUILD_ENV["S2C_BUILD"]
    now = int(time.time())
    alive = _worker(service, container_id="c-alive")
    gone = _worker(service, container_id="c-gone")
    alive._heartbeat(force=True)
    gone._heartbeat(force=True)

    # Both counted while both are genuinely up (a transient overshoot of the
    # cap is unavoidable when a container is starting before an old one exits).
    assert len(_live(build, fake_heartbeats)) == 2

    # The scaled-down container announces itself.
    service.S2CloneWorker.exit(gone)

    live = _live(build, fake_heartbeats)
    assert len(live) == 1
    assert live[0]["build"] == build
    assert live[0]["at"] >= now
