#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/dream_daw_target_gate}"

echo "== Dream DAW Quality Gate =="
echo "Using CARGO_TARGET_DIR=$CARGO_TARGET_DIR"

echo "[1/12] Sync TS bindings"
bash scripts/sync_bindings.sh

echo "[2/12] Rust check (workspace)"
cargo check --workspace

echo "[3/12] Rust clippy (critical crates, policy lints)"
cargo clippy -p dream_plugins -p dream_engine -p desktop_host --lib --bins -- \
  -D clippy::unwrap_used \
  -D clippy::expect_used \
  -D clippy::todo \
  -D clippy::dbg_macro

echo "[4/12] Rust tests (library crates)"
cargo test --workspace --lib

echo "[5/12] Architecture budget ratchet guard"
bash scripts/architecture_budget_guard.sh

echo "[6/12] Full project audit report"
bash scripts/full_project_audit.sh --report /tmp/dream_full_audit.txt
cat /tmp/dream_full_audit.txt

echo "[7/12] SSOT bindings guard"
bash scripts/check_ssot_bindings.sh

echo "[8/12] SSOT import alias guard"
bash scripts/ssot_guard.sh

echo "[9/12] Frontend type-check (no emit)"
pnpm -C frontend/ui_app exec tsc --noEmit

echo "[10/12] Zustand selector guard"
bash scripts/zustand_selector_guard.sh

echo "[11/12] Frontend build"
pnpm -C frontend/ui_app build

echo "[info] Frontend lint report (non-blocking while lint debt is burned down)"
pnpm -C frontend/ui_app exec eslint . || true

echo "[12/12] Optional headless fuzz gate"
if [[ "${DREAM_ENABLE_HEADLESS_FUZZ:-0}" == "1" ]]; then
  bash scripts/headless_fuzz_gate.sh
else
  echo "Skipping (set DREAM_ENABLE_HEADLESS_FUZZ=1 to enable)"
fi

echo "[extra] Optional sanitizer gate"
if [[ "${DREAM_ENABLE_SANITIZERS:-0}" == "1" ]]; then
  bash scripts/sanitizer_gate.sh
else
  echo "Skipping (set DREAM_ENABLE_SANITIZERS=1 to enable)"
fi

echo "✅ Quality gate passed"
