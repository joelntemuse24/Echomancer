#!/usr/bin/env python3
"""Cancel abandoned *unstarted* S2 FunctionCalls after a first-light abort.

Only PENDING inputs with no started_at are cancelled, and never with
terminate_containers=True. A call that has already entered or compiled is left
alone so snapshot publish is not interrupted.

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
    list_function_calls,
)


def cancel_call(function_call_id: str, *, dry_run: bool) -> None:
    if dry_run:
        print(f"dry-run: would cancel {function_call_id} (terminate_containers=False)")
        return
    # Imported lazily so offline tests can import this file's helpers without
    # a Modal client.
    from modal.functions import FunctionCall

    FunctionCall.from_id(function_call_id).cancel(terminate_containers=False)
    print(f"cancelled unstarted pending input {function_call_id}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app",
        default=os.environ.get("S2C_APP_NAME")
        or os.environ.get("MODAL_S2_APP_NAME")
        or "echomancer-s2-clone",
    )
    parser.add_argument("--cls", default="S2CloneWorker")
    parser.add_argument("--job-id", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--tail", type=int, default=200)
    args = parser.parse_args(argv)

    rows = list_function_calls(args.app, args.cls, tail=args.tail)
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
