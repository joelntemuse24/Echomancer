"""Set the live S2 autoscaler. Does not deploy and does not rebuild snapshots.

The decorator baked into the image is not what production uses after step 8c.
`modal deploy` wipes GPU memory snapshots and resets this override, so run
this again after any deploy. Do not run it from CI.

Restart the take-home worker first. The worker's default warm hold is 10s,
which has to stay under this window. Lowering the window while the worker
still plans a longer hold sends a wide batch at a container that is already
gone. 15s releases an idle H100 promptly. It does not cancel an in-flight
enter or compile: scaledown only applies once the container has no input.

    python3 scripts/s2/set-live-autoscaler.py --max-containers 20 --scaledown-window 15

`--max-containers` is the worker's MODAL_S2_MAX_GPUS. min_containers stays 0.

`--max-containers 0` (or `--brake`) is a temporary brake: it stops new
placements without cancelling an in-flight enter or compile. It does not
drain PENDING inputs. After the compile publishes, restore production with
`--max-containers 1 --scaledown-window 15`. Never `FunctionCall.cancel()` or
`modal container stop` mid-enter to "save money"; that reschedules leftovers
and can interrupt snapshot publish.
"""

from __future__ import annotations

import argparse
import sys
from typing import NamedTuple


class AutoscalerArgs(NamedTuple):
    app: str
    cls: str
    max_containers: int
    scaledown_window: int
    brake: bool


def validate_autoscaler_values(
    max_containers: int, scaledown_window: int
) -> str | None:
    """Return an error message, or None if the values are allowed.

    `max_containers=0` is the compile brake. 1..64 is a live cap.
    """
    if max_containers < 0 or max_containers > 64:
        return "max-containers must be 0 (brake) or 1..64"
    if scaledown_window < 15 or scaledown_window > 60:
        return (
            "scaledown-window must be 15..60 seconds "
            "(the worker warm hold is 10s, five seconds under 15)"
        )
    return None


def parse_args(argv: list[str] | None = None) -> AutoscalerArgs:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="echomancer-s2-clone")
    parser.add_argument("--cls", default="S2CloneWorker")
    parser.add_argument(
        "--max-containers",
        type=int,
        default=None,
        help="Live cap (1..64), or 0 for a temporary brake that stops new placements.",
    )
    parser.add_argument(
        "--brake",
        action="store_true",
        help="Set max_containers=0 to stop new placements without cancelling a compile.",
    )
    parser.add_argument("--scaledown-window", type=int, default=15)
    ns = parser.parse_args(argv)
    if ns.brake:
        if ns.max_containers not in (None, 0):
            raise SystemExit("--brake cannot be combined with a non-zero --max-containers")
        ns.max_containers = 0
    if ns.max_containers is None:
        raise SystemExit("the following arguments are required: --max-containers (or pass --brake)")
    error = validate_autoscaler_values(ns.max_containers, ns.scaledown_window)
    if error:
        raise SystemExit(error)
    return AutoscalerArgs(
        app=ns.app,
        cls=ns.cls,
        max_containers=ns.max_containers,
        scaledown_window=ns.scaledown_window,
        brake=bool(ns.brake or ns.max_containers == 0),
    )


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
    except SystemExit as err:
        if isinstance(err.code, str):
            print(err.code, file=sys.stderr)
            return 2
        raise

    import modal

    worker = modal.Cls.from_name(args.app, args.cls)()
    settings = worker.update_autoscaler(
        min_containers=0,
        max_containers=args.max_containers,
        scaledown_window=args.scaledown_window,
    )
    if args.brake:
        print(
            "brake applied: max_containers=0 (no new placements). "
            "This is not a drain and does not cancel in-flight enter/compile. "
            "Restore with --max-containers 1 --scaledown-window 15 when the "
            "compile has published."
        )
    print("live autoscaler now:", settings)
    if settings.max_containers != args.max_containers:
        print("max_containers was not applied", file=sys.stderr)
        return 1
    if settings.min_containers != 0:
        print("min_containers must stay 0", file=sys.stderr)
        return 1
    if settings.scaledown_window != args.scaledown_window:
        print("scaledown_window was not applied", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
