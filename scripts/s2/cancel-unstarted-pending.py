#!/usr/bin/env python3
"""Cancel abandoned S2 FunctionCalls after a first-light abort.

cancel(terminate_containers=True) is step 1 of the drain. NotFound, or any
status that is not terminal, means the call is still live. Do not follow
this with `modal container stop`. Run scripts/s2/drain-stuck-calls.py so
the autoscaler is braked (max_containers=0, min_containers stays 0).

    python3 scripts/s2/cancel-unstarted-pending.py
    python3 scripts/s2/cancel-unstarted-pending.py --dry-run

This is not a drain for leftovers that cancel() failed to clear, and it is not
a substitute for the autoscaler brake during an in-flight compile.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "modal"))

from s2_input_queue import (  # noqa: E402
    cancel_candidates,
    function_spec,
    has_started,
    is_unfinished,
    list_function_calls,
)


def probe_placement(rows: list[dict]) -> str:
    """started if a container has the call, pending if it can still be cancelled, else gone."""
    unfinished = [row for row in rows if is_unfinished(row)]
    if any(has_started(row) for row in unfinished):
        return "started"
    if cancel_candidates(rows):
        return "pending"
    if not unfinished:
        return "gone"
    return "unknown"


def cancel_call(function_call_id: str, *, dry_run: bool) -> None:
    if dry_run:
        print(f"dry-run: would cancel {function_call_id} (terminate_containers=True)")
        print("verdict: still_live until a terminal status is read")
        return
    # Imported lazily so offline tests can import this file's helpers without
    # a Modal client.
    from modal.functions import FunctionCall

    try:
        FunctionCall.from_id(function_call_id).cancel(terminate_containers=True)
    except Exception as err:
        name = type(err).__name__
        print(f"cancel {function_call_id}: still_live ({name})")
        print("NotFound is not proof the call is gone. Brake with drain-stuck-calls.py.")
        return
    print(f"cancel {function_call_id}: requested (terminate_containers=True)")
    print("verdict: still_live until a terminal status is read. Then drain-stuck-calls.py.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    # Deliberately **not** `s2_contract.resolve_app_name`. That resolver sends an
    # unnamed target to staging, which is right for a deploy (it must not evict
    # production's snapshots) but wrong here: this tool cancels a PENDING input,
    # and an operator running it bare means the live app. Cancelling on the wrong
    # app would leave the real stale input in place *and* touch a pool nobody
    # asked about. `--app` still overrides for a staging drain.
    parser.add_argument(
        "--app",
        default=os.environ.get("S2C_APP_NAME")
        or os.environ.get("MODAL_S2_APP_NAME")
        or "echomancer-s2-clone",
    )
    parser.add_argument("--cls", default="S2CloneWorker")
    parser.add_argument("--job-id", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--probe",
        action="store_true",
        help="Print started, pending, gone, or unknown. Do not cancel.",
    )
    parser.add_argument("--tail", type=int, default=200)
    args = parser.parse_args(argv)

    rows = list_function_calls(args.app, args.cls, tail=args.tail)
    if args.probe:
        print(probe_placement(rows))
        return 0
    chosen = cancel_candidates(rows)
    if args.job_id:
        # job_id is not always a column in `function calls`; keep only rows
        # whose JSON mentions it when the operator passed one.
        needle = args.job_id
        chosen = [
            row
            for row in chosen
            if needle in (row.get("job_id") or "") or needle in str(row)
        ]
    if not chosen:
        print(f"ok: no unstarted pending inputs to cancel on {function_spec(args.app, args.cls)}")
        return 0
    for row in chosen:
        fc_id = row.get("function_call_id")
        if not fc_id:
            print(f"skip row with no function_call_id: {row!r}", file=sys.stderr)
            continue
        try:
            cancel_call(str(fc_id), dry_run=args.dry_run)
        except Exception as err:
            print(f"cancel failed for {fc_id}: {type(err).__name__}: {err}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
