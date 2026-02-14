#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Dream DAW — Production Build & Launch Script
# ═══════════════════════════════════════════════════════════════════════════
#
# Usage:  ./prod.sh [--run] [--dmg]
#
# Builds the Tauri v2 app in production mode with:
#   ✓ Release optimizations (opt-level=3, fat LTO, codegen-units=1)
#   ✓ Logging suppressed (RUST_LOG=warn — only warnings and errors)
#   ✓ No backtrace (cleaner UX for end users)
#   ✓ Symbols stripped
#   ✓ panic=abort (minimal binary size)
#
# Options:
#   --run    Build AND launch the production binary immediately
#   --dmg    Generate the macOS .dmg installer bundle
#
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_DIR="$SCRIPT_DIR/apps/desktop_host"

# ── Color output ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${MAGENTA}${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   🎹  Dream DAW — PRODUCTION  🎹    ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── Parse args ────────────────────────────────────────────────────────────
RUN_AFTER=false
BUILD_DMG=false
for arg in "$@"; do
    case "$arg" in
        --run) RUN_AFTER=true ;;
        --dmg) BUILD_DMG=true ;;
        *) echo -e "${RED}Unknown option: $arg${NC}"; exit 1 ;;
    esac
done

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

# ── Install dependencies if needed ───────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/frontend/ui_app/node_modules" ]; then
    echo -e "${YELLOW}▸ Installing frontend dependencies...${NC}"
    cd "$SCRIPT_DIR" && pnpm install
fi

# ── Environment ───────────────────────────────────────────────────────────
export RUST_LOG="warn"
unset RUST_BACKTRACE 2>/dev/null || true

echo ""
echo -e "${CYAN}▸ Environment:${NC}"
echo -e "  RUST_LOG=${GREEN}warn${NC} (errors and warnings only)"
echo -e "  RUST_BACKTRACE=${GREEN}disabled${NC}"
echo -e "  Mode: ${MAGENTA}Production${NC} (release build, LTO, stripped)"
echo ""

# ── Build ─────────────────────────────────────────────────────────────────
echo -e "${GREEN}${BOLD}▸ Building production binary...${NC}"
echo -e "${YELLOW}  This may take several minutes (fat LTO enabled).${NC}"
echo ""

BUILD_START=$(date +%s)

cd "$TAURI_DIR"

if $BUILD_DMG; then
    echo -e "${CYAN}▸ Building with .dmg bundle...${NC}"
    npx @tauri-apps/cli build --bundles dmg 2>&1
else
    npx @tauri-apps/cli build 2>&1
fi

BUILD_END=$(date +%s)
BUILD_DURATION=$((BUILD_END - BUILD_START))

echo ""
echo -e "${GREEN}${BOLD}✓ Production build complete in ${BUILD_DURATION}s${NC}"

# ── Locate the binary ────────────────────────────────────────────────────
RELEASE_BIN="$SCRIPT_DIR/target/release/desktop_host"
BUNDLE_DIR="$SCRIPT_DIR/target/release/bundle"

if [ -f "$RELEASE_BIN" ]; then
    BIN_SIZE=$(du -sh "$RELEASE_BIN" | cut -f1)
    echo -e "  Binary: ${CYAN}$RELEASE_BIN${NC}"
    echo -e "  Size:   ${CYAN}$BIN_SIZE${NC}"
fi

if [ -d "$BUNDLE_DIR" ]; then
    echo -e "  Bundle: ${CYAN}$BUNDLE_DIR${NC}"
    if $BUILD_DMG; then
        DMG_FILE=$(find "$BUNDLE_DIR" -name "*.dmg" 2>/dev/null | head -1)
        if [ -n "$DMG_FILE" ]; then
            DMG_SIZE=$(du -sh "$DMG_FILE" | cut -f1)
            echo -e "  DMG:    ${GREEN}$DMG_FILE${NC} ($DMG_SIZE)"
        fi
    fi
fi

# ── Run if requested ─────────────────────────────────────────────────────
if $RUN_AFTER; then
    echo ""
    echo -e "${GREEN}${BOLD}▸ Launching production build...${NC}"
    
    # Check for .app bundle first (preferred on macOS)
    APP_BUNDLE=$(find "$BUNDLE_DIR" -name "*.app" -maxdepth 3 2>/dev/null | head -1)
    if [ -n "$APP_BUNDLE" ]; then
        echo -e "  Opening: ${CYAN}$APP_BUNDLE${NC}"
        open "$APP_BUNDLE"
    elif [ -f "$RELEASE_BIN" ]; then
        echo -e "  Running: ${CYAN}$RELEASE_BIN${NC}"
        RUST_LOG=warn "$RELEASE_BIN"
    else
        echo -e "${RED}✗ No binary found. Build may have failed.${NC}"
        exit 1
    fi
fi

echo ""
echo -e "${GREEN}${BOLD}Done.${NC}"
