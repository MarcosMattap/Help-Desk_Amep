#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_PATH="${1:-}"
APP_DIR="${APP_DIR:-/var/www/helpdesk}"
PM2_APP_NAME="${PM2_APP_NAME:-helpdesk}"

if [ -z "$ARCHIVE_PATH" ]; then
  echo "Uso: APP_DIR=/var/www/helpdesk ./scripts/apply-release.sh /tmp/helpdesk-release.tar.gz" >&2
  exit 1
fi

if [ ! -f "$ARCHIVE_PATH" ]; then
  echo "Arquivo de release nao encontrado: $ARCHIVE_PATH" >&2
  exit 1
fi

for command_name in tar npm pm2; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Dependencia ausente na VPS: $command_name" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

mkdir -p "$APP_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$TEMP_DIR"

for item in public src views scripts package.json package-lock.json README.md; do
  rm -rf "$APP_DIR/$item"
done

cp -R "$TEMP_DIR/public" "$APP_DIR/public"
cp -R "$TEMP_DIR/src" "$APP_DIR/src"
cp -R "$TEMP_DIR/views" "$APP_DIR/views"
cp -R "$TEMP_DIR/scripts" "$APP_DIR/scripts"
cp "$TEMP_DIR/package.json" "$APP_DIR/package.json"

if [ -f "$TEMP_DIR/package-lock.json" ]; then
  cp "$TEMP_DIR/package-lock.json" "$APP_DIR/package-lock.json"
fi

if [ -f "$TEMP_DIR/README.md" ]; then
  cp "$TEMP_DIR/README.md" "$APP_DIR/README.md"
fi

chmod +x "$APP_DIR/scripts/apply-release.sh"
chmod +x "$APP_DIR/scripts/deploy-vps.sh"

cd "$APP_DIR"
npm install --omit=dev

if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME" --update-env
else
  : "${SESSION_SECRET:?SESSION_SECRET precisa estar definido para o primeiro start via PM2.}"
  NODE_ENV="${NODE_ENV:-production}" PORT="${PORT:-3000}" pm2 start src/server.js --name "$PM2_APP_NAME" --update-env
  pm2 save
fi

echo "Release aplicado em $APP_DIR e processo $PM2_APP_NAME atualizado."