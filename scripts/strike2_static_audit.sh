#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== Strike 2 Static Audit =="

TARGETS=(
  "core/dream_plugins/src/vst3"
  "core/dream_plugins/src/vst3_host.rs"
  "core/dream_engine/src/driver"
  "core/dream_engine/src/driver.rs"
)

FAIL=0

echo "[1/5] No TODO/FIXME in production strike2 paths"
if rg -n "TODO|FIXME" "${TARGETS[@]}" -g '!**/tests.rs' -g '!**/*_test.rs'; then
  echo "[FAIL] Found TODO/FIXME in production code"
  FAIL=1
else
  echo "[OK] No TODO/FIXME found"
fi

echo "[2/5] No unwrap()/expect()/panic! in production strike2 paths"
if rg -n "unwrap\\(|expect\\(|panic!\\(" "${TARGETS[@]}" -g '!**/tests.rs' -g '!**/*_test.rs'; then
  echo "[FAIL] Found unwrap/expect/panic in production code"
  FAIL=1
else
  echo "[OK] No unwrap/expect/panic found"
fi

echo "[3/5] No dbg!/todo! macros in production strike2 paths"
if rg -n "\\bdbg!\\(|\\btodo!\\(" "${TARGETS[@]}" -g '!**/tests.rs' -g '!**/*_test.rs'; then
  echo "[FAIL] Found dbg!/todo! in production code"
  FAIL=1
else
  echo "[OK] No dbg!/todo! found"
fi

echo "[4/5] Rust file size budget (<= 1000 LOC) in strike2 paths"
while read -r lines file; do
  [[ -z "${lines:-}" || -z "${file:-}" ]] && continue
  if (( lines > 1000 )); then
    echo "[FAIL] Oversized file: $file ($lines LOC)"
    FAIL=1
  fi
done < <(
  find core/dream_plugins/src/vst3 core/dream_engine/src/driver -type f -name '*.rs' -print0 \
    | xargs -0 wc -l \
    | awk '$2 != "total" { print $1, $2 }'
)
if (( FAIL == 0 )); then
  echo "[OK] LOC budget respected"
fi

echo "[5/5] Build-only smoke for strike2 crates"
cargo check -p dream_plugins -p dream_engine -p dream_graph --locked

if (( FAIL != 0 )); then
  echo "❌ Strike 2 static audit FAILED"
  exit 1
fi

echo "✅ Strike 2 static audit passed"
