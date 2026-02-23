#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/dream_daw_target_gate}"
export TS_RS_EXPORT_DIR="$ROOT_DIR/frontend/shared_bindings"

echo "== Dream DAW Quality Gate =="
echo "Using CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "Using TS_RS_EXPORT_DIR=$TS_RS_EXPORT_DIR"

echo "[1/12] Sync TS bindings"
bash scripts/sync_bindings.sh

echo "[2/12] Rust check (workspace)"
cargo check --workspace

echo "[3/13] Rust clippy (critical crates, policy lints)"
cargo clippy -p dream_plugins -p dream_engine -p desktop_host --lib --bins -- \
  -D clippy::unwrap_used \
  -D clippy::expect_used \
  -D clippy::todo \
  -D clippy::dbg_macro

echo "[4/14] Rust clippy (dream_plugins all-targets strict)"
cargo clippy -p dream_plugins --all-targets -- -D warnings \
  -D clippy::unwrap_used \
  -D clippy::expect_used \
  -D clippy::todo \
  -D clippy::dbg_macro

echo "[5/14] Rust clippy (dream_graph all-targets strict)"
cargo clippy -p dream_graph --all-targets -- -D warnings \
  -D clippy::unwrap_used \
  -D clippy::expect_used \
  -D clippy::todo \
  -D clippy::dbg_macro

echo "[6/14] Rust tests (library crates)"
cargo test --workspace --lib

echo "[7/14] Architecture budget ratchet guard"
bash scripts/architecture_budget_guard.sh

echo "[8/14] Full project audit report"
bash scripts/full_project_audit.sh --report /tmp/dream_full_audit.txt
cat /tmp/dream_full_audit.txt

echo "[9/14] SSOT bindings guard"
bash scripts/check_ssot_bindings.sh

echo "[10/14] SSOT import alias guard"
bash scripts/ssot_guard.sh

echo "[11/14] Delta IPC guard"
bash scripts/delta_ipc_guard.sh

echo "[11b/14] Delta contract guard"
bash scripts/delta_contract_guard.sh

echo "[12/14] Frontend type-check (no emit)"
pnpm -C frontend/ui_app exec tsc --noEmit

echo "[13/14] Zustand selector guard"
bash scripts/zustand_selector_guard.sh

echo "[14/14] Frontend build"
pnpm -C frontend/ui_app build

echo "[info] Frontend lint report (non-blocking while lint debt is burned down)"
pnpm -C frontend/ui_app exec eslint . || true

echo "[15/15] Optional headless fuzz gate"
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
