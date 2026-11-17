#!/usr/bin/env bash
# Post-deploy snapshot cover. Does not start a customer book.
# Always leaves min_containers at 0, including when cover fails.
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="${S2C_APP_NAME:-echomancer-s2-clone}"
if [[ "$APP" == "echomancer-s2-clone" ]]; then
  export S2C_ALLOW_PRODUCTION=1
  export S2C_APP_NAME=echomancer-s2-clone
fi

restore() {
  python3 scripts/s2/set-live-autoscaler.py --app "$APP" --max-containers "${S2C_RESTORE_MAX:-1}" --scaledown 15 || true
  echo "autoscaler restored with min_containers=0"
}
trap restore EXIT

python3 -m modal run --quiet modal/s2_clone_warm.py::cover \
  --containers 3 --rounds 6 --streak 3 --scaledown 300
