#!/usr/bin/env python3
"""Drain one book's stuck Modal calls.

Order, and only this order:
  1. FunctionCall.cancel(terminate_containers=True) for that book's stored
     call ids, then read the status. NotFound and any non-terminal status
     stay still_live.
  2. Brake the shared autoscaler only when a cancel is still non-terminal
     AND no other book has a live call. max_containers=0, min_containers=0.
  3. Wait until running containers are gone.
  4. Restore the max that was read before the brake. Never guess 1.
     min_containers stays 0.

`modal container stop` is not a step. It reschedules the input.
`modal app stop` wipes snapshots and needs a redeploy. This script does
not run it.

    python3 scripts/s2/drain-stuck-calls.py --dry-run --restore-max 20
    python3 scripts/s2/drain-stuck-calls.py --apply --call-id fc-... --restore-max 20
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def interpret(threw: str, status: str) -> str:
    text = (threw or "").lower()
    if "notfound" in text or "not found" in text:
        return "still_live"
    label = (status or "").strip().lower().removeprefix("inputstatus.")
    if label in {
        "success",
        "failure",
        "terminated",
        "timeout",
        "init_failure",
        "cancelled",
        "canceled",
        "1",
        "2",
        "3",
        "4",
        "5",
    }:
        return "terminal"
    return "still_live"


def should_brake(verdicts: list[str], other_live_books: int) -> bool:
    """Brake the shared app only when this book is the one still spawning."""
    return any(verdict == "still_live" for verdict in verdicts) and other_live_books == 0


def planned_restore_max(saved: int | None) -> int:
    """The cap to put back. Refuses to invent 1."""
    if saved is None or saved < 1:
        raise SystemExit(
            "refusing to guess max_containers=1; pass the max read before the brake"
        )
    return saved


def read_call_status(call) -> tuple[str, str]:
    """Return (threw, status). A missing graph is not a terminal call."""
    try:
        graph = call.get_call_graph()
    except Exception as err:
        return f"{type(err).__name__} {err}", ""
    if not graph:
        return "", ""
    node = graph[0]
    status = getattr(node, "status", "") or ""
    return "", str(status)


def running_containers(app_name: str) -> int:
    """How many containers this app still has. Raises if the count cannot be read."""
    import modal

    listing = getattr(modal, "Container", None)
    list_fn = getattr(listing, "list", None) if listing is not None else None
    if not callable(list_fn):
        raise RuntimeError(f"cannot list containers for {app_name}")
    app = modal.App.lookup(app_name, create_if_missing=False)
    app_id = getattr(app, "app_id", None)
    rows = list(list_fn(app_id=app_id)) if app_id else list(list_fn())
    return len(rows)


def wait_until_idle(app_name: str, timeout_s: float = 120, interval_s: float = 5) -> int:
    deadline = time.time() + timeout_s
    last = running_containers(app_name)
    while last > 0 and time.time() < deadline:
        time.sleep(interval_s)
        last = running_containers(app_name)
    return last


def apply_autoscaler(app: str, cls: str, max_containers: int, profile: str | None) -> int:
    script = ROOT / "scripts" / "s2" / "set-live-autoscaler.py"
    cmd = [
        sys.executable,
        str(script),
        "--app",
        app,
        "--cls",
        cls,
        "--max-containers",
        str(max_containers),
        "--scaledown-window",
        "15",
    ]
    if max_containers == 0:
        cmd = [
            sys.executable,
            str(script),
            "--app",
            app,
            "--cls",
            cls,
            "--brake",
            "--scaledown-window",
            "15",
        ]
    if profile:
        cmd.extend(["--profile", profile])
    import subprocess

    completed = subprocess.run(cmd, check=False)
    return completed.returncode


def list_calls_json(app: str, cls: str) -> int:
    sys.path.insert(0, str(ROOT / "modal"))
    from s2_input_queue import list_function_calls

    rows = list_function_calls(app, cls)
    payload = []
    for row in rows:
        call_id = row.get("function_call_id") or row.get("id") or ""
        if not call_id:
            continue
        payload.append(
            {
                "callId": str(call_id),
                "jobId": str(row.get("job_id") or ""),
                "status": row.get("status"),
            }
        )
    print(json.dumps(payload))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="echomancer-s2-clone")
    parser.add_argument("--cls", default="S2CloneWorker")
    parser.add_argument("--call-id", action="append", default=[])
    parser.add_argument("--job-id", default="")
    parser.add_argument("--restore-max", type=int, default=None)
    parser.add_argument("--other-live-books", type=int, default=0)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--list-json", action="store_true")
    parser.add_argument("--profile", default=os.environ.get("MODAL_PROFILE"))
    args = parser.parse_args(argv)

    if args.list_json:
        return list_calls_json(args.app, args.cls)

    restore_label = (
        str(planned_restore_max(args.restore_max))
        if args.restore_max is not None and args.restore_max >= 1
        else "UNSET (will not guess 1)"
    )
    brake = should_brake(["still_live"] if args.call_id else [], args.other_live_books)
    print("drain order:")
    print("  - cancel_pending terminate_containers=True")
    if brake or not args.call_id:
        print("  - brake_autoscaler max_containers=0 min_containers=0 (only if still_live and no other live book)")
        print("  - confirm_zero_containers")
        print(f"  - restore_autoscaler max_containers={restore_label} min_containers=0")
    else:
        print("  - no brake: another book still has a live call")
    print("modal app stop is not this script. It wipes snapshots.")
    if args.dry_run or not args.apply:
        print("dry-run: no Modal calls")
        return 0

    if args.profile:
        os.environ["MODAL_PROFILE"] = args.profile
        os.environ.pop("MODAL_TOKEN_ID", None)
        os.environ.pop("MODAL_TOKEN_SECRET", None)

    import modal

    verdicts: list[tuple[str, str]] = []
    for call_id in args.call_id:
        threw = ""
        status = ""
        try:
            call = modal.FunctionCall.from_id(call_id)
            call.cancel(terminate_containers=True)
            threw, status = read_call_status(call)
            if interpret(threw, status) != "terminal":
                time.sleep(1)
                threw, status = read_call_status(call)
        except Exception as err:
            threw = f"{type(err).__name__} {err}"
        verdict = interpret(threw, status)
        verdicts.append((call_id, verdict))
        print(f"cancel {call_id}: {verdict} ({threw or status or 'no status'})")

    labels = [verdict for _, verdict in verdicts]
    if not should_brake(labels, args.other_live_books):
        if any(verdict == "still_live" for verdict in labels):
            print("still_live, but another book is live; autoscaler left unchanged")
            return 2
        return 0

    saved = planned_restore_max(args.restore_max)
    brake_code = apply_autoscaler(args.app, args.cls, 0, args.profile)
    if brake_code != 0:
        print("brake failed", file=sys.stderr)
        return brake_code
    remaining = wait_until_idle(args.app)
    print(f"containers after brake: {remaining}")
    if remaining != 0:
        print("containers still running; autoscaler stays braked", file=sys.stderr)
        return 2
    restore_code = apply_autoscaler(args.app, args.cls, saved, args.profile)
    if restore_code != 0:
        print("restore failed", file=sys.stderr)
        return restore_code
    print(f"restored max_containers={saved} min_containers=0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
