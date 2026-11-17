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

On production `echomancer-s2-clone` that max is at most 1 unless
`S2_ALLOW_PROD_CAP_ABOVE_1=1`. A higher `--restore-max` is refused
before any brake, using the same clamp as `--clamp-restore`. Braking
first and then failing the restore would leave the live cap at 0.

`modal container stop` is not a step. It reschedules the input.
`modal app stop` wipes snapshots and needs a redeploy. This script does
not run it.

    python3 scripts/s2/drain-stuck-calls.py --dry-run --restore-max 1
    python3 scripts/s2/drain-stuck-calls.py --apply --call-id fc-... --restore-max 1
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


def identity_from_row(row: dict) -> tuple[str, str]:
    """job id and client tag, including when they are buried in the input JSON."""
    import re

    blobs: list[str] = []

    def walk(value: object) -> None:
        if isinstance(value, str):
            blobs.append(value)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(row)
    text = "\n".join(blobs)
    job = str(row.get("job_id") or "")
    tag = str(row.get("echo_call_tag") or row.get("tag") or "")
    if not job:
        found = re.search(r'"job_id"\s*:\s*"([^"]+)"', text)
        if found:
            job = found.group(1)
    if not tag:
        found = re.search(r"echo:[A-Za-z0-9_.:|-]+", text)
        if found:
            tag = found.group(0)
    return job, tag


def _autoscaler_rules():
    """The live-autoscaler script. It does not import Modal at import time."""
    import importlib.util

    path = ROOT / "scripts" / "s2" / "set-live-autoscaler.py"
    spec = importlib.util.spec_from_file_location("set_live_autoscaler", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require_restorable_max(app: str, saved: int | None) -> int:
    """The cap a later restore is allowed to write. Raises before any brake.

    Production uses ``clamp_production_restore``: at most 1 unless
    ``S2_ALLOW_PROD_CAP_ABOVE_1=1``. A requested value the apply path would
    refuse is an error here, not a brake followed by a failed restore.
    A missing value is not turned into 1.
    """
    if not isinstance(saved, int) or saved < 1:
        raise SystemExit(
            "refusing to guess max_containers=1; pass the max read before the brake"
        )
    rules = _autoscaler_rules()
    clamped = rules.clamp_production_restore(app, saved)
    if clamped != saved or rules.production_apply_refusal(app, saved):
        raise SystemExit(
            f"refusing --restore-max {saved} on {app} before any brake. "
            "Restoring it would be refused and the autoscaler would stay at "
            "max_containers=0. "
            f"Pass --restore-max {clamped}. "
            "Set S2_ALLOW_PROD_CAP_ABOVE_1=1 only with explicit owner approval."
        )
    return clamped


def restore_command(app: str, saved: int) -> str:
    """The command that puts a legal cap back. Production is 1."""
    rules = _autoscaler_rules()
    allowed = rules.clamp_production_restore(app, saved)
    if allowed < 1:
        allowed = 1
    return (
        "python3 scripts/s2/set-live-autoscaler.py "
        f"--app {app} --max-containers {allowed} --scaledown-window 15"
    )


def run_drain(
    *,
    call_ids: list[str],
    other_live_books: int,
    restore_max: int | None,
    cancel,
    brake,
    wait_idle,
    restore,
    recheck_other=None,
    app: str = "echomancer-s2-clone",
) -> int:
    """Cancel, maybe brake, then always restore a max that was actually read.

    A wait that does not reach zero, and an exception after the brake, both
    put that max back. The call stays still_live when it is not terminal.
    `recheck_other` runs immediately before the brake. A restore max the
    apply path would refuse is rejected before the brake.
    """
    saved: int | None
    if restore_max is None:
        saved = None
    else:
        saved = require_restorable_max(app, restore_max)
    braked = False
    code = 0
    try:
        verdicts = [cancel(call_id) for call_id in call_ids]
        others = int(recheck_other()) if recheck_other is not None else int(other_live_books)
        live = any(verdict == "still_live" for verdict in verdicts)
        if not live or others != 0 or saved is None:
            if live and others != 0:
                print("still_live, but another book is live; autoscaler left unchanged")
                code = 2
            elif live and saved is None:
                print(
                    "still_live; refusing to brake without the max read before it",
                    file=sys.stderr,
                )
                code = 2
            return code
        braked = True
        brake()
        remaining = int(wait_idle())
        print(f"containers after brake: {remaining}")
        if remaining != 0:
            print(
                "containers still running; restoring the saved max and leaving the call still_live",
                file=sys.stderr,
            )
            code = 2
        return code
    finally:
        if braked and saved is not None:
            try:
                restore(saved)
            except Exception as err:
                command = restore_command(app, saved)
                print(
                    f"restore failed: {err}\n"
                    "The autoscaler is still braked at max_containers=0.\n"
                    f"Restore it with:\n  {command}",
                    file=sys.stderr,
                )
                raise SystemExit(2) from err
            print(f"restored max_containers={saved} min_containers=0")


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
        job_id, tag = identity_from_row(row)
        payload.append(
            {
                "callId": str(call_id),
                "jobId": job_id,
                "tag": tag,
                "status": row.get("status"),
                "raw": json.dumps(row, default=str),
            }
        )
    print(json.dumps(payload))
    return 0


def apply_worker_credentials(profile: str | None) -> None:
    """A profile replaces the worker token. No profile leaves the token in place.

    The worker authenticates with MODAL_TOKEN_ID / MODAL_TOKEN_SECRET. Only an
    explicit ``--profile`` (the operator scripts) may drop those variables.
    ``MODAL_PROFILE`` in the environment is not that request.
    """
    if not profile:
        return
    os.environ["MODAL_PROFILE"] = profile
    os.environ.pop("MODAL_TOKEN_ID", None)
    os.environ.pop("MODAL_TOKEN_SECRET", None)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--app", default="echomancer-s2-clone")
    parser.add_argument("--cls", default="S2CloneWorker")
    parser.add_argument("--call-id", action="append", default=[])
    parser.add_argument("--job-id", default="")
    parser.add_argument("--restore-max", type=int, default=None)
    parser.add_argument("--other-live-books", type=int, default=0)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--list-json", action="store_true")
    parser.add_argument("--cancel-only", action="store_true")
    parser.add_argument("--running-count", action="store_true")
    parser.add_argument("--profile", default=None)
    args = parser.parse_args(argv)

    if args.list_json:
        return list_calls_json(args.app, args.cls)

    checked_restore: int | None = None
    if args.restore_max is not None:
        try:
            checked_restore = require_restorable_max(args.app, args.restore_max)
        except SystemExit as err:
            message = err.code if isinstance(err.code, str) else str(err)
            print(message, file=sys.stderr)
            return 2

    restore_label = (
        str(checked_restore)
        if checked_restore is not None
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
    side = args.running_count or args.cancel_only
    if (args.dry_run or not args.apply) and not side:
        print("dry-run: no Modal calls")
        return 0

    apply_worker_credentials(args.profile)

    if args.running_count:
        print(running_containers(args.app))
        return 0

    def cancel_one(call_id: str) -> str:
        import modal

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
        print(f"cancel {call_id}: {verdict} ({threw or status or 'no status'})")
        return verdict

    if args.cancel_only:
        for call_id in args.call_id:
            cancel_one(call_id)
        return 0

    def do_brake() -> None:
        brake_code = apply_autoscaler(args.app, args.cls, 0, args.profile)
        if brake_code != 0:
            raise RuntimeError(f"brake failed {brake_code}")

    def do_restore(saved: int) -> None:
        restore_code = apply_autoscaler(args.app, args.cls, saved, args.profile)
        if restore_code != 0:
            raise RuntimeError(f"restore failed {restore_code}")

    try:
        return run_drain(
            call_ids=list(args.call_id),
            other_live_books=args.other_live_books,
            restore_max=checked_restore,
            cancel=cancel_one,
            brake=do_brake,
            wait_idle=lambda: wait_until_idle(args.app),
            restore=do_restore,
            recheck_other=lambda: args.other_live_books,
            app=args.app,
        )
    except SystemExit as err:
        if isinstance(err.code, str):
            print(err.code, file=sys.stderr)
            return 2
        if isinstance(err.code, int):
            return err.code
        raise


if __name__ == "__main__":
    sys.exit(main())
