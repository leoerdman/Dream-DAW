#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

engine_api_file="frontend/ui_app/src/shared/api/engine.ts"
commands_mod_file="apps/desktop_host/src/commands/mod.rs"
ts_delta_file="frontend/ui_app/src/shared/api/projectDelta.ts"
rust_delta_file="core/dream_models/src/delta.rs"

if [[ ! -f "$engine_api_file" ]]; then
  echo "[DELTA CONTRACT GUARD] FAIL: missing $engine_api_file" >&2
  exit 1
fi

if [[ ! -f "$commands_mod_file" ]]; then
  echo "[DELTA CONTRACT GUARD] FAIL: missing $commands_mod_file" >&2
  exit 1
fi

if [[ ! -f "$ts_delta_file" ]]; then
  echo "[DELTA CONTRACT GUARD] FAIL: missing $ts_delta_file" >&2
  exit 1
fi

if [[ ! -f "$rust_delta_file" ]]; then
  echo "[DELTA CONTRACT GUARD] FAIL: missing $rust_delta_file" >&2
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

python3 - <<'PY'
import re
import sys
from pathlib import Path

rust_delta_file = Path("core/dream_models/src/delta.rs")
ts_delta_file = Path("frontend/ui_app/src/shared/api/projectDelta.ts")

rust_text = rust_delta_file.read_text(encoding="utf-8")
ts_text = ts_delta_file.read_text(encoding="utf-8")

enum_match = re.search(r"pub enum ProjectDelta\s*\{([\s\S]*?)\n\}", rust_text)
if not enum_match:
    print("[DELTA CONTRACT GUARD] FAIL: could not find `pub enum ProjectDelta` in Rust", file=sys.stderr)
    sys.exit(1)

rust_variants = []
for line in enum_match.group(1).splitlines():
    line = line.strip()
    if not line or line.startswith("//") or line.startswith("///"):
        continue
    m = re.match(r"([A-Z][A-Za-z0-9_]*)\s*(\{|,)", line)
    if m:
        rust_variants.append(m.group(1))

ts_variants = re.findall(r"\{\s*kind:\s*'([A-Za-z0-9_]+)'", ts_text)

if not rust_variants:
    print("[DELTA CONTRACT GUARD] FAIL: no Rust ProjectDelta variants parsed", file=sys.stderr)
    sys.exit(1)
if not ts_variants:
    print("[DELTA CONTRACT GUARD] FAIL: no TS ProjectDelta variants parsed", file=sys.stderr)
    sys.exit(1)

rust_set = set(rust_variants)
ts_set = set(ts_variants)
missing_in_ts = sorted(rust_set - ts_set)
extra_in_ts = sorted(ts_set - rust_set)

if missing_in_ts or extra_in_ts:
    print("[DELTA CONTRACT GUARD] FAIL: ProjectDelta variant mismatch between Rust and TS", file=sys.stderr)
    if missing_in_ts:
        print("  Missing in TS:", file=sys.stderr)
        for name in missing_in_ts:
            print(f"   - {name}", file=sys.stderr)
    if extra_in_ts:
        print("  Extra in TS:", file=sys.stderr)
        for name in extra_in_ts:
            print(f"   - {name}", file=sys.stderr)
    sys.exit(1)

print(f"[DELTA CONTRACT GUARD] ProjectDelta variants in sync ({len(rust_set)} variants)")
PY

echo "[DELTA CONTRACT GUARD] OK (${#frontend_delta_cmds[@]} delta commands mapped)"
