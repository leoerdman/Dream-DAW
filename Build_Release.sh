#!/bin/bash
# Dream DAW — Production Release Build
# Creates optimized .app bundle in target/release/bundle/
set -e
cd "$(dirname "$0")"
cargo tauri build
