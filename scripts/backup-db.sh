#!/usr/bin/env bash
# Daily backup -> Google Drive, keeping the last 7 days both locally and on Drive.
# Backs up two things: the Postgres database, and the uploads folder (event receipts,
# payment screenshots, chat images). Meant to run via cron on the server.
#
# One-time setup before this works, see README's "Database backups" section:
#   1. Create a Google Cloud service account with Drive API access.
#   2. Share a Drive folder with that service account's email (Editor).
#   3. Configure an rclone remote named "gdrive" pointed at that folder.
#
# NOT included, on purpose: .env. CHAT_ENCRYPTION_KEY and INVITE_CODE_KEY must be kept
# somewhere else (a password manager). A backup of the database next to its own keys
# would defeat the encryption; losing the keys makes old chat messages unreadable.
set -euo pipefail

DB_NAME=savora
BACKUP_DIR=/root/db-backups
RCLONE_REMOTE=gdrive:
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Same UPLOAD_DIR the app uses (cron has no environment, so read it from the repo's .env).
UPLOAD_DIR="$(grep -E '^UPLOAD_DIR=' "$REPO_DIR/.env" 2>/dev/null | head -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)"
UPLOAD_DIR="${UPLOAD_DIR:-/var/lib/spenxo/uploads}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date +%Y-%m-%d)"
FILE="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz"

echo "==> Dumping $DB_NAME to $FILE"
sudo -u postgres pg_dump "$DB_NAME" | gzip > "$FILE"

echo "==> Uploading to $RCLONE_REMOTE"
rclone copy "$FILE" "$RCLONE_REMOTE"

UPLOADS_FILE="$BACKUP_DIR/uploads-${STAMP}.tar.gz"
if [ -d "$UPLOAD_DIR" ]; then
  echo "==> Archiving $UPLOAD_DIR to $UPLOADS_FILE"
  # exit status 1 only means "a file changed while being read" (someone uploaded during the
  # backup); that is fine, anything else is a real failure
  tar -czf "$UPLOADS_FILE" -C "$(dirname "$UPLOAD_DIR")" "$(basename "$UPLOAD_DIR")" || [ $? -eq 1 ]
  chmod 600 "$UPLOADS_FILE"
  echo "==> Uploading uploads archive to $RCLONE_REMOTE"
  rclone copy "$UPLOADS_FILE" "$RCLONE_REMOTE"
else
  echo "==> No uploads directory at $UPLOAD_DIR yet, skipping"
fi

echo "==> Rotating local backups older than 7 days"
find "$BACKUP_DIR" \( -name "${DB_NAME}-*.sql.gz" -o -name "uploads-*.tar.gz" \) -mtime +7 -delete

echo "==> Rotating remote backups older than 7 days"
rclone delete "$RCLONE_REMOTE" --min-age 7d --include "${DB_NAME}-*.sql.gz"
rclone delete "$RCLONE_REMOTE" --min-age 7d --include "uploads-*.tar.gz"

echo "==> Backup complete: $FILE"
