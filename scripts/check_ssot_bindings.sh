#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

LEGACY_MODEL_BINDINGS="$ROOT_DIR/core/dream_models/bindings"
LEGACY_UI_TYPES="$ROOT_DIR/frontend/ui_app/src/shared/types"
SSOT_BINDINGS="$ROOT_DIR/frontend/shared_bindings"

if [ -d "$LEGACY_MODEL_BINDINGS" ]; then
  echo "[ssot] FAIL: legacy bindings dir must not exist: $LEGACY_MODEL_BINDINGS" >&2
  exit 1
fi

if [ -d "$LEGACY_UI_TYPES" ]; then
  echo "[ssot] FAIL: legacy ui types dir must not exist: $LEGACY_UI_TYPES" >&2
  exit 1
fi

if [ ! -d "$SSOT_BINDINGS" ]; then
  echo "[ssot] FAIL: SSOT bindings dir missing: $SSOT_BINDINGS" >&2
  exit 1
fi

TS_COUNT="$(find "$SSOT_BINDINGS" -maxdepth 1 -type f -name '*.ts' | wc -l | tr -d ' ')"
if [ "$TS_COUNT" -eq 0 ]; then
  echo "[ssot] FAIL: SSOT bindings dir has no generated .ts files: $SSOT_BINDINGS" >&2
  exit 1
fi

echo "[ssot] OK: single source of truth bindings are in $SSOT_BINDINGS ($TS_COUNT files)"
