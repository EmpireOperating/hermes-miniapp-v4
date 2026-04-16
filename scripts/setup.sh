#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

resolve_python() {
  if command -v python >/dev/null 2>&1; then
    echo python
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    echo python3
    return 0
  fi
  echo "ERROR: Python 3.11+ is required, but neither 'python' nor 'python3' was found on PATH." >&2
  return 1
}

PYTHON_BIN="$(resolve_python)"

if [[ $# -eq 0 ]]; then
  exec "$PYTHON_BIN" scripts/setup_bootstrap.py --write-env-if-missing
fi

case "$1" in
  bootstrap)
    shift
    exec "$PYTHON_BIN" scripts/setup_bootstrap.py "$@"
    ;;
  doctor)
    shift
    exec "$PYTHON_BIN" scripts/setup_doctor.py "$@"
    ;;
  telegram)
    shift
    exec "$PYTHON_BIN" scripts/setup_telegram.py "$@"
    ;;
  help|-h|--help)
    cat <<'EOF'
Hermes Mini App setup wrapper

Usage:
  scripts/setup.sh                Run bootstrap (interactive on a TTY) with --write-env-if-missing
  scripts/setup.sh bootstrap ...  Run scripts/setup_bootstrap.py
  scripts/setup.sh doctor ...     Run scripts/setup_doctor.py
  scripts/setup.sh telegram ...   Run scripts/setup_telegram.py
  scripts/setup.sh help           Show this help
EOF
    ;;
  *)
    echo "ERROR: unknown command '$1'" >&2
    echo "Run 'scripts/setup.sh help' for usage." >&2
    exit 2
    ;;
esac
