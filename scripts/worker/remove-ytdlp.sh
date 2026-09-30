#!/usr/bin/env bash
# Remove the YouTube yt-dlp capture stack from the always-on worker.
# Tab audio is recorded in the browser now. Search still uses YOUTUBE_API_KEY on Vercel.
set -euo pipefail

sudo systemctl disable --now echomancer-pot.service 2>/dev/null || true
sudo systemctl disable --now echomancer-ytdlp-update.timer 2>/dev/null || true
sudo systemctl disable --now echomancer-ytdlp-update.service 2>/dev/null || true

sudo rm -f \
  /etc/systemd/system/echomancer-pot.service \
  /etc/systemd/system/echomancer-ytdlp-update.service \
  /etc/systemd/system/echomancer-ytdlp-update.timer \
  /usr/local/bin/yt-dlp \
  /usr/local/bin/echomancer-ytdlp-update

sudo systemctl daemon-reload || true
sudo rm -rf /opt/echomancer-yt

echo "Removed the PO token service, the daily yt-dlp timer, and /opt/echomancer-yt."
echo "If a copy of the provider repo is still in a home directory, delete ~/bgutil-ytdlp-pot-provider."
echo "Delete YTDLP_* lines from .env.worker if they are set. Leave YOUTUBE_API_KEY on Vercel."
