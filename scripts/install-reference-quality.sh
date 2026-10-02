#!/usr/bin/env bash
# Worker-only runtime for the clone reference gate
# (src/lib/tts/reference-quality). Run from the app directory as the user
# that runs pm2 (e.g. `sudo -u echomancer bash scripts/install-reference-quality.sh`).
#
#  1. onnxruntime-node 1.30.0 (CPU only, ~290 MB) into ./.reference-quality-ort.
#     It is not in package.json so Vercel never bundles it.
#  2. DeepFilterNet 0.5.6 CLI at /usr/local/bin/deep-filter (same pin as
#     install-oracle.sh); needs sudo, skipped when already there.
#
# Without either the gate fails open: no ORT = phone-band and flat checks
# only; no deep-filter = no remaster pass.
set -euo pipefail

ORT_VERSION="1.30.0"
ORT_DIR="${REFERENCE_QUALITY_ORT_DIR:-$PWD/.reference-quality-ort}"

echo "==> onnxruntime-node ${ORT_VERSION} -> ${ORT_DIR}"
mkdir -p "$ORT_DIR"
if [[ ! -f "$ORT_DIR/package.json" ]]; then
  printf '{ "name": "reference-quality-ort", "private": true }\n' > "$ORT_DIR/package.json"
fi
npm install --prefix "$ORT_DIR" --no-audit --no-fund --loglevel=error \
  "onnxruntime-node@${ORT_VERSION}" --onnxruntime-node-install=skip
node -e "require(require('path').join('$ORT_DIR','node_modules','onnxruntime-node')); console.log('onnxruntime-node ok')"

for f in dnsmos_sig_bak_ovr.onnx speaker_encoder.onnx; do
  [[ -f "models/reference-quality/$f" ]] || { echo "missing models/reference-quality/$f" >&2; exit 1; }
done

DEEP_FILTER_VERSION="0.5.6"
if [[ -x /usr/local/bin/deep-filter ]]; then
  echo "==> deep-filter already installed"
else
  case "$(uname -m)" in
    aarch64|arm64)
      url="https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEP_FILTER_VERSION}/deep-filter-${DEEP_FILTER_VERSION}-aarch64-unknown-linux-gnu"
      sha="14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166" ;;
    *)
      url="https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEP_FILTER_VERSION}/deep-filter-${DEEP_FILTER_VERSION}-x86_64-unknown-linux-musl"
      sha="70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da" ;;
  esac
  echo "==> deep-filter ${DEEP_FILTER_VERSION} -> /usr/local/bin/deep-filter"
  tmp="$(mktemp)"
  curl -fsSL -o "$tmp" "$url"
  echo "${sha}  ${tmp}" | sha256sum -c -
  sudo install -m 0755 "$tmp" /usr/local/bin/deep-filter
  rm -f "$tmp"
fi
echo "==> done. Restart the worker: pm2 restart echomancer-takehome --update-env"
