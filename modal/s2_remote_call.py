"""Submit, poll, and cancel one S2 render from a CPU function.

The GPU class only renders. This module decides what a control request
does and speaks ``modal.FunctionCall`` through callables the service
passes in. It does not import Modal. ``modal function calls`` does not
include the request body, so nothing here matches a tag or a job id.

``OutputExpiredError`` in Modal client 1.6.4 subclasses ``TimeoutError``.
It is matched by class name before any timeout, so an expired call is a
terminal miss rather than a poll that never ends.
"""

from __future__ import annotations

import json
import time

CONTROL_PROTOCOL = "s2-submit-poll"
CONTROL_PROTOCOL_VERSION = 1
POLL_GET_TIMEOUT_S = 1.0
# A lost submit retries with the same key. The row only has to outlive
# one book page and a worker restart, not the life of the account.
IDEMPOTENCY_TTL_S = 6 * 60 * 60

TERMINAL_STATUSES = frozenset(
    {
        "success",
        "failure",
        "cancelled",
        "canceled",
        "expired",
        "terminated",
        "timeout",
        "init_failure",
        "init failure",
    }
)


class RemoteCallError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        super().__init__(message)


def is_terminal_status(status: str) -> bool:
    return str(status or "").strip().lower() in TERMINAL_STATUSES


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


_FLEET_ACTIONS = ("read", "brake", "restore", "count")


def request_op(payload, query: str = "") -> str:
    """``probe`` names the protocol. ``lookup`` reads the Dict. ``submit`` renders.

    ``autoscaler`` is read, brake, restore, or count. A body that still carries
    the book is a submit, so those actions cannot spawn by being attached to
    ``items``.
    """
    body = payload if isinstance(payload, dict) else {}
    if body.get("probe") is True:
        return "probe"
    # A book body is never a lookup: items would spawn. Lookup is the key only.
    if body.get("lookup") is True and not body.get("items") and not body.get("text"):
        return "lookup"
    action = str(body.get("autoscaler") or "").strip().lower()
    if action in _FLEET_ACTIONS and not body.get("items") and not body.get("text"):
        return "autoscaler"
    call_id = str(body.get("call_id") or query or "").strip()
    if body.get("cancel") is True and call_id:
        return "cancel"
    # A body that still carries the book is a submit, even if an id is echoed.
    if call_id and not body.get("items") and not body.get("text"):
        return "status"
    return "submit"


def protocol_body() -> dict:
    return {
        "protocol": CONTROL_PROTOCOL,
        "protocol_version": CONTROL_PROTOCOL_VERSION,
        "status": "ok",
        "terminal": False,
    }


def _status(call_id: str, status: str, **extra) -> dict:
    body = {
        "call_id": call_id,
        "status": status,
        "protocol": CONTROL_PROTOCOL,
        "protocol_version": CONTROL_PROTOCOL_VERSION,
        "terminal": is_terminal_status(status),
    }
    if status in {"expired", "not_found"}:
        body["miss"] = True
    body.update(extra)
    return body


def _class_names(err: BaseException) -> set[str]:
    return {cls.__name__ for cls in type(err).__mro__}


def _is_output_expired(err: BaseException) -> bool:
    return "OutputExpiredError" in _class_names(err)


def _is_not_found(err: BaseException) -> bool:
    names = " ".join(_class_names(err)).lower()
    text = f"{type(err).__name__}: {err}".lower()
    return "notfound" in names or "not found" in text or "notfound" in text


def _is_plain_timeout(err: BaseException) -> bool:
    if _is_output_expired(err):
        return False
    names = _class_names(err)
    return "TimeoutError" in names or "FunctionTimeoutError" in names


def _stored_call(store, key: str, now: float) -> str:
    try:
        row = store.get(key)
    except Exception:
        return ""
    if not isinstance(row, dict):
        return ""
    try:
        at = float(row.get("at") or 0)
    except (TypeError, ValueError):
        at = 0.0
    if at <= 0 or now - at > IDEMPOTENCY_TTL_S:
        return ""
    return str(row.get("call_id") or "").strip()


def lookup_stored_call(key: str, store, now: float) -> dict:
    """The Dict row for this key. This does not spawn."""
    found = _stored_call(store, key, now) if key and store is not None else ""
    if not found:
        return {
            "status": "absent",
            "protocol": CONTROL_PROTOCOL,
            "protocol_version": CONTROL_PROTOCOL_VERSION,
            "terminal": False,
        }
    return _status(found, "pending", idempotent=True)


def submit_render(payload, spawn, *, store=None, now=None) -> dict:
    """Spawn once per idempotency key. A repeat returns the stored id."""
    if not callable(spawn):
        raise RemoteCallError(500, "spawn_unavailable", "GPU spawn is not available")
    body = payload if isinstance(payload, dict) else {}
    moment = time.time() if now is None else float(now)
    key = str(body.get("idempotency_key") or "").strip()
    if key and store is not None:
        existing = _stored_call(store, key, moment)
        if existing:
            return _status(existing, "pending", idempotent=True)
    spawned = spawn(body)
    call_id = call_id_of(spawned)
    if key and store is not None:
        try:
            store.put(key, {"call_id": call_id, "at": moment})
        except Exception as err:
            # The id exists. Losing the row only means a later retry can spawn
            # again; hiding the id would make this request uncancelable.
            return _status(call_id, "pending", idempotency_error=f"{type(err).__name__}: {err}")
    return _status(call_id, "pending")


def _result_dict(result):
    """The poll body has to be JSON. Bytes are not a result."""
    if isinstance(result, dict):
        return result
    content = getattr(result, "content", None)
    if isinstance(content, dict):
        return content
    raw = None
    if isinstance(result, (bytes, bytearray)):
        raw = bytes(result)
    else:
        body = getattr(result, "body", None)
        if isinstance(body, (bytes, bytearray)):
            raw = bytes(body)
    if raw is None:
        return None
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def poll_render(call_id: str, get, *, timeout_s: float = POLL_GET_TIMEOUT_S) -> dict:
    try:
        result = get(timeout=timeout_s)
    except Exception as err:
        if _is_output_expired(err):
            return _status(call_id, "expired")
        if _is_not_found(err):
            # get() can raise NotFound while the input is still PENDING.
            return _status(call_id, "unknown", error="not_published")
        if _is_plain_timeout(err):
            return _status(call_id, "pending")
        return _status(call_id, "failure", error=f"{type(err).__name__}: {err}")
    parsed = _result_dict(result)
    if parsed is None:
        # A transport-shaped body. The worker keeps polling this id.
        return _status(call_id, "unknown", error="result_not_json")
    if parsed.get("error") and not parsed.get("items"):
        return _status(call_id, "failure", error=parsed.get("error"), result=parsed)
    return _status(call_id, "success", result=parsed)


def cancel_render(call_id: str, cancel, read_status=None) -> dict:
    """Cancel, then read the call. A silent return is not terminal."""
    try:
        cancel(terminate_containers=True)
    except Exception as err:
        if not _is_not_found(err):
            return _status(call_id, "failure", error=f"{type(err).__name__}: {err}")
        if read_status is None:
            # NotFound on its own is not proof the input is gone.
            return _status(call_id, "pending", error=f"{type(err).__name__}: {err}")
    if read_status is None:
        return _status(call_id, "pending")
    try:
        observed = read_status()
    except Exception as err:
        if _is_output_expired(err):
            return _status(call_id, "expired")
        if _is_not_found(err):
            # get() can raise NotFound while the input is still PENDING.
            return _status(call_id, "unknown", error="not_published")
        if _is_plain_timeout(err):
            return _status(call_id, "pending")
        return _status(call_id, "failure", error=f"{type(err).__name__}: {err}")
    if not isinstance(observed, dict):
        return _status(call_id, "pending")
    return observed


def handle_remote_request(
    payload,
    *,
    query_call_id: str = "",
    spawn=None,
    lookup=None,
    store=None,
    now=None,
    fleet=None,
) -> dict:
    op = request_op(payload, query_call_id)
    if op == "probe":
        return protocol_body()
    body = payload if isinstance(payload, dict) else {}
    if op == "autoscaler":
        if not callable(fleet):
            raise RemoteCallError(
                500, "autoscaler_unavailable", "autoscaler control is not available"
            )
        result = fleet(body)
        if not isinstance(result, dict):
            raise RemoteCallError(
                500, "autoscaler_unavailable", "autoscaler control returned nothing"
            )
        return result
    if op == "lookup":
        key = str(body.get("idempotency_key") or "").strip()
        moment = time.time() if now is None else float(now)
        return lookup_stored_call(key, store, moment)
    call_id = str(body.get("call_id") or query_call_id or "").strip()
    if op == "cancel":
        if lookup is None:
            raise RemoteCallError(500, "lookup_unavailable", "function-call lookup is not available")
        call = lookup(call_id)
        return cancel_render(
            call_id,
            call.cancel,
            read_status=lambda: poll_render(call_id, call.get),
        )
    if op == "status":
        if lookup is None:
            raise RemoteCallError(500, "lookup_unavailable", "function-call lookup is not available")
        return poll_render(call_id, lookup(call_id).get)
    return submit_render(body, spawn, store=store, now=now)
