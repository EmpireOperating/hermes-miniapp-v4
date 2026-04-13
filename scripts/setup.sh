#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -eq 0 ]]; then
  exec python scripts/setup_bootstrap.py --write-env-if-missing
fi

case "$1" in
  bootstrap)
    shift
    exec python scripts/setup_bootstrap.py "$@"
    ;;
  doctor)
    shift
    exec python scripts/setup_doctor.py "$@"
    ;;
  help|-h|--help)
    cat <<'EOF'
Hermes Mini App setup wrapper

Usage:
  scripts/setup.sh                Run bootstrap with --write-env-if-missing
  scripts/setup.sh bootstrap ...  Run scripts/setup_bootstrap.py
  scripts/setup.sh doctor ...     Run scripts/setup_doctor.py
  scripts/setup.sh help           Show this help
EOF
    ;;
  *)
    echo "ERROR: unknown command '$1'" >&2
    echo "Run 'scripts/setup.sh help' for usage." >&2
    exit 2
    ;;
esac
