#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

engine_api_file="frontend/ui_app/src/shared/api/engine.ts"
commands_mod_file="apps/desktop_host/src/commands/mod.rs"

if [[ ! -f "$engine_api_file" ]]; then
  echo "[DELTA CONTRACT GUARD] FAIL: missing $engine_api_file" >&2
  exit 1
fi

if [[ ! -f "$commands_mod_file" ]]; then
  echo "[DELTA CONTRACT GUARD] FAIL: missing $commands_mod_file" >&2
  exit 1
fi

frontend_delta_cmds=()
while IFS= read -r cmd; do
  [[ -n "$cmd" ]] && frontend_delta_cmds+=("$cmd")
done < <(
  rg -o -N "'[a-z0-9_]*with_deltas[a-z0-9_]*'" "$engine_api_file" \
    | tr -d "'" \
    | sort -u
)

if [[ ${#frontend_delta_cmds[@]} -eq 0 ]]; then
  echo "[DELTA CONTRACT GUARD] FAIL: no delta commands found in frontend engine API" >&2
  exit 1
fi

missing=()
for cmd in "${frontend_delta_cmds[@]}"; do
  if ! rg -q "\\b${cmd}\\b" "$commands_mod_file"; then
    missing+=("$cmd")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "[DELTA CONTRACT GUARD] FAIL: frontend delta commands missing in desktop_host command registry:" >&2
  printf ' - %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "[DELTA CONTRACT GUARD] OK (${#frontend_delta_cmds[@]} delta commands mapped)"
