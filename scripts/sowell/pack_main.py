"""Image-build check. Exits non-zero when the pack does not match the manifest."""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pack import PackError, check_pack, load_manifest, manifest_path


def main() -> int:
    pack = Path(os.environ.get("SOWELL_PACK", ""))
    manifest = manifest_path(os.environ.get("SOWELL_MANIFEST") or None)
    if not pack.is_file():
        print(f"Sowell pack missing: {pack}", file=sys.stderr)
        return 1
    try:
        check_pack(pack, load_manifest(manifest))
    except PackError as err:
        print(str(err), file=sys.stderr)
        return 1
    print("sowell pack ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
