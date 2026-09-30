#!/usr/bin/env bash
# Daily yt-dlp refresh. Installed by scripts/worker/install-ytdlp.sh.
set -euo pipefail
MIN_VERSION="${YTDLP_MIN_VERSION:-2025.10.14}"

if command -v yt-dlp >/dev/null 2>&1; then
  yt-dlp -U || true
fi
python3 -m pip install -U "yt-dlp>=${MIN_VERSION}" bgutil-ytdlp-pot-provider

version="$(yt-dlp --version | awk '{print $1}')"
echo "yt-dlp ${version} (minimum ${MIN_VERSION})"
python3 - <<PY
cur = "${version}".split(".")
need = "${MIN_VERSION}".split(".")
if tuple(int(p) for p in cur[:3]) < tuple(int(p) for p in need[:3]):
    raise SystemExit(f"yt-dlp {cur} is older than {need}")
PY
