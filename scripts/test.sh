#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VENV_PYTHON="$ROOT_DIR/.venv/bin/python"

if [[ ! -x "$VENV_PYTHON" ]]; then
  echo "ERROR: expected virtualenv interpreter at $VENV_PYTHON" >&2
  echo "Run scripts/setup.sh first." >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  exec "$VENV_PYTHON" -m pytest -q
fi

case "$1" in
  py|python|pytest)
    shift
    exec "$VENV_PYTHON" -m pytest "$@"
    ;;
  node|js)
    shift
    if [[ $# -eq 0 ]]; then
      exec node --test tests/*.mjs
    fi
    exec node --test "$@"
    ;;
  all)
    shift
    "$VENV_PYTHON" -m pytest -q "$@"
    exec node --test tests/*.mjs
    ;;
  help|-h|--help)
    cat <<'EOF'
Hermes Mini App test wrapper

Usage:
  scripts/test.sh              Run Python tests via repo .venv
  scripts/test.sh py ...       Run pytest via repo .venv with custom args
  scripts/test.sh node [files] Run Node tests (defaults to tests/*.mjs)
  scripts/test.sh all          Run Python tests, then Node tests

Examples:
  scripts/test.sh
  scripts/test.sh py tests/test_routes_meta.py -q
  scripts/test.sh node tests/keyboard_shortcuts_app_delegation.test.mjs
  scripts/test.sh all
EOF
    ;;
  *)
    echo "ERROR: unknown command '$1'" >&2
    echo "Run 'scripts/test.sh help' for usage." >&2
    exit 2
    ;;
esac
