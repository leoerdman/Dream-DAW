#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "== Dream DAW Quality Gate =="

echo "[1/6] Sync TS bindings"
bash scripts/sync_bindings.sh

echo "[2/6] Rust check (workspace)"
cargo check --workspace

echo "[3/6] Rust clippy (critical crates, deny warnings)"
cargo clippy -p dream_plugins -p dream_engine -p desktop_host --all-targets -- -D warnings

echo "[4/6] Rust tests (library crates)"
cargo test --workspace --lib

echo "[5/6] Frontend lint"
pnpm -C frontend/ui_app exec eslint . --max-warnings=0

echo "[6/6] Frontend build"
pnpm -C frontend/ui_app build

echo "✅ Quality gate passed"
