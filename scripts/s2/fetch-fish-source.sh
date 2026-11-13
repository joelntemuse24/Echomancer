#!/usr/bin/env bash
# Fetch the pinned fish-speech source that the numeric tests compare against.
#
# `modal/test_s2_numerics.py` and `modal/test_s2_legacy_identity.py` compare this
# branch's decode maths against the **upstream package** (and, for the v9
# identity checks, against PR 283's module read out of git). Both need a checkout
# of `fish-speech` at the commit `modal/s2_batch.py` pins. The GPU image has one
# at `/opt/fish-speech`; a CI runner or the VM does not, so this puts it at
# `.fish-speech-src` (gitignored) where the tests look for it.
#
#   bash scripts/s2/fetch-fish-source.sh
#   S2B_REQUIRE_FISH_SOURCE=1 python3 -m pytest modal -q
#
# Shallow, single-commit, blobless: the tests import one module and never run the
# model, so history and weights are not needed.
#
# Needs: python3 with `torch` (CPU build is fine), `einops` and `loguru`. The
# last two are upstream's own dependencies and are **not** pulled in by installing
# torch, which is how a clean runner failed this the first time. This script
# names them rather than letting the import fail inside fish-speech.
#
# Nothing here touches Modal, the GPU, or a paid API.
set -euo pipefail

#: Keep in step with `FISH_SPEECH_COMMIT` in `modal/s2_batch.py`.
COMMIT="541566932abbaebcb0a40e562a1f846738383f38"
REPO="https://github.com/fishaudio/fish-speech.git"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${S2B_FISH_SOURCE_DIR:-$HERE/../../.fish-speech-src}"

if [[ -d "$DEST/fish_speech" ]]; then
  echo "already present: $DEST"
else
  echo "fetching fish-speech@${COMMIT:0:12} into $DEST"
  mkdir -p "$DEST"
  git -C "$DEST" init --quiet
  git -C "$DEST" remote remove origin 2>/dev/null || true
  git -C "$DEST" remote add origin "$REPO"
  # Blobless depth-1 fetch of one commit; the checkout still writes the working
  # tree files the tests import.
  git -C "$DEST" fetch --quiet --depth 1 --filter=blob:none origin "$COMMIT"
  git -C "$DEST" checkout --quiet FETCH_HEAD
fi

FISH="$DEST" python3 - <<'PY'
import importlib
import importlib.util
import os
import pathlib
import sys

root = pathlib.Path(os.environ["FISH"]).resolve()
if not (root / "fish_speech").is_dir():
    raise SystemExit(f"{root} does not contain fish_speech/")
sys.path.insert(0, str(root))

# The import the numeric tests rely on. `llama.py` needs torch, numpy and
# upstream's own einops and loguru; a bare `pip install torch` brings torch and
# numpy but not the last two, which is how the first CI run failed. They are
# checked here and reported by name.
REQUIRED = ("torch", "numpy", "einops", "loguru")


def _present(name: str) -> bool:
    # `find_spec` can raise rather than answer when a package's own import is
    # broken (a stray shadowing module on PYTHONPATH, say). Treat any failure as
    # "not usable", because that is what an `import` would do.
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


missing = [name for name in REQUIRED if not _present(name)]
if missing:
    raise SystemExit(
        "missing Python package(s): "
        + ", ".join(missing)
        + "\n  python3 -m pip install --index-url "
        "https://download.pytorch.org/whl/cpu torch"
        + "\n  python3 -m pip install numpy einops loguru"
    )

try:
    # `inference.py` pulls click and hydra at module scope, so the tests extract
    # its two functions by AST rather than importing it. `llama.py` is therefore
    # the honest readiness probe.
    importlib.import_module("fish_speech.models.text2semantic.llama")
except Exception as err:
    raise SystemExit(
        f"fish_speech.models.text2semantic.llama could not be imported: {err}\n"
        "The numeric tests need it; without it they skip, or fail under "
        "S2B_REQUIRE_FISH_SOURCE=1."
    )
print(f"ok: {root}")
PY

echo
echo "Now run:"
echo "  S2B_FISH_DIR=$DEST S2B_REQUIRE_FISH_SOURCE=1 python3 -m pytest modal -q"
