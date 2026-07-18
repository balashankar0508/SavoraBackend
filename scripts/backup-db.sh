#!/usr/bin/env bash
# Daily Postgres backup -> Google Drive, keeping the last 7 days both
# locally and on Drive. Meant to run via cron on the server.
#
# One-time setup before this works, see README's "Database backups" section:
#   1. Create a Google Cloud service account with Drive API access.
#   2. Share a Drive folder with that service account's email (Editor).
#   3. Configure an rclone remote named "gdrive" pointed at that folder.
set -euo pipefail

DB_NAME=savora
BACKUP_DIR=/root/db-backups
RCLONE_REMOTE=gdrive:

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/${DB_NAME}-$(date +%Y-%m-%d).sql.gz"

echo "==> Dumping $DB_NAME to $FILE"
sudo -u postgres pg_dump "$DB_NAME" | gzip > "$FILE"

echo "==> Uploading to $RCLONE_REMOTE"
rclone copy "$FILE" "$RCLONE_REMOTE"

echo "==> Rotating local backups older than 7 days"
find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime +7 -delete

echo "==> Rotating remote backups older than 7 days"
rclone delete "$RCLONE_REMOTE" --min-age 7d --include "${DB_NAME}-*.sql.gz"

echo "==> Backup complete: $FILE"
