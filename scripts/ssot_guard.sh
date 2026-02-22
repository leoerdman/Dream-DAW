#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

err() { printf "[SSOT GUARD] %s\n" "$*" >&2; }

if [[ -d core/dream_models/bindings ]]; then
  err "Duplicate bindings dir exists: core/dream_models/bindings"
  exit 1
fi

if [[ -d frontend/ui_app/src/shared/types ]]; then
  err "Duplicate frontend types dir exists: frontend/ui_app/src/shared/types"
  exit 1
fi

if [[ ! -d frontend/shared_bindings ]]; then
  err "Missing canonical bindings dir: frontend/shared_bindings"
  exit 1
fi

if ! rg -n '"@bindings/\*"' frontend/ui_app/tsconfig.app.json >/dev/null; then
  err "tsconfig alias @bindings/* is missing in frontend/ui_app/tsconfig.app.json"
  exit 1
fi

if rg -n "from ['\"](\.\./)*shared/types|from ['\"][^'\"]*shared/types" frontend/ui_app/src -g'*.ts' -g'*.tsx' >/dev/null; then
  err "Found imports from deprecated shared/types path"
  exit 1
fi

printf "[SSOT GUARD] OK\n"
