#!/usr/bin/env bash
#
# bootstrap.sh — set up the pi config on a fresh machine after cloning ~/.pi
#
# Usage:
#   git clone <repo-url> ~/.pi
#   cd ~/.pi && ./bootstrap.sh
#
# What it does:
#   1. Verifies `pi` and `npm` are installed.
#   2. Runs `npm install` in every tracked package (root + extension subpackages).
#      Uses `git ls-files` so runtime-only dirs (node_modules/, agent/npm/) are skipped.
#   3. Prints the remaining manual steps (API key login, model selection).
#
# Secrets (agent/auth.json, agent/trust.json) are intentionally NOT handled here —
# they are per-machine. Use `/login` inside pi, or set $NAN_BUILDERS_API_KEY.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Checking prerequisites..."
missing=0
if ! command -v pi >/dev/null 2>&1; then
  echo "  ERROR: 'pi' not found. Install it first:"
  echo "    npm install -g @earendil-works/pi-coding-agent"
  missing=1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "  ERROR: 'npm' not found. Install Node.js first."
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  exit 1
fi
echo "  pi:   $(command -v pi)"
echo "  npm:  $(command -v npm)"
echo

echo "==> Installing dependencies for tracked packages..."
fail=0
while IFS= read -r pkg; do
  dir="$(dirname "$pkg")"
  echo "   npm install in $dir"
  if ! (cd "$dir" && npm install --no-audit --no-fund --silent); then
    echo "   WARNING: npm install failed in $dir"
    fail=1
  fi
done < <(git ls-files '*/package.json' 'package.json')

if [ "$fail" -ne 0 ]; then
  echo
  echo "ERROR: one or more npm installs failed. See warnings above."
  exit 1
fi

echo
echo "==> Setup complete."
echo
echo "Remaining manual steps:"
echo "  1. Start pi (run 'pi')."
echo "  2. Run /login -> 'Use an API key' -> select your provider (e.g. 'NaN Builders')"
echo "     and paste your API key. Alternatively export NAN_BUILDERS_API_KEY."
echo "  3. Use /model to confirm your model is selected."
echo "  4. (Optional) Re-trust any local repos via the trust prompt when first used."
