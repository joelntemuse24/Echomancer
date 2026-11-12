"""Set the live S2 autoscaler. Does not deploy and does not rebuild snapshots.

The decorator baked into the image is not what production uses after step 8c.
`modal deploy` wipes GPU memory snapshots and resets this override, so run
this again after any deploy. Do not run it from CI.

Restart the take-home worker first. The worker's default warm hold is 30s,
which has to stay under this window. Lowering the window while the worker
still plans 165s of warmth sends a wide batch at a container that is already
gone.

    python3 scripts/s2/set-live-autoscaler.py --max-containers 20 --scaledown-window 45

`--max-containers` is the worker's MODAL_S2_MAX_GPUS. min_containers stays 0.
"""

from __future__ import annotations

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="echomancer-s2-clone")
    parser.add_argument("--cls", default="S2CloneWorker")
    parser.add_argument("--max-containers", type=int, required=True)
    parser.add_argument("--scaledown-window", type=int, default=45)
    args = parser.parse_args()
    if args.max_containers < 1 or args.max_containers > 64:
        print("max-containers must be 1..64", file=sys.stderr)
        return 2
    if args.scaledown_window < 30 or args.scaledown_window > 60:
        print(
            "scaledown-window must be 30..60 seconds "
            "(the worker warm hold is 15s under 45)",
            file=sys.stderr,
        )
        return 2

    import modal

    worker = modal.Cls.from_name(args.app, args.cls)()
    settings = worker.update_autoscaler(
        min_containers=0,
        max_containers=args.max_containers,
        scaledown_window=args.scaledown_window,
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
