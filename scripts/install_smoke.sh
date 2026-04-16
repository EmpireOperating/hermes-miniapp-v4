#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="hermes-miniapp-install-smoke:local"
DOCKERFILE="$ROOT_DIR/docker/install-smoke.Dockerfile"

usage() {
  cat <<EOF
Hermes Mini App install smoke harness

Build a clean Docker image and run the documented setup flow inside it.

Usage:
  scripts/install_smoke.sh [--image-tag TAG] [--dockerfile PATH]

Defaults:
  --image-tag  $IMAGE_TAG
  --dockerfile $DOCKERFILE
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image-tag)
      IMAGE_TAG="${2:?missing value for --image-tag}"
      shift 2
      ;;
    --dockerfile)
      DOCKERFILE="${2:?missing value for --dockerfile}"
      shift 2
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required to run the install smoke harness." >&2
  exit 1
fi

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "ERROR: Dockerfile not found at $DOCKERFILE" >&2
  exit 1
fi

docker build -f "$DOCKERFILE" -t "$IMAGE_TAG" "$ROOT_DIR"
docker run --rm "$IMAGE_TAG"
