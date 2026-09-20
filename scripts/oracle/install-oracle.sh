#!/usr/bin/env bash
# Bootstrap the Whole-book take-home worker on an Oracle Always Free VM.
#
# Primary path is pm2 + Node + ffmpeg (no Docker). Run from the repo root:
#   bash scripts/oracle/install-oracle.sh
#   bash scripts/oracle/install-oracle.sh --start
#   bash scripts/oracle/install-oracle.sh --with-caddy
#   bash scripts/oracle/install-oracle.sh --with-cloudflared
#
# Does not write secrets. Copy env.worker.example → .env.worker and fill it
# before --start. See WORKER.md.

set -euo pipefail

WITH_CADDY=0
WITH_CLOUDFLARED=0
START=0

usage() {
  cat <<'EOF'
Usage: bash scripts/oracle/install-oracle.sh [options]

  --start            pm2 start (requires a filled .env.worker)
  --with-caddy       also install Caddy (public 443 + Let's Encrypt)
  --with-cloudflared also install cloudflared (named tunnel; no public 8788)
  -h, --help         show this help

Run from the Echomancer repo root on Ubuntu 22.04/24.04 (aarch64 or x86_64).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --start) START=1; shift ;;
    --with-caddy) WITH_CADDY=1; shift ;;
    --with-cloudflared) WITH_CLOUDFLARED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f package.json ]] || [[ ! -f env.worker.example ]]; then
  echo "Run this script from the Echomancer repository root." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Need root or sudo to install apt packages and /usr/local/bin/deep-filter." >&2
    exit 1
  fi
  SUDO="sudo"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) ARCH_KIND=arm64 ;;
  x86_64|amd64) ARCH_KIND=amd64 ;;
  *)
    echo "Unsupported architecture: $ARCH (need aarch64 or x86_64)." >&2
    exit 1
    ;;
esac

# DeepFilterNet rust CLI 0.5.6 — same release as workers/takehome/Dockerfile
# and trigger.config.ts. Not Python+torch.
DEEP_FILTER_VERSION="0.5.6"
DEEP_FILTER_URL_AMD64="https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEP_FILTER_VERSION}/deep-filter-${DEEP_FILTER_VERSION}-x86_64-unknown-linux-musl"
DEEP_FILTER_SHA256_AMD64="70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da"
DEEP_FILTER_URL_ARM64="https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEP_FILTER_VERSION}/deep-filter-${DEEP_FILTER_VERSION}-aarch64-unknown-linux-gnu"
DEEP_FILTER_SHA256_ARM64="14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166"

if [[ "$ARCH_KIND" == "arm64" ]]; then
  DEEP_FILTER_URL="$DEEP_FILTER_URL_ARM64"
  DEEP_FILTER_SHA256="$DEEP_FILTER_SHA256_ARM64"
else
  DEEP_FILTER_URL="$DEEP_FILTER_URL_AMD64"
  DEEP_FILTER_SHA256="$DEEP_FILTER_SHA256_AMD64"
fi

echo "==> Installing apt packages (git, curl, ffmpeg, ca-certificates)"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  ffmpeg \
  git \
  gnupg \
  libatomic1 \
  xz-utils

need_node=0
if ! command -v node >/dev/null 2>&1; then
  need_node=1
else
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "${NODE_MAJOR}" -lt 20 ]]; then
    need_node=1
  fi
fi

if [[ "$need_node" -eq 1 ]]; then
  echo "==> Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

echo "==> Node $(node -v) / npm $(npm -v) on ${ARCH}"

echo "==> npm ci"
npm ci

echo "==> Installing DeepFilterNet ${DEEP_FILTER_VERSION} (${ARCH_KIND})"
tmp_bin="$(mktemp)"
curl -fsSL -o "$tmp_bin" "$DEEP_FILTER_URL"
echo "${DEEP_FILTER_SHA256}  ${tmp_bin}" | sha256sum -c -
$SUDO install -m 0755 "$tmp_bin" /usr/local/bin/deep-filter
rm -f "$tmp_bin"
/usr/local/bin/deep-filter --version >/dev/null 2>&1 || \
  echo "warning: deep-filter --version failed; binary is still installed at /usr/local/bin/deep-filter"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing pm2"
  $SUDO npm install -g pm2
fi

if [[ "$WITH_CADDY" -eq 1 ]]; then
  if ! command -v caddy >/dev/null 2>&1; then
    echo "==> Installing Caddy"
    $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
      $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
      $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    $SUDO apt-get update -y
    $SUDO apt-get install -y caddy
  fi
  echo "Caddy installed. Copy scripts/oracle/Caddyfile.example to /etc/caddy/Caddyfile and reload."
fi

if [[ "$WITH_CLOUDFLARED" -eq 1 ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "==> Installing cloudflared"
    cf_tmp="$(mktemp)"
    if [[ "$ARCH_KIND" == "arm64" ]]; then
      cf_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
    else
      cf_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    fi
    curl -fsSL -o "$cf_tmp" "$cf_url"
    $SUDO install -m 0755 "$cf_tmp" /usr/local/bin/cloudflared
    rm -f "$cf_tmp"
  fi
  echo "cloudflared $(cloudflared --version 2>/dev/null | head -n1). See WORKER.md for a named tunnel."
fi

if [[ ! -f .env.worker ]]; then
  cp env.worker.example .env.worker
  echo "Wrote .env.worker from env.worker.example — fill Turso, R2, WORKER_SECRET, TTS keys."
fi

if [[ "$START" -eq 1 ]]; then
  if ! grep -qE '^WORKER_SECRET=.+' .env.worker && \
     ! grep -qE '^INTERNAL_JOB_SECRET=.+' .env.worker; then
    echo "Refusing --start: set WORKER_SECRET (or INTERNAL_JOB_SECRET) in .env.worker." >&2
    exit 1
  fi
  echo "==> pm2 start scripts/oracle/ecosystem.config.cjs"
  pm2 start scripts/oracle/ecosystem.config.cjs
  pm2 save
  echo "Enable reboot persist with:"
  echo "  ${SUDO} env PATH=\$PATH:$(dirname "$(command -v node)") pm2 startup systemd -u $(id -un) --hp \$HOME"
fi

cat <<EOF

Oracle take-home worker packages are installed.

Next:
  1. Edit .env.worker (Turso + R2 + WORKER_SECRET + FISH/GOOGLE as needed).
  2. Bind loopback only (ecosystem.config.cjs sets WORKER_HOST=127.0.0.1).
  3. pm2 start scripts/oracle/ecosystem.config.cjs && pm2 save
     ${SUDO} env PATH=\$PATH:$(dirname "$(command -v node)") pm2 startup systemd -u $(id -un) --hp \$HOME
  4. bash scripts/oracle/smoke-worker.sh
  5. Put TLS in front (Cloudflare tunnel or Caddy). Set Vercel WORKER_URL + WORKER_SECRET.

Do not publish 8788 on 0.0.0.0. Extract stays on Cloudflare Workers.
EOF
