#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/dream_daw_target_strike2}"
STRESS_ITERS="${STRESS_ITERS:-25}"

echo "== Strike 2 Verification =="
echo "ROOT_DIR=$ROOT_DIR"
echo "CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "STRESS_ITERS=$STRESS_ITERS"

echo "[1/8] Compile check (release, strike2 crates)"
cargo check -p dream_plugins -p dream_engine -p dream_graph --release --locked

echo "[2/8] Clippy strict (dream_plugins)"
cargo clippy -p dream_plugins --all-targets -- -D warnings \
  -D clippy::unwrap_used \
  -D clippy::expect_used \
  -D clippy::todo \
  -D clippy::dbg_macro

echo "[3/8] Clippy strict (dream_graph)"
cargo clippy -p dream_graph --all-targets -- -D warnings \
  -D clippy::unwrap_used \
  -D clippy::expect_used \
  -D clippy::todo \
  -D clippy::dbg_macro

echo "[4/8] Clippy strict (dream_engine)"
cargo clippy -p dream_engine --all-targets -- -D warnings \
  -D clippy::todo \
  -D clippy::dbg_macro

echo "[5/8] Release tests (dream_plugins)"
cargo test -p dream_plugins --release --locked

echo "[6/8] Release tests (dream_engine)"
cargo test -p dream_engine --release --locked

echo "[7/8] Release tests (dream_graph)"
cargo test -p dream_graph --release --locked

echo "[8/9] Stress loops (${STRESS_ITERS}x each)"
for i in $(seq 1 "$STRESS_ITERS"); do
  cargo test -p dream_plugins --release --locked \
    sandbox_host::tests::crashed_then_ready_toggles_shared_crash_flag_and_emits_both_events \
    -- --exact >/tmp/strike2_plugins_"$i".log
done
for i in $(seq 1 "$STRESS_ITERS"); do
  cargo test -p dream_engine --release --locked \
    offline_bounce::tests::grouped_plus_direct_path_hits_master_fx_and_is_deterministic \
    -- --exact >/tmp/strike2_engine_"$i".log
done
for i in $(seq 1 "$STRESS_ITERS"); do
  cargo test -p dream_graph --release --locked \
    pdc::tests::randomized_dag_compensation_property_holds \
    -- --exact >/tmp/strike2_graph_"$i".log
done

echo "[9/9] Static molecular audit"
bash scripts/strike2_static_audit.sh

echo "✅ Strike 2 verification passed (iters=$STRESS_ITERS)"
