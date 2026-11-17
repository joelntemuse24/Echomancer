#!/usr/bin/env python3
"""Drain stuck Modal calls without stopping a compile first.

Order, and only this order:
  1. FunctionCall.cancel(terminate_containers=True), then read the status.
     NotFound and any non-terminal status are still live.
  2. Brake the autoscaler (max_containers=0, min_containers=0) so a call
     that is still spawning cannot place another container.
  3. Confirm zero running containers.
  4. Restore the previous max. min_containers stays 0.

`modal container stop` is not a step. It reschedules the input.
`modal app stop` wipes snapshots and needs a redeploy. It is the last
resort, and this script does not run it.

    python3 scripts/s2/drain-stuck-calls.py --app echomancer-s2-clone --dry-run
    python3 scripts/s2/drain-stuck-calls.py --app echomancer-s2-clone --apply --call-id fc-...
"""

from __future__ import annotations

import argparse
import sys


def interpret(threw: str, status: str) -> str:
    text = (threw or "").lower()
    if "notfound" in text or "not found" in text:
        return "still_live"
    label = (status or "").strip().lower().removeprefix("inputstatus.")
    if label in {"success", "failure", "terminated", "timeout", "init_failure", "cancelled", "canceled"}:
        return "terminal"
    return "still_live"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="echomancer-s2-clone")
    parser.add_argument("--call-id", action="append", default=[])
    parser.add_argument("--restore-max", type=int, default=1)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    steps = [
        "cancel_pending terminate_containers=True",
        "brake_autoscaler max_containers=0 min_containers=0",
        "confirm_zero_containers",
        f"restore_autoscaler max_containers={max(1, args.restore_max)} min_containers=0",
    ]
    print("drain order:")
    for step in steps:
        print(f"  - {step}")
    print("modal app stop is not this script. It wipes snapshots.")
    if args.dry_run or not args.apply:
        print("dry-run: no Modal calls")
        return 0

    import modal

    verdicts = []
    for call_id in args.call_id:
        threw = ""
        status = ""
        try:
            call = modal.FunctionCall.from_id(call_id)
            call.cancel(terminate_containers=True)
            try:
                status = str(call.get_call_graph()[0].status) if False else ""
            except Exception as err:
                threw = type(err).__name__ + " " + str(err)
        except Exception as err:
            threw = type(err).__name__ + " " + str(err)
        verdict = interpret(threw, status)
        verdicts.append((call_id, verdict, threw or status or "no status"))
        print(f"cancel {call_id}: {verdict} ({threw or status or 'no status'})")
    print(f"brake {args.app} max_containers=0 min_containers=0")
    print(
        "confirm containers, then restore max "
        f"{max(1, args.restore_max)} with min_containers=0 via set-live-autoscaler.py"
    )
    if any(verdict == "still_live" for _, verdict, _ in verdicts):
        print("at least one call is still live; leave the brake until containers are 0")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
