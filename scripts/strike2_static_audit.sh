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

echo "[1/9] No TODO/FIXME in production strike2 paths"
if rg -n "TODO|FIXME" "${TARGETS[@]}" -g '!**/tests.rs' -g '!**/*_test.rs'; then
  echo "[FAIL] Found TODO/FIXME in production code"
  FAIL=1
else
  echo "[OK] No TODO/FIXME found"
fi

echo "[2/9] No unwrap()/expect()/panic! in production strike2 paths"
if rg -n "unwrap\\(|expect\\(|panic!\\(" "${TARGETS[@]}" -g '!**/tests.rs' -g '!**/*_test.rs'; then
  echo "[FAIL] Found unwrap/expect/panic in production code"
  FAIL=1
else
  echo "[OK] No unwrap/expect/panic found"
fi

echo "[3/9] No runtime assert! in production strike2 paths"
ASSERT_MATCHES="$(rg -n "\\bassert!\\(" "${TARGETS[@]}" -g '!**/tests.rs' -g '!**/*_test.rs' || true)"
if [[ -n "${ASSERT_MATCHES}" ]]; then
  # Allow compile-time const assertions used for ABI/layout guarantees.
  NON_CONST_ASSERTS="$(printf '%s\n' "${ASSERT_MATCHES}" | rg -v ":\\s*const\\s+_\\s*:\\s*\\(\\)\\s*=\\s*assert!\\(" || true)"
  if [[ -n "${NON_CONST_ASSERTS}" ]]; then
    printf '%s\n' "${NON_CONST_ASSERTS}"
    echo "[FAIL] Found runtime assert! in production code"
    FAIL=1
  else
    echo "[OK] Only compile-time const assert! found"
  fi
else
  echo "[OK] No assert! found"
fi

echo "[4/9] No dbg!/todo! macros in production strike2 paths"
if rg -n "\\bdbg!\\(|\\btodo!\\(" "${TARGETS[@]}" -g '!**/tests.rs' -g '!**/*_test.rs'; then
  echo "[FAIL] Found dbg!/todo! in production code"
  FAIL=1
else
  echo "[OK] No dbg!/todo! found"
fi

echo "[5/9] No transient debug I/O (eprintln, /tmp crash logs) in production strike2 paths"
if rg -n "eprintln!\\(|dream-daw-diag|/tmp/" "${TARGETS[@]}" -g '!**/tests.rs' -g '!**/*_test.rs'; then
  echo "[FAIL] Found transient debug I/O markers in production code"
  FAIL=1
else
  echo "[OK] No transient debug I/O markers found"
fi

echo "[6/9] No unsafe-op allowance escapes in production strike2 paths"
if rg -n "allow\\(unsafe_op_in_unsafe_fn\\)" "${TARGETS[@]}" -g '!**/tests.rs' -g '!**/*_test.rs'; then
  echo "[FAIL] Found allow(unsafe_op_in_unsafe_fn) in production code"
  FAIL=1
else
  echo "[OK] No allow(unsafe_op_in_unsafe_fn) found"
fi

echo "[7/9] Rust file size budget (<= 1000 LOC) in strike2 paths"
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

echo "[8/9] Unsafe SAFETY-doc ratchet (no regressions)"
UNSAFE_BASELINE_FILE="${UNSAFE_BASELINE_FILE:-scripts/strike2_unsafe_baseline.txt}"
python3 - "$UNSAFE_BASELINE_FILE" <<'PY'
from pathlib import Path
import re
import sys

baseline_file = Path(sys.argv[1])
if not baseline_file.exists():
    print(f"[FAIL] Missing baseline file: {baseline_file}")
    sys.exit(1)
baseline = int(baseline_file.read_text(encoding="utf-8").strip())

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
    print(f"[INFO] Undocumented unsafe blocks: {len(bad)} (baseline: {baseline})")
    print("[INFO] Top locations:")
    for f, ln in bad:
        print(f"  - {f}:{ln}")
    if len(bad) > baseline:
        print("[FAIL] Unsafe documentation debt regressed above baseline")
        sys.exit(1)
    print("[OK] Unsafe documentation debt did not regress")
else:
    print("[OK] Unsafe blocks have SAFETY context")
PY

echo "[9/9] Build-only smoke for strike2 crates"
cargo check -p dream_plugins -p dream_engine -p dream_graph --locked

if (( FAIL != 0 )); then
  echo "❌ Strike 2 static audit FAILED"
  exit 1
fi

echo "✅ Strike 2 static audit passed"
