#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SSOT_DIR="$ROOT_DIR/frontend/shared_bindings"
LEGACY_MODEL_BINDINGS="$ROOT_DIR/core/dream_models/bindings"
LEGACY_UI_TYPES="$ROOT_DIR/frontend/ui_app/src/shared/types"

# Enforce SSOT before generation: legacy folders must not survive.
rm -rf "$LEGACY_MODEL_BINDINGS" "$LEGACY_UI_TYPES"

mkdir -p "$SSOT_DIR"
# Remove stale generated files before a fresh export.
find "$SSOT_DIR" -maxdepth 1 -type f -name '*.ts' -delete 2>/dev/null || true

# Always regenerate Rust -> TS bindings into frontend/shared_bindings (SSOT).
cargo test -p dream_models export_typescript_bindings -- --nocapture >/dev/null

if [ ! -d "$SSOT_DIR" ]; then
  echo "[sync_bindings] SSOT bindings directory not found: $SSOT_DIR" >&2
  exit 1
fi

TS_COUNT="$(find "$SSOT_DIR" -maxdepth 1 -type f -name '*.ts' | wc -l | tr -d ' ')"
if [ "$TS_COUNT" -eq 0 ]; then
  echo "[sync_bindings] WARNING: No .ts files found in $SSOT_DIR after export" >&2
  exit 1
fi

echo "[sync_bindings] Exported $TS_COUNT files to SSOT dir:"
echo "  - $SSOT_DIR"
