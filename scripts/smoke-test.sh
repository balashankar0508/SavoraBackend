#!/usr/bin/env bash
# Basic end-to-end smoke test against a running Savora backend.
# Usage: API=http://localhost:4000 ./scripts/smoke-test.sh
set -euo pipefail

API="${API:-http://localhost:4000}"
EMAIL="smoketest+$(date +%s)@example.com"
PASSWORD="correcthorse123"

echo "== health =="
curl -sf "$API/health" | tee /dev/stderr
echo

echo "== register =="
curl -sf -X POST "$API/auth/register" -H 'content-type: application/json' \
  -d "{\"name\":\"Smoke Test\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | tee /dev/stderr
echo
echo "NOTE: check the mailbox / server logs for the OTP code, then re-run with:"
echo "  CODE=123456 EMAIL=$EMAIL API=$API ./scripts/smoke-test-verify.sh"
