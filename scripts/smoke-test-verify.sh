#!/usr/bin/env bash
# Continues the smoke test after you've retrieved the OTP code for EMAIL.
# Usage: CODE=123456 EMAIL=smoketest+...@example.com API=http://localhost:4000 ./scripts/smoke-test-verify.sh
set -euo pipefail

API="${API:-http://localhost:4000}"
EMAIL="${EMAIL:?Set EMAIL to the address used in smoke-test.sh}"
CODE="${CODE:?Set CODE to the OTP received by that address}"
PASSWORD="${PASSWORD:-correcthorse123}"

echo "== verify-email =="
VERIFY_RES=$(curl -sf -X POST "$API/auth/verify-email" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}")
echo "$VERIFY_RES"
TOKEN=$(echo "$VERIFY_RES" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
REFRESH=$(echo "$VERIFY_RES" | grep -o '"refreshToken":"[^"]*"' | cut -d'"' -f4)

echo "== /auth/me =="
curl -sf "$API/auth/me" -H "authorization: Bearer $TOKEN"; echo

echo "== create transaction =="
TXN_RES=$(curl -sf -X POST "$API/transactions" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"expense","amount":100,"category":"Food","transaction_date":"2026-07-04","source":"manual"}')
echo "$TXN_RES"

echo "== list transactions =="
curl -sf "$API/transactions" -H "authorization: Bearer $TOKEN"; echo

echo "== monthly summary =="
curl -sf "$API/transactions/summary?months=6" -H "authorization: Bearer $TOKEN"; echo

echo "== create goal =="
GOAL_RES=$(curl -sf -X POST "$API/goals" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Trip","target_amount":50000,"target_date":"2026-12-01"}')
echo "$GOAL_RES"
GOAL_ID=$(echo "$GOAL_RES" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

echo "== contribute to goal =="
curl -sf -X POST "$API/goals/$GOAL_ID/contribute" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"amount":1000}'; echo

echo "== refresh rotation + reuse detection =="
REFRESH_RES=$(curl -sf -X POST "$API/auth/refresh" -H 'content-type: application/json' -d "{\"refreshToken\":\"$REFRESH\"}")
echo "$REFRESH_RES"
echo "-- replaying the OLD refresh token should now fail (401 refresh_token_reused) --"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/auth/refresh" -H 'content-type: application/json' -d "{\"refreshToken\":\"$REFRESH\"}"

echo "All smoke tests completed."
