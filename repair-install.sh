#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:-$HOME/Documents/canadapost-gui}"
cd "$PROJECT_DIR"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
if [[ "$VERSION" != "0.2.0" ]]; then
  echo "ERROR: package.json reports version '$VERSION', not 0.2.0." >&2
  echo "Extract the fixed patch ZIP directly into: $PROJECT_DIR" >&2
  exit 1
fi

rm -rf node_modules
npm ci
npm test

echo
echo "Repair complete. Start with:"
echo "  cd '$PROJECT_DIR' && npm start"
echo "For X11 fallback on Hyprland:"
echo "  cd '$PROJECT_DIR' && npm start -- --ozone-platform=x11 --disable-gpu"
