#!/bin/bash
# Dream DAW — Full Verification (Rust + TypeScript + Tests)
set -e
cd "$(dirname "$0")/.."

echo "═══ Rust Check ═══"
cargo check --workspace

echo ""
echo "═══ Rust Tests ═══"
cargo test --workspace

echo ""
echo "═══ TypeScript Check ═══"
cd frontend/ui_app
npx tsc --noEmit

echo ""
echo "✅ All checks passed"
