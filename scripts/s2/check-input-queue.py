#!/usr/bin/env python3
"""Refuse to start a warm or probe when the S2 function still has unfinished inputs.

    python3 scripts/s2/check-input-queue.py
    python3 scripts/s2/check-input-queue.py --app echomancer-s2-clone-staging

Exit 0 when the recent FunctionCall list has no PENDING or unfinished rows.
See docs/s2-gpu-staging-runbook.md (safe draining).
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "modal"))

from s2_input_queue import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
