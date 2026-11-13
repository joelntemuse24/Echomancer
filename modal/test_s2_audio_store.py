"""R2 offload for a wide clone batch. No network, no GPU."""

import http.client
import threading
from datetime import datetime, timezone

import pytest

from s2_audio_store import (
    AudioStoreError,
    KeepAlivePool,
    UploadPool,
    audio_fields,
    object_key,
    put_mp3,
    signed_put,
    transport_name,
)

ENV = {
    "R2_ACCOUNT_ID": "acct",
    "R2_ACCESS_KEY_ID": "AKIA_TEST",
    "R2_SECRET_ACCESS_KEY": "super-secret-value",
    "R2_BUCKET_NAME": "echomancer-audio",
}


def test_missing_credentials_stay_inline():
    assert transport_name({}) == "inline"
    assert transport_name({"R2_ACCOUNT_ID": "acct"}) == "inline"


def test_complete_credentials_use_r2():
    env = {
        "R2_ACCOUNT_ID": "acct",
        "R2_ACCESS_KEY_ID": "key",
        "R2_SECRET_ACCESS_KEY": "secret",
    }
    assert transport_name(env) == "r2"


def test_object_key_drops_path_characters():
    key = object_key("../job", "call/1", "row 2")
    assert key == "s2-takes/job/call1/row2.mp3"
    assert ".." not in key


def test_inline_row_keeps_audio_b64():
    row = audio_fields({}, "0", b"mp3-bytes", "job", "call")
    assert row["key"] == "0"
    assert "audio_b64" in row
    assert "storage_key" not in row


def test_r2_row_returns_a_key_and_not_the_mp3():
    seen = {}

    def opener(url, body, headers):
        seen["url"] = url
        seen["body"] = body
        seen["authorization"] = headers["Authorization"]

    row = audio_fields(ENV, "3", b"mp3-bytes", "job", "call", opener=opener)
    assert row["storage_key"] == "s2-takes/job/call/3.mp3"
    assert row["audio_bytes"] == len(b"mp3-bytes")
    assert "audio_b64" not in row
    assert seen["body"] == b"mp3-bytes"
    assert seen["url"].startswith("https://acct.r2.cloudflarestorage.com/")
    assert "super-secret-value" not in seen["url"]
    assert "super-secret-value" not in seen["authorization"]


def test_a_failed_put_does_not_inline_the_mp3():
    def opener(url, body, headers):
        raise OSError("down")

    row = audio_fields(ENV, "0", b"x" * 1000, "job", "call", opener=opener)
    assert row["error_code"] == "audio_store"
    assert "audio_b64" not in row


def test_signature_is_stable_and_covers_the_body():
    moment = datetime(2026, 11, 13, 12, 0, 0, tzinfo=timezone.utc)
    url, headers = signed_put(ENV, "s2-takes/job/call/0.mp3", b"mp3", moment)
    again, again_headers = signed_put(ENV, "s2-takes/job/call/0.mp3", b"mp3", moment)
    assert url == again
    assert headers["Authorization"] == again_headers["Authorization"]
    assert headers["Authorization"].startswith("AWS4-HMAC-SHA256 ")
    assert "auto/s3/aws4_request" in headers["Authorization"]
    changed, changed_headers = signed_put(ENV, "s2-takes/job/call/0.mp3", b"other", moment)
    assert changed == url
    assert changed_headers["Authorization"] != headers["Authorization"]


def test_put_mp3_wraps_transport_errors():
    with pytest.raises(AudioStoreError):
        put_mp3(
            ENV,
            "s2-takes/job/call/0.mp3",
            b"mp3",
            opener=lambda *_: (_ for _ in ()).throw(TimeoutError()),
        )


def test_a_transient_failure_is_retried_before_it_is_reported():
    """One 503 must not lose a section: attempt 2 is a fresh socket."""
    attempts = []

    def opener(url, body, headers):
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("connection reset")

    row = audio_fields(ENV, "0", b"mp3-bytes", "job", "call", opener=opener)
    assert row["storage_key"]
    assert len(attempts) == 2


def test_three_failures_are_reported_without_falling_back_to_base64():
    attempts = []

    def opener(url, body, headers):
        attempts.append(1)
        raise OSError("down")

    row = audio_fields(ENV, "0", b"mp3-bytes", "job", "call", opener=opener)
    assert row["error_code"] == "audio_store"
    assert "audio_b64" not in row
    assert len(attempts) == 3


# ── the keep-alive pool ────────────────────────────────────────────────────


class _FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status

    def read(self) -> bytes:
        return b""


class _FakeConn:
    """Records requests; answers from a scripted list of statuses.

    Each connection owns its own copy of the script, so a retry (which discards
    the socket and borrows a fresh one) can be given a different answer from the
    first attempt.
    """

    def __init__(self, statuses, raises=None) -> None:
        self.statuses = list(statuses)
        self.raises = list(raises or [])
        self.requests: list[tuple] = []
        self.closed = False

    def request(self, method, path, body=None, headers=None):
        self.requests.append((method, path, body))
        if self.raises:
            raise self.raises.pop(0)

    def getresponse(self):
        if not self.statuses:
            # A pooled socket serves many requests; the script repeats its last
            # answer rather than running out.
            return _FakeResponse(200)
        return _FakeResponse(self.statuses.pop(0))

    def close(self):
        self.closed = True


class _CountingFactory:
    """Hands out one `_FakeConn` per borrow, from a per-attempt script.

    `statuses` is either one flat list (every socket answers from it) or a list
    of per-attempt scripts. The latter is what the retry tests need: attempt 1
    gets a 503, attempt 2 gets a 200.
    """

    def __init__(self, statuses=(200,), raises=None) -> None:
        self.conns: list[_FakeConn] = []
        self.statuses = statuses
        self.raises = raises
        self.calls = 0

    def __call__(self, host, timeout):
        self.calls += 1
        statuses = self.statuses
        if statuses and isinstance(statuses[0], (list, tuple)):
            statuses = statuses[min(self.calls - 1, len(statuses) - 1)]
        raises = self.raises
        if raises and isinstance(raises[0], (list, tuple)):
            raises = raises[min(self.calls - 1, len(raises) - 1)]
        conn = _FakeConn(statuses, raises)
        self.conns.append(conn)
        return conn


def test_one_handshake_serves_many_uploads():
    """The whole point: 24 serial rows must not open 24 sockets."""
    factory = _CountingFactory()
    pool = KeepAlivePool(connector=factory)
    for i in range(24):
        put_mp3(ENV, f"s2-takes/job/call/{i}.mp3", b"x" * 64, pool=pool)
    assert factory.calls == 1, "a reused socket must not be re-opened"
    assert pool.handshakes == 1
    assert pool.reused == 23
    pool.close()


def test_concurrent_uploads_reuse_a_bounded_socket_set():
    factory = _CountingFactory()
    pool = KeepAlivePool(connector=factory, size=4)
    errors: list[BaseException] = []

    def upload(i: int) -> None:
        try:
            put_mp3(ENV, f"s2-takes/job/call/{i}.mp3", b"x" * 64, pool=pool)
        except BaseException as err:  # pragma: no cover - surfaced below
            errors.append(err)

    threads = [threading.Thread(target=upload, args=(i,)) for i in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert not errors
    assert 1 <= factory.calls <= 16, factory.calls
    assert pool.reused + pool.handshakes == 16
    pool.close()


def test_a_retryable_status_discards_the_socket_and_retries():
    factory = _CountingFactory(statuses=((503,), (200,)))
    pool = KeepAlivePool(connector=factory)
    put_mp3(ENV, "s2-takes/job/call/0.mp3", b"mp3", pool=pool)
    assert factory.calls == 2, "a 503 socket is not returned to the pool"
    assert factory.conns[0].closed is True
    pool.close()


def test_a_403_is_not_retried():
    factory = _CountingFactory(statuses=(403,))
    pool = KeepAlivePool(connector=factory)
    with pytest.raises(AudioStoreError):
        put_mp3(ENV, "s2-takes/job/call/0.mp3", b"mp3", pool=pool)
    assert factory.calls == 1
    pool.close()


def test_a_disconnected_socket_is_replaced_not_reused():
    factory = _CountingFactory(raises=((http.client.RemoteDisconnected("gone"),), ()))
    pool = KeepAlivePool(connector=factory)
    put_mp3(ENV, "s2-takes/job/call/0.mp3", b"mp3", pool=pool)
    assert factory.calls == 2
    assert factory.conns[0].closed is True
    pool.close()


def test_the_pool_refuses_a_second_host():
    factory = _CountingFactory()
    pool = KeepAlivePool(connector=factory)
    pool.put("https://acct.r2.cloudflarestorage.com/bucket/a.mp3", b"x", {})
    other = {**ENV, "R2_ACCOUNT_ID": "other"}
    with pytest.raises(AudioStoreError):
        put_mp3(other, "s2-takes/job/call/0.mp3", b"mp3", pool=pool)
    pool.close()


# ── the upload pool ────────────────────────────────────────────────────────


def test_an_inline_upload_pool_returns_base64_rows():
    pool = UploadPool({})
    try:
        row = pool.fields("0", b"mp3-bytes", "job", "call")
    finally:
        pool.close()
    assert "audio_b64" in row


def test_uploads_run_concurrently_and_keep_call_order():
    """A page of 24 rows must overlap its PUTs, not serialise them."""
    import time

    factory = _CountingFactory()
    sockets = KeepAlivePool(connector=factory)
    in_flight = 0
    peak = 0
    lock = threading.Lock()

    def slow_factory(host, timeout):
        nonlocal in_flight, peak
        with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        time.sleep(0.02)
        with lock:
            in_flight -= 1
        conn = _FakeConn((200,))
        factory.conns.append(conn)
        return conn

    sockets._connector = slow_factory
    pool = UploadPool(ENV, workers=8, pool=sockets)
    try:
        futures = [pool.submit(str(i), b"x" * 32, "job", "call") for i in range(16)]
        rows = [future.result(10) for future in futures]
    finally:
        pool.close()
    assert [row["key"] for row in rows] == [str(i) for i in range(16)]
    assert all(row.get("storage_key") for row in rows)
    assert peak > 1, "uploads must overlap, not run one after another"


def test_a_forced_inline_diagnostic_row_is_possible_with_r2_set():
    row = audio_fields(ENV, "0", b"mp3-bytes", "job", "call", forced="inline")
    assert "audio_b64" in row
    assert "storage_key" not in row
