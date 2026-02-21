#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/core/dream_models/bindings"
DST_DIR="$ROOT_DIR/frontend/ui_app/src/shared/types"
LEGACY_DST_DIR="$ROOT_DIR/frontend/shared_bindings"

# Always regenerate Rust -> TS bindings before syncing to frontend.
cargo test -p dream_models export_typescript_bindings -- --nocapture >/dev/null

if [ ! -d "$SRC_DIR" ]; then
  echo "[sync_bindings] Source bindings directory not found: $SRC_DIR" >&2
  exit 1
fi

mkdir -p "$DST_DIR"
mkdir -p "$LEGACY_DST_DIR"
# Remove stale generated files first, then copy fresh generated types.
# Use || true for cleanup — files may already be absent from a previous run
# or race condition with concurrent invocations.
find "$DST_DIR" -maxdepth 1 -type f -name '*.ts' -delete 2>/dev/null || true
find "$LEGACY_DST_DIR" -maxdepth 1 -type f -name '*.ts' -delete 2>/dev/null || true

# Verify source directory has generated bindings before copying.
if compgen -G "$SRC_DIR"/*.ts > /dev/null; then
    cp "$SRC_DIR"/*.ts "$DST_DIR"/
    cp "$SRC_DIR"/*.ts "$LEGACY_DST_DIR"/
else
    echo "[sync_bindings] WARNING: No .ts files found in $SRC_DIR — skipping copy" >&2
fi

COUNT="$(find "$DST_DIR" -maxdepth 1 -type f -name '*.ts' | wc -l | tr -d ' ')"
echo "[sync_bindings] Copied $COUNT files to:"
echo "  - $DST_DIR"
echo "  - $LEGACY_DST_DIR"
