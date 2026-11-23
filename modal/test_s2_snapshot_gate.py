"""/ready has to answer the question a caller actually asks.

Two fields were missing, and their absence produced the PR 324 gate bug:

  `warm_containers: 0` on an idle `min_containers=0` pool is the *normal resting
  state*, not evidence that a placement would compile. So a caller needs to be
  able to tell

  * "nothing is placed" (a capacity queue that resolves itself),
  * "an H100 is restoring or building" (`starting_containers`),
  * "this build can restore" (`snapshot_recorded`).

Before these fields, all three looked the same, and the gate refused the GPU on
an idle pool — routing books to hosted Fish at 3-5x the cost.
"""

from __future__ import annotations

import importlib
import sys
import time

import pytest

MODAL_DIR = __import__("pathlib").Path(__file__).parent


class _FakeDict:
    def __init__(self) -> None:
        self.data: dict[str, dict] = {}

    def __setitem__(self, key, value):
        self.data[key] = dict(value)

    def __getitem__(self, key):
        return self.data[key]

    def get(self, key, default=None):
        return self.data.get(key, default)

    def items(self):
        return list(self.data.items())

    def pop(self, key, default=None):
        return self.data.pop(key, default)


@pytest.fixture(scope="module")
def service():
    from test_s2_service_import import Recorder, _install_stubs

    recorder = Recorder()
    _install_stubs(recorder)
    sys.path.insert(0, str(MODAL_DIR))
    for name in ("s2_contract", "s2_batch", "s2_mastering", "s2_clone_service"):
        sys.modules.pop(name, None)
    module = importlib.import_module("s2_clone_service")
    yield module
    sys.path.remove(str(MODAL_DIR))


@pytest.fixture
def fake_store(service, monkeypatch):
    store = _FakeDict()
    monkeypatch.setattr(service, "heartbeats", store)
    return store


# ── starting_containers arithmetic ──────────────────────────────────────────


@pytest.mark.parametrize(
    "running,warm,expected",
    [
        (0, 0, 0),  # idle pool: the normal resting state
        (1, 0, 1),  # one container placed, still restoring
        (1, 1, 0),  # one container placed and restored
        (2, 1, 1),  # a replace in progress
        (0, 1, 0),  # a warm count above running must not go negative
        (1, 2, 0),
    ],
)
def test_starting_containers_is_running_minus_warm(service, running, warm, expected):
    assert service._starting_containers(running, warm) == expected


def test_starting_containers_never_goes_negative(service):
    """A transient replace can report more warm than running; that is not -1."""
    assert service._starting_containers(1, 3) == 0


def test_running_count_prefers_container_stats(service, monkeypatch):
    """Stats see a building container; heartbeats cannot."""
    monkeypatch.setattr(
        service, "S2CloneWorker", lambda: type("W", (), {"stats": staticmethod(lambda: {"n": 1})})()
    )
    monkeypatch.setattr(service, "running_container_count", lambda s: 1)
    assert service._running_count(0) == (1, "stats")


def test_running_count_falls_back_to_the_heartbeat_count(service, monkeypatch):
    """A stats read that fails is a lower bound, not a guess."""
    monkeypatch.setattr(
        service,
        "S2CloneWorker",
        lambda: type("W", (), {"stats": staticmethod(lambda: (_ for _ in ()).throw(RuntimeError("nope")))})(),
    )
    assert service._running_count(2) == (2, "heartbeats")


def test_running_count_falls_back_when_no_stats_method_exists(service, monkeypatch):
    monkeypatch.setattr(service, "S2CloneWorker", lambda: object())
    assert service._running_count(0) == (0, "heartbeats")


# ── the recorded-snapshot marker ────────────────────────────────────────────


def test_a_missing_marker_is_none_not_false(service, fake_store):
    """`None` is "cannot answer". `False` would be a claim the probe cannot make."""
    assert service._snapshot_mark("build-abc") is None


def test_a_recorded_marker_is_returned(service, fake_store):
    fake_store.data["snapshot:build-abc"] = {
        "build": "build-abc",
        "state": service.SNAPSHOT_MARK_NAME,
        "at": int(time.time()),
    }
    mark = service._snapshot_mark("build-abc")
    assert mark is not None
    assert mark["build"] == "build-abc"


def test_a_marker_for_another_build_is_ignored(service, fake_store):
    fake_store.data["snapshot:build-abc"] = {
        "build": "build-old",
        "state": service.SNAPSHOT_MARK_NAME,
        "at": int(time.time()),
    }
    assert service._snapshot_mark("build-abc") is None


def test_a_marker_with_the_wrong_state_is_ignored(service, fake_store):
    # A container heartbeat is not a snapshot marker, and must not be read as
    # one just because it shares the Dict.
    fake_store.data["snapshot:build-abc"] = {
        "build": "build-abc",
        "state": "ready",
        "at": int(time.time()),
    }
    assert service._snapshot_mark("build-abc") is None


def test_a_non_dict_row_is_ignored(service, fake_store):
    fake_store.data["snapshot:build-abc"] = "not a row"
    assert service._snapshot_mark("build-abc") is None


def test_an_unreadable_store_is_none(service, monkeypatch):
    class Boom:
        def __getitem__(self, key):
            raise RuntimeError("control plane unavailable")

    # An unreadable registry must not raise out of a health probe.
    assert service._snapshot_mark("build-abc", registry=Boom()) is None


def test_the_marker_name_is_distinct_from_a_container_heartbeat(service):
    """Both live in the same Dict; only the state tells them apart."""
    assert service.SNAPSHOT_MARK_NAME != "ready"


# ── the /ready payload ──────────────────────────────────────────────────────


def _payload_of(response) -> dict:
    """A plain `return` is the dict; the 503 path is a `JSONResponse` stub."""
    if isinstance(response, dict):
        return response
    content = getattr(response, "content", None)
    assert isinstance(content, dict), "the 503 path must carry the payload"
    return content


def _ready_payload(monkeypatch, service, *, running: int, live_rows: int):
    """Call the real handler with a stubbed container count and heartbeat set."""
    monkeypatch.setenv("MODAL_S2_TOKEN", "test-token")
    build = service._BUILD_ENV["S2C_BUILD"]
    store = _FakeDict()
    now = int(time.time())
    for i in range(live_rows):
        store.data[f"c-{i}"] = {
            "build": build,
            "state": "ready",
            "at": now,
            "container_id": f"c-{i}",
        }
    monkeypatch.setattr(service, "heartbeats", store)
    monkeypatch.setattr(service, "_live_containers", lambda b, registry=None: list(store.data.values()))
    monkeypatch.setattr(service, "_running_count", lambda warm: (running, "stats"))

    class _Req:
        headers = {"x-echomancer-token": "test-token"}

    return _payload_of(service.ready(_Req()))


def test_ready_reports_starting_containers_separately_from_warm(service, monkeypatch):
    payload = _ready_payload(monkeypatch, service, running=1, live_rows=0)
    assert payload["warm_containers"] == 0
    assert payload["starting_containers"] == 1, (
        "a container that is placed but not restored must be visible, or an "
        "idle pool and a building H100 look identical"
    )


def test_ready_reports_zero_starting_for_an_idle_pool(service, monkeypatch):
    payload = _ready_payload(monkeypatch, service, running=0, live_rows=0)
    assert payload["warm_containers"] == 0
    assert payload["starting_containers"] == 0


def test_ready_reports_the_snapshot_marker(service, monkeypatch):
    payload = _ready_payload(monkeypatch, service, running=0, live_rows=0)
    assert payload["snapshot_recorded"] is False
    assert payload["snapshot_recorded_at"] is None


def test_ready_reports_a_recorded_snapshot(service, monkeypatch):
    monkeypatch.setenv("MODAL_S2_TOKEN", "test-token")
    build = service._BUILD_ENV["S2C_BUILD"]
    store = _FakeDict()
    store.data[f"snapshot:{build}"] = {
        "build": build,
        "state": service.SNAPSHOT_MARK_NAME,
        "at": 1_700_000_000,
    }
    monkeypatch.setattr(service, "heartbeats", store)
    monkeypatch.setattr(service, "_live_containers", lambda b, registry=None: [])
    monkeypatch.setattr(service, "_running_count", lambda warm: (0, "stats"))

    class _Req:
        headers = {"x-echomancer-token": "test-token"}

    payload = _payload_of(service.ready(_Req()))
    assert payload["snapshot_recorded"] is True
    assert payload["snapshot_recorded_at"] == 1_700_000_000
    # And the marker is not counted as a warm container.
    assert payload["warm_containers"] == 0


def test_ready_still_reports_the_fields_the_worker_already_reads(service, monkeypatch):
    payload = _ready_payload(monkeypatch, service, running=0, live_rows=0)
    for field in ("ready", "warm_containers", "max_containers", "build", "version",
                  "recipe", "audio_transport", "max_batch_items"):
        assert field in payload, field
