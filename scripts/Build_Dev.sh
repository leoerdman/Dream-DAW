#!/bin/bash
# Dream DAW — Development Build & Run
# Launches Vite dev server + compiles Rust + opens the app window
set -e
cd "$(dirname "$0")/.."
cargo tauri dev
