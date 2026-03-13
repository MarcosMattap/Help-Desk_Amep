#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE_PATH="${ARCHIVE_PATH:-$ROOT_DIR/helpdesk-release.tar.gz}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_HOST="${REMOTE_HOST:-72.61.50.158}"
REMOTE_TMP="${REMOTE_TMP:-/tmp/helpdesk-release.tar.gz}"
APP_DIR="${APP_DIR:-/var/www/helpdesk}"
PM2_APP_NAME="${PM2_APP_NAME:-helpdesk}"

for command_name in tar scp ssh; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Dependencia ausente na maquina local: $command_name" >&2
    exit 1
  fi
done

rm -f "$ARCHIVE_PATH"

tar \
  --exclude='./node_modules' \
  --exclude='./helpdesk.db' \
  --exclude='./helpdesk.tar.gz' \
  --exclude='./helpdesk-release.tar.gz' \
  -czf "$ARCHIVE_PATH" \
  -C "$ROOT_DIR" \
  package.json package-lock.json README.md public src views scripts

scp "$ARCHIVE_PATH" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_TMP"

ssh "$REMOTE_USER@$REMOTE_HOST" "set -euo pipefail; TMP_DIR=\$(mktemp -d); trap 'rm -rf \"\$TMP_DIR\"' EXIT; tar -xzf '$REMOTE_TMP' -C \"\$TMP_DIR\"; chmod +x \"\$TMP_DIR/scripts/apply-release.sh\"; APP_DIR='$APP_DIR' PM2_APP_NAME='$PM2_APP_NAME' \"\$TMP_DIR/scripts/apply-release.sh\" '$REMOTE_TMP'; rm -f '$REMOTE_TMP'"

echo "Deploy concluido para $REMOTE_USER@$REMOTE_HOST em $APP_DIR."