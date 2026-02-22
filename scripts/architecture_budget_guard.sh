#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUST_LIMIT=${RUST_LIMIT:-1000}
TS_LIMIT=${TS_LIMIT:-300}
BASELINE_FILE=${BASELINE_FILE:-scripts/architecture_budget_baseline.txt}

err() { printf "[ARCH BUDGET GUARD] %s\n" "$*" >&2; }

if [[ ! -f "$BASELINE_FILE" ]]; then
  err "missing baseline file: $BASELINE_FILE"
  exit 1
fi

if ! awk '
  /^[[:space:]]*#/ { next }
  /^[[:space:]]*$/ { next }
  $1 != "rust" && $1 != "ts" { exit 1 }
  NF != 3 { exit 1 }
' "$BASELINE_FILE"; then
  err "invalid baseline format in $BASELINE_FILE (expected: kind path max_lines)"
  exit 2
fi

baseline_max_for() {
  local kind="$1"
  local path="$2"
  awk -v k="$kind" -v p="$path" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    $1 == k && $2 == p { print $3; found=1; exit 0 }
    END { if (!found) exit 1 }
  ' "$BASELINE_FILE"
}

failures=0

while read -r lines path; do
  [[ -z "${lines:-}" || -z "${path:-}" ]] && continue
  if (( lines > RUST_LIMIT )); then
    if baseline_max="$(baseline_max_for rust "$path" 2>/dev/null)"; then
      if (( lines > baseline_max )); then
        err "rust oversized regression: $path now=$lines baseline=$baseline_max"
        failures=1
      fi
    else
      err "new rust oversized file (>${RUST_LIMIT}): $path ($lines)"
      failures=1
    fi
  fi
done < <(find apps core -type f -name '*.rs' -print0 | xargs -0 wc -l | awk '$2!="total" {print $1, $2}')

while read -r lines path; do
  [[ -z "${lines:-}" || -z "${path:-}" ]] && continue
  if (( lines > TS_LIMIT )); then
    if baseline_max="$(baseline_max_for ts "$path" 2>/dev/null)"; then
      if (( lines > baseline_max )); then
        err "ts/tsx oversized regression: $path now=$lines baseline=$baseline_max"
        failures=1
      fi
    else
      err "new ts/tsx oversized file (>${TS_LIMIT}): $path ($lines)"
      failures=1
    fi
  fi
done < <(find frontend/ui_app/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 wc -l | awk '$2!="total" {print $1, $2}')

if (( failures != 0 )); then
  err "FAILED"
  exit 1
fi

printf "[ARCH BUDGET GUARD] OK\n"
