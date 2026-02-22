#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/dream_daw_target_gate}"

echo "== Dream DAW Quality Gate =="
echo "Using CARGO_TARGET_DIR=$CARGO_TARGET_DIR"

echo "[1/8] Sync TS bindings"
bash scripts/sync_bindings.sh

echo "[2/8] Rust check (workspace)"
cargo check --workspace

echo "[3/8] Rust clippy (critical crates, policy lints)"
cargo clippy -p dream_plugins -p dream_engine -p desktop_host --lib --bins -- \
  -D clippy::unwrap_used \
  -D clippy::expect_used \
  -D clippy::todo \
  -D clippy::dbg_macro

echo "[4/8] Rust tests (library crates)"
cargo test --workspace --lib

echo "[5/9] Architecture budget ratchet guard"
bash scripts/architecture_budget_guard.sh

echo "[6/9] Frontend type-check (no emit)"
pnpm -C frontend/ui_app exec tsc --noEmit

echo "[7/9] Zustand selector guard"
bash scripts/zustand_selector_guard.sh

echo "[8/9] Frontend build"
pnpm -C frontend/ui_app build

echo "[info] Frontend lint report (non-blocking while lint debt is burned down)"
pnpm -C frontend/ui_app exec eslint . || true

echo "[9/10] Optional headless fuzz gate"
if [[ "${DREAM_ENABLE_HEADLESS_FUZZ:-0}" == "1" ]]; then
  bash scripts/headless_fuzz_gate.sh
else
  echo "Skipping (set DREAM_ENABLE_HEADLESS_FUZZ=1 to enable)"
fi

echo "[10/10] Optional sanitizer gate"
if [[ "${DREAM_ENABLE_SANITIZERS:-0}" == "1" ]]; then
  bash scripts/sanitizer_gate.sh
else
  echo "Skipping (set DREAM_ENABLE_SANITIZERS=1 to enable)"
fi

echo "✅ Quality gate passed"
