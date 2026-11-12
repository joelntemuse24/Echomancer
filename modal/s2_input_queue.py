"""Inspect S2 FunctionCall inputs and refuse to start on a stale queue.

`FunctionCall.cancel()` does not reliably clear the queue: `get()` may raise
NotFound while `modal function calls` still shows PENDING, and that leftover
input is served after the next `@modal.enter`, which interrupts snapshot
publish. `modal container stop` reschedules the still-pending input onto a new
container and can start another compile loop.

Warm and probe scripts must refuse to start while any input is PENDING or
otherwise unfinished. To stop new placements without killing an in-flight
enter or compile, apply the autoscaler brake (`max_containers=0`). To drain
leftovers, let an already-ready container serve them to a terminal state.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from typing import Any

TERMINAL_STATUSES = frozenset(
    {
        "success",
        "failure",
        "terminated",
        "timeout",
        "init_failure",
        "1",
        "2",
        "3",
        "4",
        "5",
    }
)
# Modal's InputStatus.PENDING is 0. "running" is also unfinished.
UNSTARTED_PENDING_STATUSES = frozenset({"pending", "0", ""})

DEFAULT_TAIL = 200
DEFAULT_FUNCTION = "S2CloneWorker.*"


def normalize_status(row: dict[str, Any]) -> str:
    raw = row.get("status") or row.get("input_status") or row.get("state") or ""
    text = str(raw).strip().lower()
    if text.startswith("inputstatus."):
        text = text.split(".", 1)[1]
    return text


def is_terminal(row: dict[str, Any]) -> bool:
    return normalize_status(row) in TERMINAL_STATUSES


def is_unfinished(row: dict[str, Any]) -> bool:
    """True for PENDING, running, or any non-terminal FunctionCall."""
    return not is_terminal(row)


def has_started(row: dict[str, Any]) -> bool:
    started = row.get("started_at")
    if started in (None, "", 0, "null"):
        return False
    if row.get("container_id") in (None, "", 0):
        # A started_at with no container is still treated as started if set.
        return True
    return True


def may_cancel_abandoned_call(row: dict[str, Any]) -> bool:
    """Cancel only unstarted PENDING leftovers, never a live enter/compile.

    A first-light HTTP abort should not pile up abandoned inputs. Cancelling a
    call that has already started on a container can interrupt snapshot
    publish — the same failure as leftover PENDING inputs being served after
    enter.
    """
    if not is_unfinished(row):
        return False
    if has_started(row):
        return False
    return normalize_status(row) in UNSTARTED_PENDING_STATUSES or not has_started(row)


def unfinished_inputs(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if is_unfinished(row)]


def cancel_candidates(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if may_cancel_abandoned_call(row)]


def function_spec(app: str, cls: str = "S2CloneWorker") -> str:
    name = cls if "." in cls else f"{cls}.*"
    return f"{app}/{name}"


def default_list_command(app: str, cls: str = "S2CloneWorker", tail: int = DEFAULT_TAIL) -> list[str]:
    modal = os.environ.get("MODAL_BIN", "modal")
    return [
        modal,
        "function",
        "calls",
        function_spec(app, cls),
        "--all-variants",
        "--tail",
        str(tail),
        "--json",
        "--show-function-call-id",
        "--no-color",
    ]


def parse_calls_json(raw: str) -> list[dict[str, Any]]:
    text = (raw or "").strip()
    if not text:
        return []
    data = json.loads(text)
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        for key in ("inputs", "calls", "items"):
            value = data.get(key)
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
        return [data]
    raise ValueError("function-call listing was not a JSON object or array")


def list_function_calls(
    app: str,
    cls: str = "S2CloneWorker",
    *,
    tail: int = DEFAULT_TAIL,
    runner: Callable[[list[str]], str] | None = None,
) -> list[dict[str, Any]]:
    command = default_list_command(app, cls, tail)
    if runner is not None:
        raw = runner(command)
    else:
        raw = subprocess.check_output(command, text=True, stderr=subprocess.STDOUT)
    return parse_calls_json(raw)


def format_unfinished(rows: Sequence[dict[str, Any]]) -> str:
    lines = []
    for row in rows:
        lines.append(
            "  {id} status={status} started_at={started} method={method}".format(
                id=row.get("function_call_id") or row.get("input_id") or "?",
                status=normalize_status(row) or "unknown",
                started=row.get("started_at") or "null",
                method=row.get("service_method_name") or row.get("function_name") or "?",
            )
        )
    return "\n".join(lines)


def refuse_if_unfinished(rows: Sequence[dict[str, Any]], *, source: str = "input queue") -> None:
    leftover = unfinished_inputs(rows)
    if not leftover:
        return
    n = len(leftover)
    raise SystemExit(
        f"refusing to start: {n} unfinished FunctionCall(s) on the {source}.\n"
        "Warm and probe scripts must not run on a stale PENDING queue.\n"
        "Do not FunctionCall.cancel() or `modal container stop` during enter or "
        "compile — that leaves leftovers that are served after the next enter "
        "and can interrupt snapshot publish, or reschedules the input onto a "
        "new compile. Drain leftovers by letting an already-ready container "
        "serve each one to a terminal state (success, failure, or terminated). "
        "To stop new placements only, apply the autoscaler brake "
        "(`python3 scripts/s2/set-live-autoscaler.py --brake`), then restore "
        "0/1/45 after the compile finishes.\n"
        f"{format_unfinished(leftover)}"
    )


def assert_no_unfinished_inputs(
    app: str,
    cls: str = "S2CloneWorker",
    *,
    runner: Callable[[list[str]], str] | None = None,
    tail: int = DEFAULT_TAIL,
) -> list[dict[str, Any]]:
    rows = list_function_calls(app, cls, tail=tail, runner=runner)
    refuse_if_unfinished(rows, source=function_spec(app, cls))
    return rows


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    app = os.environ.get("S2C_APP_NAME") or os.environ.get("MODAL_S2_APP_NAME") or "echomancer-s2-clone"
    cls = "S2CloneWorker"
    tail = DEFAULT_TAIL
    i = 0
    while i < len(args):
        if args[i] == "--app" and i + 1 < len(args):
            app = args[i + 1]
            i += 2
            continue
        if args[i] == "--cls" and i + 1 < len(args):
            cls = args[i + 1]
            i += 2
            continue
        if args[i] == "--tail" and i + 1 < len(args):
            tail = int(args[i + 1])
            i += 2
            continue
        if args[i] in {"-h", "--help"}:
            print(
                "Usage: python3 scripts/s2/check-input-queue.py [--app NAME] [--cls CLS] [--tail N]\n"
                "Exit 0 if the S2 input queue has no PENDING or unfinished FunctionCalls."
            )
            return 0
        print(f"unknown argument: {args[i]}", file=sys.stderr)
        return 2
    try:
        rows = assert_no_unfinished_inputs(app, cls, tail=tail)
    except SystemExit as err:
        print(err, file=sys.stderr)
        return 2
    print(f"ok: {function_spec(app, cls)} has 0 unfinished inputs (checked {len(rows)} recent calls)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
