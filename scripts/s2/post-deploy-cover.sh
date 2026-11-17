#!/usr/bin/env bash
# Post-deploy snapshot cover. Does not start a customer book.
# Reads the live max first and puts that exact cap back, min_containers 0.
# A stale MODAL_TOKEN_ID must not beat the ntemusejoel profile.
set -euo pipefail
cd "$(dirname "$0")/../.."

unset MODAL_TOKEN_ID
unset MODAL_TOKEN_SECRET
export MODAL_PROFILE="${S2C_MODAL_PROFILE:-ntemusejoel}"

APP="${S2C_APP_NAME:-echomancer-s2-clone}"
if [[ "$APP" == "echomancer-s2-clone" ]]; then
  export S2C_ALLOW_PRODUCTION=1
  export S2C_APP_NAME=echomancer-s2-clone
fi

SAVED_MAX="$(python3 scripts/s2/set-live-autoscaler.py --print-max --app "$APP" --profile "$MODAL_PROFILE")"

restore() {
  local status=$?
  trap - EXIT
  if ! python3 scripts/s2/set-live-autoscaler.py \
    --profile "$MODAL_PROFILE" \
    --app "$APP" \
    --max-containers "$SAVED_MAX" \
    --scaledown-window 15; then
    echo "autoscaler restore failed" >&2
    exit 1
  fi
  echo "autoscaler restored max_containers=${SAVED_MAX} min_containers=0"
  exit "$status"
}
trap restore EXIT

python3 -m modal run --quiet modal/s2_clone_warm.py::cover \
  --containers 3 --rounds 6 --streak 3 --scaledown 300
