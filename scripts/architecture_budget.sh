#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUST_LIMIT=${RUST_LIMIT:-1000}
TS_LIMIT=${TS_LIMIT:-300}
STRICT=""
report_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict)
      STRICT="--strict"
      shift
      ;;
    --report)
      if [[ $# -lt 2 ]]; then
        echo "error: --report requires a file path" >&2
        exit 2
      fi
      report_file="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      echo "usage: $0 [--strict] [--report <file>]" >&2
      exit 2
      ;;
  esac
done

emit() {
  if [[ -n "$report_file" ]]; then
    printf "%s\n" "$*" >> "$report_file"
  else
    printf "%s\n" "$*"
  fi
}

if [[ -n "$report_file" ]]; then
  : > "$report_file"
fi

emit "[ARCH BUDGET] rust_limit=$RUST_LIMIT ts_limit=$TS_LIMIT"

rust_over=$(find apps core -type f -name '*.rs' -print0 | xargs -0 wc -l | awk -v lim="$RUST_LIMIT" '$1+0>lim && $2!="total" {print $0}' | sort -nr || true)
ts_over=$(find frontend/ui_app/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 wc -l | awk -v lim="$TS_LIMIT" '$1+0>lim && $2!="total" {print $0}' | sort -nr || true)

emit ""
emit "[ARCH BUDGET] Rust files over limit"
if [[ -n "$rust_over" ]]; then
  emit "$rust_over"
else
  emit "OK"
fi

emit ""
emit "[ARCH BUDGET] TS/TSX files over limit"
if [[ -n "$ts_over" ]]; then
  emit "$ts_over"
else
  emit "OK"
fi

if [[ "$STRICT" == "--strict" ]]; then
  if [[ -n "$rust_over" || -n "$ts_over" ]]; then
    emit ""
    emit "[ARCH BUDGET] FAILED"
    exit 1
  fi
fi

emit ""
emit "[ARCH BUDGET] DONE"
