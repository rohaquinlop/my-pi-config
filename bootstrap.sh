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
#   2. Seeds agent/settings.json from agent/settings.template.json if absent.
#      settings.json is gitignored (it accumulates per-machine provider/model
#      state), so a fresh clone has none — without this step pi starts with
#      empty defaults and no `packages`.
#   3. Runs `npm ci` in every tracked package (root + extension subpackages).
#      Uses `git ls-files` so runtime-only dirs (node_modules/, agent/npm/) are skipped.
#      Every tracked package has a committed lockfile; keep it in sync with the
#      manifest (npm install --package-lock-only) so ci fails loudly instead of
#      silently re-resolving versions.
#   4. Installs each pi package listed in the template via `pi install`. pi does
#      NOT auto-install packages named in settings.json — it only resolves them
#      from disk — so this is what actually puts the subagent runtime in place.
#   5. Prints the remaining manual steps (provider login, model selection).
#
# Secrets (agent/auth.json, agent/trust.json) are intentionally NOT handled here —
# they are per-machine. Use `/login` inside pi.
#
# No provider or model is pinned by this script: the template deliberately omits
# defaultProvider/defaultModel/enabledModels so the harness stays provider-neutral.
# Pick them with /login and /model on first run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SETTINGS="agent/settings.json"
TEMPLATE="agent/settings.template.json"

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
if ! command -v python3 >/dev/null 2>&1; then
  echo "  ERROR: 'python3' not found (used to read the settings template)."
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  exit 1
fi
echo "  pi:      $(command -v pi)"
echo "  npm:     $(command -v npm)"
echo "  python3: $(command -v python3)"
echo

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: $TEMPLATE is missing — cannot seed settings or install packages."
  exit 1
fi

echo "==> Seeding settings..."
if [ -f "$SETTINGS" ]; then
  echo "   $SETTINGS already exists — leaving it untouched."
else
  cp "$TEMPLATE" "$SETTINGS"
  echo "   created $SETTINGS from $TEMPLATE"
fi
echo

echo "==> Installing dependencies for tracked packages..."
fail=0
while IFS= read -r pkg; do
  dir="$(dirname "$pkg")"
  echo "   npm ci in $dir"
  if ! (cd "$dir" && npm ci --no-audit --no-fund --silent); then
    echo "   WARNING: npm ci failed in $dir"
    fail=1
  fi
done < <(git ls-files '*/package.json' 'package.json')

if [ "$fail" -ne 0 ]; then
  echo
  echo "ERROR: one or more npm ci runs failed. See warnings above."
  exit 1
fi
echo

echo "==> Installing pi packages..."
# `pi install` is idempotent: it re-installs and de-duplicates the settings entry.
pkg_fail=0
while IFS= read -r source; do
  [ -n "$source" ] || continue
  echo "   pi install $source"
  if ! pi install "$source"; then
    echo "   WARNING: pi install failed for $source"
    pkg_fail=1
  fi
done < <(python3 -c '
import json, sys
with open("'"$TEMPLATE"'") as fh:
    data = json.load(fh)
for entry in data.get("packages", []):
    print(entry if isinstance(entry, str) else entry.get("source", ""))
')

if [ "$pkg_fail" -ne 0 ]; then
  echo
  echo "ERROR: one or more pi packages failed to install."
  echo "The subagent runtime (pi-subagents) may be unavailable — subagent"
  echo "dispatch will fail until this is resolved."
  exit 1
fi

echo
echo "==> Setup complete."
echo
echo "Remaining manual steps:"
echo "  1. Start pi (run 'pi')."
echo "  2. Run /login -> 'Use an API key' -> select your provider and paste your key."
echo "  3. Run /model to pick a default model (the template pins none on purpose)."
echo "  4. (Optional) Re-trust any local repos via the trust prompt when first used."
