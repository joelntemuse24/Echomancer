#!/usr/bin/env bash
# Install yt-dlp, the bgutil PO-token provider, and a daily update timer.
# Run on the always-on worker (the same VM as echomancer-takehome).
# Optional: --with-demucs  (large; torch). Clean speech skips separation.
set -euo pipefail

MIN_VERSION="${YTDLP_MIN_VERSION:-2025.10.14}"
POT_PORT="${YTDLP_POT_PORT:-4416}"
WITH_DEMUCS=0
for arg in "$@"; do
  if [[ "$arg" == "--with-demucs" ]]; then
    WITH_DEMUCS=1
  fi
done

if ! command -v ffmpeg >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ffmpeg python3 python3-pip ca-certificates curl
fi

install_ytdlp() {
  python3 -m pip install -U "yt-dlp>=${MIN_VERSION}" bgutil-ytdlp-pot-provider
  sudo tee /usr/local/bin/yt-dlp >/dev/null <<'EOF'
#!/bin/sh
exec python3 -m yt_dlp "$@"
EOF
  sudo chmod 755 /usr/local/bin/yt-dlp
}

install_ytdlp

version="$(yt-dlp --version | awk '{print $1}')"
echo "yt-dlp ${version} (minimum ${MIN_VERSION})"
python3 - <<PY
cur = "${version}".split(".")
need = "${MIN_VERSION}".split(".")
if tuple(int(x) for x in cur[:3]) < tuple(int(x) for x in need[:3]):
    raise SystemExit(f"yt-dlp {cur} is older than {need}")
PY

if command -v node >/dev/null 2>&1; then
  POT_HOME="${YTDLP_POT_HOME:-$HOME/bgutil-ytdlp-pot-provider}"
  if [[ ! -d "$POT_HOME/server" ]]; then
    git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$POT_HOME"
  fi
  if [[ -f "$POT_HOME/server/package.json" ]]; then
    (cd "$POT_HOME/server" && npm ci && npx tsc)
  fi
  if [[ -f "$POT_HOME/server/build/main.js" ]]; then
    sudo tee /etc/systemd/system/echomancer-pot.service >/dev/null <<UNIT
[Unit]
Description=Echomancer bgutil PO token server
After=network.target

[Service]
WorkingDirectory=${POT_HOME}/server
ExecStart=/usr/bin/env node build/main.js --port ${POT_PORT}
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl daemon-reload
    sudo systemctl enable --now echomancer-pot.service || true
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sudo install -m 755 "$SCRIPT_DIR/update-ytdlp.sh" /usr/local/bin/echomancer-ytdlp-update
sudo tee /etc/systemd/system/echomancer-ytdlp-update.service >/dev/null <<'UNIT'
[Unit]
Description=Update yt-dlp and the bgutil plugin

[Service]
Type=oneshot
ExecStart=/usr/local/bin/echomancer-ytdlp-update
UNIT
sudo tee /etc/systemd/system/echomancer-ytdlp-update.timer >/dev/null <<'UNIT'
[Unit]
Description=Daily yt-dlp update

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now echomancer-ytdlp-update.timer

if [[ "$WITH_DEMUCS" == "1" ]]; then
  python3 -m pip install -U demucs
fi

echo "yt-dlp $(yt-dlp --version | awk '{print $1}')"
echo "PO token default: http://127.0.0.1:${POT_PORT}"
echo "Optional env: YTDLP_COOKIES_FILE  YTDLP_PROXY  YTDLP_POT_BASE_URL"
