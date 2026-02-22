#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

err() { printf "[ZUSTAND GUARD] %s\n" "$*" >&2; }

TARGET_GLOBS=(-g'*.ts' -g'*.tsx')

# 1) Forbid broad subscriptions that attach component updates to the full store.
if rg -n "useEngineStore\\s*\\(\\s*\\)" frontend/ui_app/src "${TARGET_GLOBS[@]}" >/dev/null; then
  err "Found forbidden broad subscription: useEngineStore() without a selector."
  rg -n "useEngineStore\\s*\\(\\s*\\)" frontend/ui_app/src "${TARGET_GLOBS[@]}" >&2 || true
  exit 1
fi

# 2) Require shallow wrapping for object-literal selectors to avoid referential churn.
if rg -n "useEngineStore\\s*\\(\\s*\\(\\s*[A-Za-z_][A-Za-z0-9_]*\\s*\\)\\s*=>\\s*\\(\\s*\\{" frontend/ui_app/src "${TARGET_GLOBS[@]}" >/dev/null; then
  err "Found object-literal selector without useShallow wrapper."
  rg -n "useEngineStore\\s*\\(\\s*\\(\\s*[A-Za-z_][A-Za-z0-9_]*\\s*\\)\\s*=>\\s*\\(\\s*\\{" frontend/ui_app/src "${TARGET_GLOBS[@]}" >&2 || true
  exit 1
fi

printf "[ZUSTAND GUARD] OK\n"
