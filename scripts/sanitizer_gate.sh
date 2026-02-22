#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/dream_daw_target_sanitizers}"
MODE="${DREAM_SANITIZER_MODE:-full}"

echo "== Dream DAW Sanitizer Gate =="
echo "Using CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "Mode=$MODE"

if ! command -v rustup >/dev/null 2>&1; then
  echo "rustup is required for sanitizer runs"
  exit 1
fi

if ! rustup toolchain list | grep -q "^nightly"; then
  echo "nightly toolchain is not installed; install with: rustup toolchain install nightly"
  exit 1
fi

HOST_TRIPLE="$(rustc -vV | awk '/host:/ {print $2}')"

echo "[1/4] rust-src component (nightly)"
rustup +nightly component add rust-src

if [[ "$MODE" == "smoke" ]]; then
  echo "[2/2] ASan smoke — dream_graph"
  RUSTFLAGS="-Zsanitizer=address" \
    cargo +nightly test -Zbuild-std --target "$HOST_TRIPLE" -p dream_graph --lib
  echo "✅ Sanitizer smoke gate passed"
  exit 0
fi

echo "[2/4] ASan — dream_graph"
RUSTFLAGS="-Zsanitizer=address" \
  cargo +nightly test -Zbuild-std --target "$HOST_TRIPLE" -p dream_graph --lib

echo "[3/4] ASan — dream_dsp"
RUSTFLAGS="-Zsanitizer=address" \
  cargo +nightly test -Zbuild-std --target "$HOST_TRIPLE" -p dream_dsp --lib

echo "[4/4] TSan — dream_graph"
RUSTFLAGS="-Zsanitizer=thread" \
  cargo +nightly test -Zbuild-std --target "$HOST_TRIPLE" -p dream_graph --lib

echo "✅ Sanitizer gate passed"
