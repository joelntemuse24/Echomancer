"""Submit, poll, and cancel one S2 render without reading a function-call listing.

The web endpoint spawns the GPU method and returns the FunctionCall id
immediately. Status and cancel use that id. ``modal function calls`` does not
include the request body, so nothing here matches a tag or a job id.

This module is stdlib-only. The service wires it to ``modal.FunctionCall``.
"""

from __future__ import annotations

POLL_GET_TIMEOUT_S = 1.0


class RemoteCallError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        super().__init__(message)


def call_id_of(spawned) -> str:
    for name in ("object_id", "function_call_id"):
        value = getattr(spawned, name, None)
        if value:
            return str(value)
    raise RemoteCallError(500, "spawn_missing_id", "spawn did not return a function-call id")


def query_call_id(request) -> str:
    params = getattr(request, "query_params", None)
    if params is None or not hasattr(params, "get"):
        return ""
    try:
        value = params.get("call_id")
    except Exception:
        return ""
    return str(value or "").strip()


def request_op(payload, query: str = "") -> str:
    """``submit`` renders. ``status`` and ``cancel`` address an existing id."""
    body = payload if isinstance(payload, dict) else {}
    call_id = str(body.get("call_id") or query or "").strip()
    if body.get("cancel") is True and call_id:
        return "cancel"
    # A body that still carries the book is a submit, even if an id is echoed.
    if call_id and not body.get("items") and not body.get("text"):
        return "status"
    return "submit"


def submit_render(payload, spawn) -> dict:
    if not callable(spawn):
        raise RemoteCallError(500, "spawn_unavailable", "GPU spawn is not available")
    spawned = spawn(payload)
    return {"call_id": call_id_of(spawned), "status": "pending"}


def _timed_out(err: BaseException) -> bool:
    return err.__class__.__name__ in {"TimeoutError", "FunctionTimeoutError"} or isinstance(
        err, TimeoutError
    )


def poll_render(call_id: str, get, *, timeout_s: float = POLL_GET_TIMEOUT_S) -> dict:
    try:
        result = get(timeout=timeout_s)
    except Exception as err:
        if _timed_out(err):
            return {"call_id": call_id, "status": "pending"}
        return {
            "call_id": call_id,
            "status": "failure",
            "error": f"{type(err).__name__}: {err}",
        }
    if isinstance(result, dict) and result.get("error") and not result.get("items"):
        return {
            "call_id": call_id,
            "status": "failure",
            "error": result.get("error"),
            "result": result,
        }
    return {"call_id": call_id, "status": "success", "result": result}


def cancel_render(call_id: str, cancel) -> dict:
    try:
        cancel(terminate_containers=True)
    except Exception as err:
        text = f"{type(err).__name__}: {err}"
        lowered = text.lower()
        # NotFound means Modal has not published the call yet. It is still live.
        if "notfound" in lowered or "not found" in lowered:
            return {"call_id": call_id, "status": "pending", "error": text}
        return {"call_id": call_id, "status": "failure", "error": text}
    return {"call_id": call_id, "status": "cancelled"}


def handle_remote_request(payload, *, query_call_id: str = "", spawn=None, lookup=None) -> dict:
    op = request_op(payload, query_call_id)
    body = payload if isinstance(payload, dict) else {}
    call_id = str(body.get("call_id") or query_call_id or "").strip()
    if op == "cancel":
        if lookup is None:
            raise RemoteCallError(500, "lookup_unavailable", "function-call lookup is not available")
        return cancel_render(call_id, lookup(call_id).cancel)
    if op == "status":
        if lookup is None:
            raise RemoteCallError(500, "lookup_unavailable", "function-call lookup is not available")
        return poll_render(call_id, lookup(call_id).get)
    return submit_render(body, spawn)
