"""Spawn, status, and cancel against a fake FunctionCall.

The shapes are the ones ``FunctionCall`` returns. There is no CLI listing
and no request-body field, because ``modal function calls --json`` does not
print one.
"""

import s2_remote_call as remote


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


def test_submit_returns_the_spawned_id_without_waiting():
    call = _Call()
    spawned = []

    def spawn(payload):
        spawned.append(payload)
        return call

    body = remote.submit_render({"items": [{"key": "0", "text": "Hello."}]}, spawn)
    assert body == {"call_id": "fc-1", "status": "pending"}
    assert spawned[0]["items"][0]["text"] == "Hello."
    assert call.gets == []
    assert call.cancels == []


def test_submit_reads_function_call_id_when_object_id_is_absent():
    class Spawned:
        function_call_id = "fc-alt"

    body = remote.submit_render({"items": []}, lambda _payload: Spawned())
    assert body["call_id"] == "fc-alt"


def test_poll_pending_on_timeout_and_success_on_a_result():
    call = _Call()
    call.get_error = TimeoutError("not finished")
    pending = remote.poll_render("fc-1", call.get)
    assert pending == {"call_id": "fc-1", "status": "pending"}
    assert call.gets == [remote.POLL_GET_TIMEOUT_S]

    call.get_error = None
    done = remote.poll_render("fc-1", call.get)
    assert done["status"] == "success"
    assert done["result"]["items"][0]["key"] == "0"


def test_cancel_terminates_containers_and_notfound_stays_pending():
    call = _Call()
    cancelled = remote.cancel_render("fc-1", call.cancel)
    assert cancelled == {"call_id": "fc-1", "status": "cancelled"}
    assert call.cancels == [True]

    call.cancel_error = RuntimeError("NotFoundError: no such call")
    still = remote.cancel_render("fc-1", call.cancel)
    assert still["status"] == "pending"
    assert "NotFound" in still["error"]


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

    cancelled = remote.handle_remote_request(
        {"call_id": "fc-1", "cancel": True},
        lookup=lookup,
    )
    assert cancelled["status"] == "cancelled"
    assert call.cancels == [True]
