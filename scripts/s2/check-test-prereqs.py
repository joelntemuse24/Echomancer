#!/usr/bin/env python3
"""Report whether the Modal test suite can actually run, and fix what is missing.

Several suites compare this branch against things only the image has: the CPU
`torch` build, the pinned `fish-speech` source, and the base branch in git. Each
of those skips when absent, which is right on a laptop and wrong in CI — a suite
where a third of the assertions quietly did not run still prints "passed".

So this prints one line per prerequisite, tells you the exact command to fix it,
and exits non-zero when something needed is missing. `--strict` treats a missing
optional prerequisite as a failure.

    python3 scripts/s2/check-test-prereqs.py
    python3 scripts/s2/check-test-prereqs.py --strict   # what CI should run

Nothing here installs or changes anything, and nothing touches Modal, a GPU, or a
paid API. The commands it prints are for you to run.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import pathlib
import shutil
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent.parent

#: Keep in step with `modal/s2_batch.py` and `scripts/s2/fetch-fish-source.sh`.
FISH_COMMIT = "541566932abbaebcb0a40e562a1f846738383f38"
BASE_COMMIT = "ebd7adeaa9ddb7267e5ff46e7cd969c66931d0ac"
FETCH_CMD = "bash scripts/s2/fetch-fish-source.sh"
TORCH_CMD = (
    "python3 -m pip install --index-url https://download.pytorch.org/whl/cpu torch"
)


def _ok(message: str) -> bool:
    print(f"  ok    {message}")
    return True


def _missing(message: str, fix: str) -> bool:
    print(f"  MISS  {message}")
    print(f"        fix: {fix}")
    return False


def check_torch() -> bool:
    spec = importlib.util.find_spec("torch")
    if spec is None:
        return _missing(
            "torch (CPU) is not installed; every numeric test would skip", TORCH_CMD
        )
    import torch

    version = getattr(torch, "__version__", "?")
    if "+cpu" not in version and not torch.cuda.is_available():
        # A CUDA build with no device still works for CPU maths; only note it.
        return _ok(f"torch {version} (no CUDA device; CPU maths only)")
    return _ok(f"torch {version}")


def check_fish_source() -> str | None:
    for candidate in (
        os.environ.get("S2B_FISH_DIR"),
        "/opt/fish-speech",
        str(REPO / ".fish-speech-src"),
    ):
        if not candidate:
            continue
        root = pathlib.Path(candidate)
        if (root / "fish_speech" / "models" / "text2semantic" / "llama.py").is_file():
            _ok(f"fish-speech source at {root}")
            return str(root)
    _missing(
        "pinned fish-speech source; the upstream comparisons and the token "
        "identity tests would skip",
        FETCH_CMD,
    )
    return None


def check_fish_importable(source: str | None) -> bool:
    if source is None:
        return False
    code = (
        "import sys; sys.path.insert(0, %r);"
        "import fish_speech.models.text2semantic.llama as m;"
        "print('ok')" % source
    )
    try:
        out = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True, timeout=120
        )
    except (OSError, subprocess.SubprocessError) as err:
        return _missing(f"fish-speech could not be imported: {err}", FETCH_CMD)
    if out.returncode != 0:
        tail = (out.stderr or out.stdout).strip().splitlines()[-1:] or ["unknown"]
        return _missing(f"fish-speech import failed: {tail[0]}", TORCH_CMD)
    return _ok("fish_speech.models.text2semantic.llama imports")


def check_base_source() -> bool:
    git = shutil.which("git")
    if git is None:
        return _missing("git is not installed; the v9 identity suite needs it", "install git")
    try:
        out = subprocess.run(
            [git, "show", f"{BASE_COMMIT}:modal/s2_batch.py"],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as err:
        return _missing(f"git could not be read: {err}", "re-clone the repo")
    if out.returncode != 0 or "class _BatchEngine" not in out.stdout:
        return _missing(
            f"modal/s2_batch.py at {BASE_COMMIT[:7]} is not in this clone; the v9 "
            "identity suite would skip",
            f"git fetch origin cursor/longer-clone-sections-4994  # or a full clone",
        )
    return _ok(f"PR 283's engine at {BASE_COMMIT[:7]} is readable from git")


def check_ffmpeg() -> bool:
    if shutil.which("ffmpeg") is None:
        # Only the mastering-parity tests need it; those skip without it.
        return _missing(
            "ffmpeg; the piped-mastering parity tests would skip",
            "apt-get install -y ffmpeg",
        )
    return _ok("ffmpeg")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero when any prerequisite is missing (what CI should use)",
    )
    args = parser.parse_args()

    print("Modal test prerequisites\n")
    results = [check_torch()]
    source = check_fish_source()
    results.append(source is not None)
    results.append(check_fish_importable(source))
    results.append(check_base_source())
    results.append(check_ffmpeg())

    print()
    if all(results):
        print("All prerequisites present. Run the suite with assertions enforced:")
        print("  S2B_REQUIRE_FISH_SOURCE=1 python3 -m pytest modal -q")
        return 0
    print(
        f"{results.count(False)} prerequisite(s) missing. Suites that need them "
        "will SKIP, which is not the same as passing."
    )
    if args.strict:
        print("--strict: treating this as a failure.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
