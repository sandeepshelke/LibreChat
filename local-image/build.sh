#!/usr/bin/env bash
# Builds our LibreChat image from this checkout's last commit. The commit is
# exported to a temporary folder first, so local node_modules, logs and
# uncommitted edits never reach the image; the tag and BUILD_COMMIT name it.
set -euo pipefail
cd "$(dirname "$0")/.."

git diff --quiet HEAD -- || { echo "commit your changes first" >&2; exit 1; }
commit=$(git rev-parse --short=8 HEAD)
src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
git archive HEAD | tar -x -C "$src"
echo "ed1711641675c810b702fde90718eba8db6d85fb6843c715000759da9b012264  $src/local-image/agents.tgz" | sha256sum -c -
docker build -f "$src/Dockerfile.local" \
  --build-arg BUILD_COMMIT="$commit" \
  --build-arg BUILD_BRANCH="$(git rev-parse --abbrev-ref HEAD)" \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t "librechat-local:diagnostics-tool-rounds-$commit" "$src"
