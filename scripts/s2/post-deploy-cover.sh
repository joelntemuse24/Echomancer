#!/usr/bin/env bash
# Read the live autoscaler max, run ::cover, and put that max back.
# min_containers stays 0. The profile is forced so a worker token in the
# environment cannot point this at the wrong workspace.
#
# The interpreter is MODAL_PYTHON, or the first python on PATH that imports
# modal. A system python without the package fails here, with that reason.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=modal-python.sh
source "$(dirname "$0")/modal-python.sh"

unset MODAL_TOKEN_ID
unset MODAL_TOKEN_SECRET
export MODAL_PROFILE="${S2C_MODAL_PROFILE:-ntemusejoel}"

APP="${S2C_APP_NAME:-echomancer-s2-clone}"
if [ "$APP" = "echomancer-s2-clone" ]; then
  export S2C_ALLOW_PRODUCTION=1
  export S2C_APP_NAME=echomancer-s2-clone
fi

PY="$(resolve_modal_python)"

SAVED_MAX="$("$PY" scripts/s2/set-live-autoscaler.py --print-max --app "$APP" --profile "$MODAL_PROFILE")"
# Production stays at most 1. S2_ALLOW_PROD_CAP_ABOVE_1=1 is the only override.
# Staging is not clamped. This call does not touch Modal.
SAVED_MAX="$("$PY" scripts/s2/set-live-autoscaler.py --clamp-restore "$SAVED_MAX" --app "$APP")"
echo "cover will restore max_containers=$SAVED_MAX (min_containers=0)"

restore() {
  "$PY" scripts/s2/set-live-autoscaler.py \
    --max-containers "$SAVED_MAX" \
    --scaledown-window 15 \
    --app "$APP" \
    --profile "$MODAL_PROFILE"
}
trap restore EXIT

"$PY" -m modal run --quiet modal/s2_clone_warm.py::cover \
  --containers 3 --rounds 6 --streak 3 --scaledown 300
