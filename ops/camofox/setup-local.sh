#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_PATH="$ROOT_DIR/.env"

if [[ ! -f "$ENV_PATH" ]]; then
  api_key="$(openssl rand -hex 32)"
  admin_key="$(openssl rand -hex 32)"
  cat >"$ENV_PATH" <<EOF
CAMOFOX_API_KEY=$api_key
CAMOFOX_ADMIN_KEY=$admin_key
CAMOFOX_COOKIES_DIR=$ROOT_DIR/cookies
EOF
  echo "Wrote $ENV_PATH"
else
  echo "$ENV_PATH already exists; leaving as-is"
fi

mkdir -p "$ROOT_DIR/cookies"

echo "Starting camofox-browser on http://127.0.0.1:9377 ..."
docker compose --env-file "$ENV_PATH" -f "$ROOT_DIR/docker-compose.yml" up -d --build

echo "Health check:"
curl -fsS http://127.0.0.1:9377/health || true

echo
cat <<'MSG'
Done.

Useful commands:
  docker compose --env-file ops/camofox/.env -f ops/camofox/docker-compose.yml logs -f
  docker compose --env-file ops/camofox/.env -f ops/camofox/docker-compose.yml down

Decision rule:
  Use normal browser path first; fallback to camofox only after verified anti-bot/fingerprint block.
MSG
