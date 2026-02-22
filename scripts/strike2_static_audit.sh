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

echo "[5/6] Every unsafe block must be documented with SAFETY context"
python3 - <<'PY'
from pathlib import Path
import re
import sys

targets = [
    Path("core/dream_plugins/src/vst3"),
    Path("core/dream_plugins/src/vst3_host.rs"),
    Path("core/dream_engine/src/driver"),
    Path("core/dream_engine/src/driver.rs"),
]

def iter_rs_files():
    for t in targets:
        if t.is_file() and t.suffix == ".rs":
            yield t
            continue
        if t.is_dir():
            for p in t.rglob("*.rs"):
                yield p

bad = []
for file in iter_rs_files():
    if file.name.endswith("tests.rs") or file.name.endswith("_test.rs"):
        continue
    lines = file.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        if re.search(r"\bunsafe\s*\{", line):
            start = max(0, i - 3)
            context = "\n".join(lines[start:i+1])
            if "SAFETY:" not in context:
                bad.append((str(file), i + 1))

if bad:
    print("[FAIL] Undocumented unsafe blocks detected:")
    for f, ln in bad:
        print(f"  - {f}:{ln}")
    sys.exit(1)

print("[OK] Unsafe blocks have SAFETY context")
PY

echo "[6/6] Build-only smoke for strike2 crates"
cargo check -p dream_plugins -p dream_engine -p dream_graph --locked

if (( FAIL != 0 )); then
  echo "❌ Strike 2 static audit FAILED"
  exit 1
fi

echo "✅ Strike 2 static audit passed"
