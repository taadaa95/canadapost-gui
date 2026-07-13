#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
rm -rf node_modules
npm ci
npm run install-browsers
npm test

echo "Canada Post Claim Runner v0.3.2 is installed and validated."
