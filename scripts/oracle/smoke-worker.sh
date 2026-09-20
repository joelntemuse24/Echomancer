#!/usr/bin/env bash
# Smoke the take-home worker HTTP surface (health / ready / auth).
#
#   bash scripts/oracle/smoke-worker.sh
#   bash scripts/oracle/smoke-worker.sh http://127.0.0.1:8788
#   WORKER_SECRET=… bash scripts/oracle/smoke-worker.sh https://worker.example.com
#
# Does not create a real book. After this is green, enqueue a tiny Whole-book
# job from the app (see the notes printed at the end).

set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8788}"
BASE_URL="${BASE_URL%/}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${WORKER_ENV_FILE:-${REPO_ROOT}/.env.worker}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '%s\n' "$*"; }

fail=0

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo ""
    return 0
  fi
  # Last matching assignment wins. Do not source the file.
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 || true)"
  echo "${line#${key}=}"
}

SECRET="${WORKER_SECRET:-}"
if [[ -z "$SECRET" ]]; then
  SECRET="$(read_env_value WORKER_SECRET)"
fi
if [[ -z "$SECRET" ]]; then
  SECRET="$(read_env_value INTERNAL_JOB_SECRET)"
fi

check_json() {
  local name="$1"
  local url="$2"
  local expect_status="$3"
  local extra_curl=("${@:4}")
  local body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' --max-time 10 \
    "${extra_curl[@]}" "$url" || echo "000")"
  if [[ "$status" != "$expect_status" ]]; then
    red "FAIL ${name}: expected HTTP ${expect_status}, got ${status}"
    cat "$body" >&2 || true
    echo >&2
    fail=1
  else
    green "OK   ${name}: HTTP ${status}  $(tr -d '\n' < "$body" | head -c 160)"
  fi
  rm -f "$body"
}

if [[ -f "$ENV_FILE" ]]; then
  info "Checking ${ENV_FILE} keys (values not printed)"
  missing=()
  for key in TURSO_DATABASE_URL TURSO_AUTH_TOKEN R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME; do
    if [[ -z "$(read_env_value "$key")" ]]; then
      missing+=("$key")
    fi
  done
  if [[ -z "$SECRET" ]]; then
    missing+=("WORKER_SECRET")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    red "Missing in ${ENV_FILE}: ${missing[*]}"
    fail=1
  else
    green "OK   required Turso / R2 / WORKER_SECRET keys are set"
  fi
  if [[ -z "$(read_env_value FISH_API_KEY)" ]]; then
    info "note: FISH_API_KEY empty — Clara / clones will fail; Edge stock is fine"
  fi
  if [[ -z "$(read_env_value GOOGLE_TTS_API_KEY)" && -z "$(read_env_value GOOGLE_TTS_ACCESS_TOKEN)" ]]; then
    info "note: GOOGLE_TTS_API_KEY empty — Randolph will fail; other stock voices are fine"
  fi
else
  info "No ${ENV_FILE} — skipping key checklist (HTTP checks still run)"
fi

info "GET ${BASE_URL}/health"
check_json "health" "${BASE_URL}/health" "200"

info "GET ${BASE_URL}/ready"
ready_body="$(mktemp)"
ready_status="$(curl -sS -o "$ready_body" -w '%{http_code}' --max-time 10 \
  "${BASE_URL}/ready" || echo "000")"
if [[ "$ready_status" == "200" ]]; then
  green "OK   ready: HTTP 200  $(tr -d '\n' < "$ready_body" | head -c 160)"
elif [[ "$ready_status" == "503" ]]; then
  red "FAIL ready: HTTP 503 — Turso is not answering from this VM"
  cat "$ready_body" || true
  echo
  fail=1
else
  red "FAIL ready: expected 200, got ${ready_status}"
  cat "$ready_body" || true
  echo
  fail=1
fi
rm -f "$ready_body"

info "POST ${BASE_URL}/jobs without auth (expect 401)"
check_json "jobs-unauth" "${BASE_URL}/jobs" "401" \
  -X POST -H 'content-type: application/json' \
  --data '{"jobId":"smoke-missing-auth"}'

if [[ -n "$SECRET" ]]; then
  info "POST ${BASE_URL}/jobs with auth + fake id (expect 404)"
  check_json "jobs-unknown" "${BASE_URL}/jobs" "404" \
    -X POST \
    -H 'content-type: application/json' \
    -H "Authorization: Bearer ${SECRET}" \
    --data '{"jobId":"smoke-does-not-exist"}'
else
  info "skip  POST /jobs auth check — no WORKER_SECRET in the environment"
fi

cat <<EOF

Tiny real-job enqueue (after Vercel WORKER_URL is set):
  1. Upload a one-page / short-text book (or paste a paragraph).
  2. Pick Standard or Michelle (no Fish key required).
  3. Make audiobook (Whole book / take-home).
  4. Library should leave queued. On the VM:
       pm2 logs echomancer-takehome
     Look for accept / settled. GET /health inflight should rise then return to 0.

Do not disable Trigger drain until that first job finishes on this VM.
EOF

if [[ "$fail" -ne 0 ]]; then
  red "Smoke failed."
  exit 1
fi
green "Smoke passed."
