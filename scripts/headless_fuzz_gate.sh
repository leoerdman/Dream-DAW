#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/dream_daw_target_hardening}"

echo "== Dream DAW Headless Fuzz Gate =="
echo "Using CARGO_TARGET_DIR=$CARGO_TARGET_DIR"

echo "[1/3] PDC randomized DAG property sweep (release)"
cargo test -p dream_graph randomized_dag_compensation_property_holds --release

echo "[2/3] DSP stress suite (release, all built-in effects)"
cargo test -p dream_dsp stress_tests --release

echo "[3/3] Graph renderer + delay-line stress regression"
cargo test -p dream_graph renderer::tests:: --release

echo "✅ Headless fuzz gate passed"
