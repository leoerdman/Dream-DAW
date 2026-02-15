#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "== Dream DAW Quality Gate =="

echo "[1/8] Sync TS bindings"
bash scripts/sync_bindings.sh

echo "[2/8] Rust check (workspace)"
cargo check --workspace

echo "[3/8] Rust clippy (critical crates, deny warnings)"
cargo clippy -p dream_plugins -p dream_engine -p desktop_host --all-targets -- \
  -D warnings \
  -A dead_code \
  -A unused_imports \
  -A clippy::style \
  -A clippy::complexity

echo "[4/8] Rust tests (library crates)"
cargo test --workspace --lib

echo "[5/8] Frontend lint"
pnpm -C frontend/ui_app exec eslint . --max-warnings=0

echo "[6/8] Frontend build"
pnpm -C frontend/ui_app build

echo "[7/8] Optional headless fuzz gate"
if [[ "${DREAM_ENABLE_HEADLESS_FUZZ:-0}" == "1" ]]; then
  bash scripts/headless_fuzz_gate.sh
else
  echo "Skipping (set DREAM_ENABLE_HEADLESS_FUZZ=1 to enable)"
fi

echo "[8/8] Optional sanitizer gate"
if [[ "${DREAM_ENABLE_SANITIZERS:-0}" == "1" ]]; then
  bash scripts/sanitizer_gate.sh
else
  echo "Skipping (set DREAM_ENABLE_SANITIZERS=1 to enable)"
fi

echo "✅ Quality gate passed"
