#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[AUDIO CHAIN GUARD] Running offline routing/master coverage test"
cargo test -p dream_engine master_fx_processes_both_group_and_direct_paths -- --nocapture

echo "[AUDIO CHAIN GUARD] Running integration null-test for grouped+direct master path"
cargo test -p dream_engine grouped_plus_direct_path_hits_master_fx_and_is_deterministic -- --nocapture

echo "[AUDIO CHAIN GUARD] OK"
