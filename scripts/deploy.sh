#!/usr/bin/env bash
# Run on the server, from inside the SavoraBackend repo: ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pulling latest code"
git pull origin main

echo "==> Installing dependencies (incl. devDependencies, needed for build/migrate)"
npm ci

echo "==> Building"
npm run build

echo "==> Running migrations"
npm run migrate

echo "==> Pruning devDependencies"
npm prune --omit=dev

echo "==> Starting/reloading PM2"
if pm2 describe savora-api > /dev/null 2>&1; then
  pm2 reload ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
  pm2 save
fi

echo "==> Deploy complete"
