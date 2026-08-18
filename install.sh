#!/usr/bin/env bash
#
# One-click install for the `pingcode` CLI — Linux / macOS.
# Delegates to the cross-platform Node core (scripts/install.mjs).
#
#   chmod +x install.sh   (once)
#   ./install.sh
#
# Re-run after `git pull` to rebuild + relink the latest code.
set -euo pipefail

# Run from the repo root regardless of where the script is invoked from.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js >= 20 is required (not found on PATH)." >&2
  echo "  Install it from https://nodejs.org or your package manager, then re-run." >&2
  exit 1
fi

exec node scripts/install.mjs "$@"
