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
# Shallow, single-commit, blobless: the tests import two modules and never run
# the model, so history and weights are not needed.
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
import os
import pathlib
import sys

root = pathlib.Path(os.environ["FISH"]).resolve()
if not (root / "fish_speech").is_dir():
    raise SystemExit(f"{root} does not contain fish_speech/")
sys.path.insert(0, str(root))

# `llama.py` is what the numeric tests import. `inference.py` pulls click and
# hydra at module scope, so the tests extract its two functions by AST instead;
# checking `llama.py` is therefore the honest readiness probe.
try:
    import torch  # noqa: F401
except ImportError:
    raise SystemExit(
        "torch is not installed. Install the CPU build first:\n"
        "  python3 -m pip install --index-url "
        "https://download.pytorch.org/whl/cpu torch"
    )
try:
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
