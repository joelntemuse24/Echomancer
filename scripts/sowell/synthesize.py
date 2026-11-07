"""One short Sowell take. The engine stays in this process if imported.

The CLI loads once and exits. The Modal container keeps a SowellEngine
for the life of the container instead of starting a process per request.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import SowellEngine
from pack import PackError, manifest_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", required=True)
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    engine = SowellEngine()
    try:
        wav, report = engine.speak(
            args.text,
            Path(args.pack),
            manifest_path(args.manifest) if args.manifest else None,
        )
    except PackError as err:
        print(str(err), file=sys.stderr)
        return 1
    Path(args.out).write_bytes(wav)
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
