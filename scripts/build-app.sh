#!/usr/bin/env bash
# Builds VibeBasic.app (tauri build). The macOS signing identity is not in the repository: put it in a git-ignored
# .env.local next to package.json, for example
#
#   APPLE_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)"
#
# (`security find-identity -v -p codesigning` lists yours). The Tauri bundler reads APPLE_SIGNING_IDENTITY from the
# environment. Signing with the same identity every time keeps macOS permissions such as Local Network across builds.
# Without it the app is built unsigned. Extra arguments go to `tauri build`.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "Signing with: $APPLE_SIGNING_IDENTITY"
else
  echo "APPLE_SIGNING_IDENTITY is not set (see .env.local in README): building without a signing identity"
fi
exec npx tauri build "$@"
