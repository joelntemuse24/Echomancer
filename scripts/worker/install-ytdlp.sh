#!/usr/bin/env bash
# Install a pinned yt-dlp for proxied YouTube section downloads.
# Browser tab capture does not use this binary.
set -euo pipefail

PIN="${1:-2026.08.19}"
ROOT="/opt/echomancer-yt"

python3 -m venv "$ROOT"
"$ROOT/bin/pip" install -U pip
"$ROOT/bin/pip" install "yt-dlp==${PIN}"
ln -sfn "$ROOT/bin/yt-dlp" /usr/local/bin/yt-dlp
echo "yt-dlp $($ROOT/bin/yt-dlp --version) installed at /usr/local/bin/yt-dlp"
