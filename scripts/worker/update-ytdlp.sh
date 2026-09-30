#!/usr/bin/env bash
# Daily yt-dlp refresh. Installed by scripts/worker/install-ytdlp.sh.
set -euo pipefail
MIN_VERSION="${YTDLP_MIN_VERSION:-2025.10.14}"

VENV="${YTDLP_VENV:-/opt/echomancer-yt}"
if [[ ! -x "$VENV/bin/pip" ]]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -U "yt-dlp>=${MIN_VERSION}" bgutil-ytdlp-pot-provider

if [[ -x /usr/local/bin/yt-dlp ]]; then
  version="$(/usr/local/bin/yt-dlp --version | awk '{print $1}')"
else
  version="$("$VENV/bin/yt-dlp" --version | awk '{print $1}')"
fi
echo "yt-dlp ${version} (minimum ${MIN_VERSION})"
python3 - <<PY
cur = "${version}".split(".")
need = "${MIN_VERSION}".split(".")
if tuple(int(p) for p in cur[:3]) < tuple(int(p) for p in need[:3]):
    raise SystemExit(f"yt-dlp {cur} is older than {need}")
PY
