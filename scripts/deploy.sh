#!/usr/bin/env bash
# Run on the server, from inside the SavoraBackend repo: ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pulling latest code"
git pull origin main

# Read one value from .env without sourcing it (values may contain spaces or shell characters).
env_value() {
  grep -E "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" || true
}

# Fail BEFORE building or migrating if the server would not start: a missing key makes the
# app exit on boot, and PM2 would then restart it in a loop.
echo "==> Checking required Events settings in .env"
for key in CHAT_ENCRYPTION_KEY INVITE_CODE_KEY; do
  if ! env_value "$key" | grep -Eq '^[a-f0-9]{64}$'; then
    echo "ERROR: $key is missing or is not 64 hex characters in .env."
    echo "       Generate one with: openssl rand -hex 32   (use a different value for each key)"
    exit 1
  fi
done

# Uploaded receipts, payment screenshots and chat images live here: private, outside the repo.
UPLOAD_DIR="$(env_value UPLOAD_DIR)"
UPLOAD_DIR="${UPLOAD_DIR:-/var/lib/spenxo/uploads}"
echo "==> Ensuring upload directory $UPLOAD_DIR (mode 700)"
mkdir -p "$UPLOAD_DIR"
chmod 700 "$UPLOAD_DIR"

FIREBASE_PATH="$(env_value FIREBASE_SERVICE_ACCOUNT_PATH)"
if [ -z "$FIREBASE_PATH" ]; then
  echo "NOTE: FIREBASE_SERVICE_ACCOUNT_PATH is not set - push notifications are disabled."
elif [ ! -r "$FIREBASE_PATH" ]; then
  echo "ERROR: FIREBASE_SERVICE_ACCOUNT_PATH points to $FIREBASE_PATH, which is not readable."
  exit 1
fi

echo "==> Installing dependencies (incl. devDependencies, needed for build/migrate)"
npm ci

echo "==> Building"
npm run build

echo "==> Running migrations"
npm run migrate

echo "==> Pruning devDependencies"
npm prune --omit=dev

echo "==> Starting/reloading PM2"
if pm2 describe spenxo-api > /dev/null 2>&1; then
  pm2 reload ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
  pm2 save
fi

echo "==> Deploy complete"
