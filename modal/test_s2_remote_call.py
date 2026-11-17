"""Spawn, status, and cancel against a fake FunctionCall.

The shapes are the ones ``FunctionCall`` returns. ``OutputExpiredError``
subclasses ``TimeoutError``, the way Modal client 1.6.4 does. ``get()``
can return a dict or bytes. There is no CLI listing and no request-body
field, because ``modal function calls --json`` does not print one.
"""

import s2_remote_call as remote


class OutputExpiredError(TimeoutError):
    pass


class NotFoundError(Exception):
    pass


class _Call:
    def __init__(self, object_id="fc-1"):
        self.object_id = object_id
        self.gets = []
        self.cancels = []
        self.get_result = {"items": [{"key": "0", "audio_b64": "QQ=="}]}
        self.get_error = None
        self.cancel_error = None

    def get(self, timeout=0):
        self.gets.append(timeout)
        if self.get_error:
            raise self.get_error
        return self.get_result

    def cancel(self, terminate_containers=False):
        self.cancels.append(terminate_containers)
        if self.cancel_error:
            raise self.cancel_error


class _Lookup:
    def __init__(self, call):
        self.call = call
        self.ids = []

    def __call__(self, call_id):
        self.ids.append(call_id)
        return self.call


class _Store:
    def __init__(self):
        self.rows = {}

    def get(self, key):
        return self.rows.get(key)

    def put(self, key, value):
        self.rows[key] = value


def test_submit_returns_the_spawned_id_without_waiting():
    call = _Call()
    spawned = []

    def spawn(payload):
        spawned.append(payload)
        return call

    body = remote.submit_render({"items": [{"key": "0", "text": "Hello."}]}, spawn)
    assert body["call_id"] == "fc-1"
    assert body["status"] == "pending"
    assert body["terminal"] is False
    assert body["protocol"] == remote.CONTROL_PROTOCOL
    assert spawned[0]["items"][0]["text"] == "Hello."
    assert call.gets == []
    assert call.cancels == []


def test_a_repeated_submit_returns_the_stored_id():
    store = _Store()
    spawned = []

    def spawn(_payload):
        spawned.append(object())
        return _Call(object_id=f"fc-{len(spawned)}")

    payload = {
        "items": [{"key": "0", "text": "Hello."}],
        "idempotency_key": "book-1:0:0",
    }
    first = remote.submit_render(payload, spawn, store=store, now=1_000)
    second = remote.submit_render(payload, spawn, store=store, now=1_001)
    assert first["call_id"] == "fc-1"
    assert second["call_id"] == "fc-1"
    assert second["idempotent"] is True
    assert len(spawned) == 1
    # A row older than the TTL is not the same call.
    third = remote.submit_render(
        payload, spawn, store=store, now=1_000 + remote.IDEMPOTENCY_TTL_S + 5
    )
    assert third["call_id"] == "fc-2"
    assert len(spawned) == 2


def test_lookup_by_key_returns_the_stored_id_and_does_not_spawn():
    store = _Store()
    spawned = []

    def spawn(_payload):
        spawned.append(object())
        return _Call(object_id=f"fc-{len(spawned)}")

    payload = {
        "items": [{"key": "0", "text": "Hello."}],
        "idempotency_key": "book-1:0:0",
    }
    remote.submit_render(payload, spawn, store=store, now=1_000)
    assert remote.request_op({"lookup": True, "idempotency_key": "book-1:0:0"}) == "lookup"
    # A book body is still a submit, even if lookup is also set.
    assert remote.request_op({**payload, "lookup": True}) == "submit"
    looked = remote.handle_remote_request(
        {"lookup": True, "idempotency_key": "book-1:0:0"},
        spawn=spawn,
        store=store,
        now=1_001,
    )
    assert looked["call_id"] == "fc-1"
    assert looked["status"] == "pending"
    assert looked["idempotent"] is True
    assert len(spawned) == 1
    missing = remote.handle_remote_request(
        {"lookup": True, "idempotency_key": "book-1:9:0"},
        spawn=spawn,
        store=store,
        now=1_002,
    )
    assert missing["status"] == "absent"
    assert "call_id" not in missing
    assert missing["terminal"] is False
    assert len(spawned) == 1


def test_submit_reads_function_call_id_when_object_id_is_absent():
    class Spawned:
        function_call_id = "fc-alt"

    body = remote.submit_render({"items": []}, lambda _payload: Spawned())
    assert body["call_id"] == "fc-alt"


def test_poll_timeout_expired_not_found_and_a_dict_result():
    call = _Call()
    call.get_error = TimeoutError("not finished")
    pending = remote.poll_render("fc-1", call.get)
    assert pending["status"] == "pending"
    assert pending["terminal"] is False
    assert call.gets == [remote.POLL_GET_TIMEOUT_S]

    call.get_error = OutputExpiredError("no outputs")
    expired = remote.poll_render("fc-1", call.get)
    assert expired["status"] == "expired"
    assert expired["terminal"] is True
    assert expired["miss"] is True
    assert "result" not in expired

    call.get_error = NotFoundError("no such input")
    missing = remote.poll_render("fc-1", call.get)
    assert missing["status"] == "unknown"
    assert missing["terminal"] is False
    assert missing.get("miss") is not True

    call.get_error = None
    done = remote.poll_render("fc-1", call.get)
    assert done["status"] == "success"
    assert done["result"]["items"][0]["key"] == "0"
    assert isinstance(done["result"], dict)


def test_poll_bytes_stay_unknown_and_are_not_embedded():
    call = _Call()
    call.get_result = b"\xff\xfe not json"
    unknown = remote.poll_render("fc-1", call.get)
    assert unknown["status"] == "unknown"
    assert unknown["terminal"] is False
    assert "result" not in unknown

    class _Response:
        content = b'{"items": []}'

    call.get_result = _Response()
    still = remote.poll_render("fc-1", call.get)
    assert still["status"] == "unknown"
    blob = str(still)
    assert "xff" not in blob
    assert "items" not in still


def test_cancel_rereads_status_and_does_not_assume_success():
    call = _Call()
    call.get_error = TimeoutError("still running")
    pending = remote.cancel_render(
        "fc-1", call.cancel, read_status=lambda: remote.poll_render("fc-1", call.get)
    )
    assert call.cancels == [True]
    assert pending["status"] == "pending"
    assert pending["terminal"] is False

    call.cancel_error = NotFoundError("not published")
    call.get_error = TimeoutError("still pending")
    still = remote.cancel_render(
        "fc-1", call.cancel, read_status=lambda: remote.poll_render("fc-1", call.get)
    )
    assert still["status"] == "pending"

    call.get_error = NotFoundError("gone")
    gone = remote.cancel_render(
        "fc-1", call.cancel, read_status=lambda: remote.poll_render("fc-1", call.get)
    )
    assert gone["status"] == "unknown"
    assert gone["terminal"] is False

    call.cancel_error = None
    call.get_error = OutputExpiredError("expired")
    expired = remote.cancel_render(
        "fc-1", call.cancel, read_status=lambda: remote.poll_render("fc-1", call.get)
    )
    assert expired["status"] == "expired"
    assert expired["terminal"] is True


def test_handle_request_submit_status_cancel_and_query():
    call = _Call()
    lookup = _Lookup(call)
    spawned = []

    submit = remote.handle_remote_request(
        {"items": [{"key": "0", "text": "Hello."}]},
        spawn=lambda payload: spawned.append(payload) or call,
        lookup=lookup,
    )
    assert submit["status"] == "pending"
    assert submit["call_id"] == "fc-1"
    assert lookup.ids == []

    status = remote.handle_remote_request(
        {"call_id": "fc-1"},
        spawn=lambda _payload: (_ for _ in ()).throw(AssertionError("status must not spawn")),
        lookup=lookup,
    )
    assert status["status"] == "success"
    assert lookup.ids == ["fc-1"]

    class Request:
        query_params = {"call_id": "fc-1"}

    queried = remote.handle_remote_request(
        {},
        query_call_id=remote.query_call_id(Request()),
        lookup=lookup,
    )
    assert queried["status"] == "success"

    call.get_error = OutputExpiredError("expired")
    cancelled = remote.handle_remote_request(
        {"call_id": "fc-1", "cancel": True},
        lookup=lookup,
    )
    assert cancelled["status"] == "expired"
    assert cancelled["terminal"] is True
    assert call.cancels == [True]


def test_probe_does_not_spawn():
    spawned = []
    body = remote.handle_remote_request(
        {"probe": True},
        spawn=lambda payload: spawned.append(payload),
    )
    assert body["protocol"] == "s2-submit-poll"
    assert body["protocol_version"] == 1
    assert spawned == []
