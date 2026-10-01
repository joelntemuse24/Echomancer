#!/usr/bin/env bash
# Reinstall the pinned yt-dlp. Pass a version to change the pin.
set -euo pipefail

PIN="${1:-2026.08.19}"
ROOT="/opt/echomancer-yt"

if [[ ! -x "$ROOT/bin/pip" ]]; then
  echo "Run scripts/worker/install-ytdlp.sh first" >&2
  exit 1
fi

"$ROOT/bin/pip" install "yt-dlp==${PIN}"
ln -sfn "$ROOT/bin/yt-dlp" /usr/local/bin/yt-dlp
echo "yt-dlp $($ROOT/bin/yt-dlp --version)"
