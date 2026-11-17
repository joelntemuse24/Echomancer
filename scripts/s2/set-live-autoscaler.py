"""Set the live S2 autoscaler. Does not deploy and does not rebuild snapshots.

Production `echomancer-s2-clone` stays `min_containers` 0 and
`max_containers` 1. After a deploy, run this with `--max-containers 1` so
the live cap stays there. Raising it needs explicit owner approval.
`modal deploy` wipes GPU memory snapshots and resets this override, so run
the cap-1 call again after any deploy. Do not run it from CI.

Restart the take-home worker first. The worker's default warm hold is 10s,
which has to stay under this window. Lowering the window while the worker
still plans a longer hold sends a wide batch at a container that is already
gone. 15s releases an idle H100 promptly. It does not cancel an in-flight
enter or compile: scaledown only applies once the container has no input.

    python3 scripts/s2/set-live-autoscaler.py --max-containers 1 --scaledown-window 15

`--max-containers` on production is 1. The apply path refuses to run
without that flag (`--brake` sets 0). `--print-max` falls back to
`S2C_RESTORE_MAX` or `MODAL_S2_MAX_GPUS` (the worker lease count, default
20) only when the live autoscaler cannot be read. `post-deploy-cover.sh`
restores whatever that print returned, so a failed live read with that
env set would put the cap back above 1. Raising the cap needs explicit
owner approval. min_containers stays 0.

`--max-containers 0` (or `--brake`) is a temporary brake: it stops new
placements without cancelling an in-flight enter or compile. It does not
drain PENDING inputs. After the compile publishes, restore the max that
was read before the brake (`--scaledown-window 15`, min_containers 0).
Never `FunctionCall.cancel()` or
`modal container stop` mid-enter to "save money"; that reschedules leftovers
and can interrupt snapshot publish.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import NamedTuple


class AutoscalerArgs(NamedTuple):
    app: str
    cls: str
    max_containers: int
    scaledown_window: int
    brake: bool
    print_max: bool = False
    from_env: bool = False
    profile: str | None = None


def config_max_source(environ: dict[str, str] | None = None) -> tuple[int | None, str]:
    """A cap the operator already recorded, and which variable held it.

    ``S2C_RESTORE_MAX`` wins over ``MODAL_S2_MAX_GPUS``. Neither is a guess:
    a missing value stays ``(None, "")``.
    """
    env = environ if environ is not None else os.environ
    for key in ("S2C_RESTORE_MAX", "MODAL_S2_MAX_GPUS"):
        raw = (env.get(key) or "").strip()
        if raw.isdigit() and int(raw) >= 1:
            return int(raw), key
    return None, ""


def saved_max_from_env(environ: dict[str, str] | None = None) -> int | None:
    """A cap the operator already recorded. Never invents 1."""
    value, _name = config_max_source(environ)
    return value


def apply_profile(profile: str | None) -> None:
    if not profile:
        return
    os.environ["MODAL_PROFILE"] = profile
    os.environ.pop("MODAL_TOKEN_ID", None)
    os.environ.pop("MODAL_TOKEN_SECRET", None)


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
    parser.add_argument(
        "--print-max",
        action="store_true",
        help="Print the live max (or the env cap with --from-env) and exit. Does not update.",
    )
    parser.add_argument(
        "--from-env",
        action="store_true",
        help="With --print-max, read S2C_RESTORE_MAX or MODAL_S2_MAX_GPUS and do not call Modal.",
    )
    parser.add_argument(
        "--profile",
        default=None,
        help="Modal profile. Unsets MODAL_TOKEN_ID and MODAL_TOKEN_SECRET so a stale token cannot win.",
    )
    ns = parser.parse_args(argv)
    if ns.print_max:
        return AutoscalerArgs(
            app=ns.app,
            cls=ns.cls,
            max_containers=0 if ns.max_containers is None else ns.max_containers,
            scaledown_window=ns.scaledown_window,
            brake=False,
            print_max=True,
            from_env=bool(ns.from_env),
            profile=ns.profile,
        )
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
        print_max=False,
        from_env=bool(ns.from_env),
        profile=ns.profile,
    )


def emit_max(args: AutoscalerArgs) -> int:
    """Print one integer. The source is logged on stderr. Never a silent 1."""
    apply_profile(args.profile)
    if args.from_env:
        value, name = config_max_source()
        if value is None:
            print(
                "refusing to guess max_containers. "
                "Set MODAL_S2_MAX_GPUS or S2C_RESTORE_MAX.",
                file=sys.stderr,
            )
            return 2
        print(f"print-max: {name}={value} from config", file=sys.stderr)
        print(value)
        return 0
    live: int | None = None
    how = "no reader"
    try:
        import modal

        root = __import__("pathlib").Path(__file__).resolve().parents[2]
        modal_dir = str(root / "modal")
        if modal_dir not in sys.path:
            sys.path.insert(0, modal_dir)
        from s2_contract import read_autoscaler_max

        worker = modal.Cls.from_name(args.app, args.cls)()
        live, how = read_autoscaler_max(worker)
    except Exception as err:
        how = str(err)
        print(f"live autoscaler unread: {err}", file=sys.stderr)
    if live is None:
        fallback, name = config_max_source()
        if fallback is None:
            print(
                f"live autoscaler unread ({how}); refusing to guess max_containers. "
                "Set MODAL_S2_MAX_GPUS or S2C_RESTORE_MAX.",
                file=sys.stderr,
            )
            return 2
        print(
            f"live autoscaler unread ({how}); using {name}={fallback} from config",
            file=sys.stderr,
        )
        print(fallback)
        return 0
    print(f"print-max: live max_containers={live} via {how}", file=sys.stderr)
    print(live)
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
    except SystemExit as err:
        if isinstance(err.code, str):
            print(err.code, file=sys.stderr)
            return 2
        raise
    apply_profile(args.profile)
    if args.print_max:
        return emit_max(args)

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
            "Restore the max that was read before the brake, with min_containers=0."
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
