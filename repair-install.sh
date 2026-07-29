#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
rm -rf node_modules
npm ci
npm run install-browsers
npm test

echo "Canada Post Claim Runner v0.4.0-dev.1 is installed and validated."
