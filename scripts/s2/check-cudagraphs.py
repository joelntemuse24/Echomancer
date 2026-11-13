#!/usr/bin/env python3
"""Fail if the clone app's logs show the decode step losing its CUDA graphs.

The whole v10 speedup depends on `_decode_step` running as a CUDA graph. Two
things silently take that away, and neither is visible from a `/ready` response
or a successful call:

1. ``skipping cudagraphs`` -- inductor refused to capture, usually because an
   argument became a CPU tensor (``arg10_1``). The call still works, roughly
   twice as slowly.
2. A graph recorded on a request -- a shape the snapshot never warmed. Also
   correct, also slow, and it happens on the customer's first section rather
   than at boot.

So this reads the app log and fails on either. It is a gate, not a report: run it
after warming a staging build and before recording the A/B baseline.

    S2C_APP_NAME=echomancer-s2-clone-staging \\
      python3 scripts/s2/check-cudagraphs.py --since 30m

Exit codes: 0 clean, 1 a graph was skipped or recorded late, 2 the log could not
be read. Nothing here starts a container: ``modal app logs`` reads what is
already there.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

#: Lines that mean the decode step is not running as a captured graph.
FORBIDDEN = (
    (
        re.compile(r"skipping cudagraphs", re.I),
        "inductor skipped CUDA graphs - a CPU tensor argument (arg10_1) is back",
    ),
    (
        re.compile(r"cudagraph.*(skip|disabl)", re.I),
        "CUDA graphs were skipped or disabled",
    ),
    (
        re.compile(r"recompil", re.I),
        "a kernel recompiled - a shape the snapshot did not warm",
    ),
)

#: Lines that must be present: the boot proof that capture happened and that a
#: restored container could replay what it captured.
REQUIRED = (
    (re.compile(r"\[S2B\] warm decode shapes: (\d+)"), "warm decode shapes"),
    (re.compile(r"\[S2B\] selftest: .*'ok': True"), "selftest ok"),
    (re.compile(r"graphs=ok\((\d+)\)"), "post-restore graph replay"),
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app",
        default=os.environ.get("S2C_APP_NAME", "echomancer-s2-clone-staging"),
        help="Modal app to read (default: the staging app from S2C_APP_NAME)",
    )
    parser.add_argument("--since", default="30m", help="log window, e.g. 30m or 2h")
    parser.add_argument(
        "--expect-shapes",
        type=int,
        default=0,
        help="how many decode shapes the warm-up must have recorded (0 = any)",
    )
    args = parser.parse_args()

    try:
        result = subprocess.run(
            ["modal", "app", "logs", args.app, "--since", args.since],
            capture_output=True,
            text=True,
            timeout=180,
        )
    except (OSError, subprocess.SubprocessError) as err:
        print(f"cannot read logs for {args.app}: {err}", file=sys.stderr)
        return 2
    if result.returncode != 0:
        print(
            f"`modal app logs {args.app}` failed ({result.returncode}): "
            f"{result.stderr.strip()[:400]}",
            file=sys.stderr,
        )
        return 2
    log = result.stdout
    if not log.strip():
        print(
            f"the log for {args.app} is empty; warm the app first "
            "(modal run modal/s2_clone_warm.py)",
            file=sys.stderr,
        )
        return 2

    failures: list[str] = []
    for pattern, why in FORBIDDEN:
        for line in log.splitlines():
            if pattern.search(line):
                failures.append(f"{why}\n    {line.strip()[:200]}")

    for pattern, label in REQUIRED:
        found = [m for m in (pattern.search(line) for line in log.splitlines()) if m]
        if not found:
            failures.append(f"missing log line: {label}")
            continue
        if label == "warm decode shapes" and args.expect_shapes:
            shapes = int(found[-1].group(1))
            if shapes != args.expect_shapes:
                failures.append(
                    f"warm-up recorded {shapes} decode shape(s), expected exactly "
                    f"{args.expect_shapes}: a call at a shape that was not warmed "
                    "records its graph on the request path"
                )

    # The replayed count must *equal* the warmed count when the caller says what
    # it expects: `graphs=ok(6)` against 24 warmed shapes means three quarters of
    # the shapes were never proven, which is the shape of bug this gate exists
    # for. A ">=" test would pass on it.
    if args.expect_shapes:
        for match in re.finditer(r"graphs=ok\((\d+)\)", log):
            replayed = int(match.group(1))
            if replayed != args.expect_shapes:
                failures.append(
                    f"post-restore replay covered {replayed} shape(s), expected "
                    f"exactly {args.expect_shapes}; the remaining shapes would "
                    "record a graph on a customer's first section"
                )

    if failures:
        print(f"{len(failures)} CUDA-graph problem(s) in {args.app} ({args.since}):\n")
        for entry in dict.fromkeys(failures):
            print(f"  FAIL  {entry}")
        print(
            "\nA call still succeeds with graphs skipped, which is why this is a "
            "gate rather than a symptom. Do not record an A/B baseline against "
            "this build."
        )
        return 1

    print(
        f"{args.app}: decode graphs captured, warmed and replayed on restore "
        f"({args.since})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
