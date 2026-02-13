#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Dream DAW — Developer Launch Script
# ═══════════════════════════════════════════════════════════════════════════
#
# Usage:  ./dev.sh [--verbose]
#
# Runs the Tauri v2 app in development mode with:
#   ✓ Full debug logging (RUST_LOG=debug)
#   ✓ Backtrace on panic (RUST_BACKTRACE=1)
#   ✓ Hot-reload for both Rust and React/TS
#   ✓ Source maps enabled
#   ✓ Dev tools accessible (Cmd+Shift+I)
#
# Optional:
#   --verbose    Sets RUST_LOG=trace for maximum verbosity
#
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$SCRIPT_DIR/apps/desktop_host"

# ── Color output ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║     🎹  Dream DAW — DEV MODE  🎹    ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── Parse args ────────────────────────────────────────────────────────────
LOG_LEVEL="debug"
if [[ "${1:-}" == "--verbose" ]]; then
    LOG_LEVEL="trace"
    echo -e "${YELLOW}⚡ Verbose mode: RUST_LOG=trace${NC}"
fi

# ── Pre-flight checks ────────────────────────────────────────────────────
echo -e "${CYAN}▸ Pre-flight checks...${NC}"

check_dep() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}✗ $1 not found. Please install it first.${NC}"
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} $1 $(command $1 --version 2>/dev/null | head -1)"
}

check_dep "cargo"
check_dep "node"
check_dep "pnpm"

# ── Install dependencies if needed ────────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/frontend/ui_app/node_modules" ]; then
    echo -e "${YELLOW}▸ Installing frontend dependencies...${NC}"
    cd "$SCRIPT_DIR" && pnpm install
fi

# ── Environment ───────────────────────────────────────────────────────────
export RUST_LOG="$LOG_LEVEL"
export RUST_BACKTRACE=1

echo ""
echo -e "${CYAN}▸ Environment:${NC}"
echo -e "  RUST_LOG=${GREEN}${LOG_LEVEL}${NC}"
echo -e "  RUST_BACKTRACE=${GREEN}1${NC}"
echo -e "  Mode: ${YELLOW}Development${NC} (debug build + hot-reload)"
echo ""

# ── Launch ────────────────────────────────────────────────────────────────
echo -e "${GREEN}${BOLD}▸ Launching Dream DAW...${NC}"
echo -e "${CYAN}  Frontend: http://localhost:5173${NC}"
echo -e "${CYAN}  Press Ctrl+C to stop${NC}"
echo ""

cd "$TAURI_DIR"
npx @tauri-apps/cli dev 2>&1
