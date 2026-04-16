#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

scripts/setup.sh bootstrap --non-interactive --write-env-if-missing

python3 -c '
from pathlib import Path
path = Path(".env")
updates = {
    "TELEGRAM_BOT_TOKEN": "123456:install-smoke-token",
    "MINI_APP_URL": "https://example.com/app",
    "HERMES_API_URL": "https://example.com/hermes",
    "PORT": "8080",
}
lines = path.read_text(encoding="utf-8").splitlines()
rendered = []
remaining = dict(updates)
for line in lines:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        rendered.append(line)
        continue
    key, _value = line.split("=", 1)
    key = key.strip()
    if key in remaining:
        rendered.append(f"{key}={remaining.pop(key)}")
    else:
        rendered.append(line)
if remaining:
    if rendered and rendered[-1] != "":
        rendered.append("")
    for key, value in remaining.items():
        rendered.append(f"{key}={value}")
path.write_text("\n".join(rendered) + "\n", encoding="utf-8")
'

scripts/setup.sh doctor --json

export PORT=8080
.venv/bin/python server.py >/tmp/hermes-miniapp-install-smoke-server.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

health_ready=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/health >/tmp/hermes-miniapp-install-smoke-health.json; then
    health_ready=1
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ "$health_ready" != "1" ]]; then
  echo "Install smoke server failed to become healthy." >&2
  echo "--- server log ---" >&2
  cat /tmp/hermes-miniapp-install-smoke-server.log >&2 || true
  exit 1
fi

python3 -c '
import json
from pathlib import Path
payload = json.loads(Path("/tmp/hermes-miniapp-install-smoke-health.json").read_text(encoding="utf-8"))
if payload.get("status") != "ok":
    raise SystemExit(f"unexpected health payload: {payload!r}")
print("install smoke health payload:", json.dumps(payload, sort_keys=True))
'

echo "Install smoke passed."
