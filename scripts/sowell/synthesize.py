"""One short take. The engine stays in this process if imported.

The CLI loads once and exits. The Modal container keeps a SowellEngine
for the life of the container instead of starting a process per request.

    python3 scripts/sowell/synthesize.py \
      --pack voices/sowell/am_sowell_avg.pt \
      --text "The harbor was quiet." --out /tmp/take.wav

Drew reads its own weights from the volume (`DREW_VOLUME_MOUNT`), so no
`--pack` is needed for `--voice drew`.
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
    parser.add_argument("--pack", default=None)
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--voice", default="am_sowell")
    parser.add_argument(
        "--speed",
        type=float,
        default=1.0,
        help="App speed. 1.0 is native; Drew multiplies it by 0.88.",
    )
    args = parser.parse_args()
    engine = SowellEngine()
    try:
        wav, report = engine.speak(
            args.text,
            Path(args.pack or ""),
            manifest_path(args.manifest) if args.manifest else None,
            voice=args.voice,
            speed=args.speed,
        )
    except PackError as err:
        print(str(err), file=sys.stderr)
        return 1
    Path(args.out).write_bytes(wav)
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
