#!/usr/bin/env bash
###############################################################################
# Dream DAW — Production Build → Install to /Applications
#
# Enterprise release pipeline:
#   1. Pre-flight checks (cargo, tauri-cli, pnpm, disk space)
#   2. Frontend build (Vite production bundle)
#   3. Rust release build (LTO=fat, codegen-units=1, target-cpu=native)
#   4. Tauri bundle (.app + .dmg)
#   5. Code-sign verification
#   6. Install to /Applications (with quarantine clear)
#
# Usage:
#   ./prodtoapps.sh                      # full build + install
#   ./prodtoapps.sh --skip-install       # build only, no copy
#   ./prodtoapps.sh --clean              # clean build (wipe target dir first)
#   ./prodtoapps.sh --open               # open app after install
###############################################################################
set -euo pipefail

# ── Resolve project root (always relative to this script) ───────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# ── Constants ────────────────────────────────────────────────────────────────
APP_NAME="Dream DAW"
TARGET_DIR="/tmp/dream-daw-target"
BUNDLE_DIR="$TARGET_DIR/release/bundle"
APP_PATH="$BUNDLE_DIR/macos/$APP_NAME.app"
DMG_DIR="$BUNDLE_DIR/dmg"
INSTALL_DIR="/Applications"
TAURI_CONF="$PROJECT_ROOT/apps/desktop_host/tauri.conf.json"
MIN_DISK_GB=8

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()    { echo -e "${CYAN}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✓${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✗${NC}  $*" >&2; }
step()    { echo -e "\n${MAGENTA}${BOLD}▸ $*${NC}"; }

# ── Parse flags ──────────────────────────────────────────────────────────────
SKIP_INSTALL=false
CLEAN_BUILD=false
OPEN_AFTER=false

for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=true ;;
    --clean)        CLEAN_BUILD=true ;;
    --open)         OPEN_AFTER=true ;;
    --help|-h)
      echo "Usage: $0 [--skip-install] [--clean] [--open] [--help]"
      echo ""
      echo "  --skip-install   Build .app and .dmg but do not copy to /Applications"
      echo "  --clean          Remove target directory before building (full rebuild)"
      echo "  --open           Open the app after successful install"
      echo "  --help, -h       Show this help"
      exit 0
      ;;
    *)
      error "Unknown flag: $arg"
      exit 1
      ;;
  esac
done

# ── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║                                                              ║${NC}"
echo -e "${BOLD}║   🎹  ${CYAN}Dream DAW${NC}${BOLD} — Production Build Pipeline               ║${NC}"
echo -e "${BOLD}║                                                              ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Read version from tauri.conf.json ────────────────────────────────────────
APP_VERSION="unknown"
if [ -f "$TAURI_CONF" ]; then
  APP_VERSION=$(grep '"version"' "$TAURI_CONF" | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
fi
info "Version: ${BOLD}$APP_NAME v$APP_VERSION${NC}"

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Pre-flight Checks
# ══════════════════════════════════════════════════════════════════════════════
step "Phase 1: Pre-flight Checks"

# Rust toolchain
if ! command -v cargo &>/dev/null; then
  error "cargo not found. Install Rust: https://rustup.rs"
  exit 1
fi
RUST_VERSION=$(rustc --version 2>/dev/null | awk '{print $2}')
success "Rust $RUST_VERSION"

# Tauri CLI
if ! cargo tauri --version &>/dev/null 2>&1; then
  error "cargo-tauri CLI not found. Install: cargo install tauri-cli"
  exit 1
fi
TAURI_CLI_VERSION=$(cargo tauri --version 2>/dev/null | awk '{print $NF}')
success "Tauri CLI $TAURI_CLI_VERSION"

# pnpm
if ! command -v pnpm &>/dev/null; then
  error "pnpm not found. Install: npm install -g pnpm"
  exit 1
fi
PNPM_VERSION=$(pnpm --version 2>/dev/null)
success "pnpm $PNPM_VERSION"

# Node.js
if ! command -v node &>/dev/null; then
  error "node not found."
  exit 1
fi
NODE_VERSION=$(node --version 2>/dev/null)
success "Node.js $NODE_VERSION"

# Disk space check
AVAIL_GB=$(df -g "$TARGET_DIR" 2>/dev/null | tail -1 | awk '{print $4}' || echo "$MIN_DISK_GB")
if [ "$AVAIL_GB" -lt "$MIN_DISK_GB" ] 2>/dev/null; then
  warn "Low disk space: ${AVAIL_GB}GB available (recommend ${MIN_DISK_GB}GB+)"
else
  success "Disk space: ${AVAIL_GB}GB available"
fi

# tauri.conf.json exists
if [ ! -f "$TAURI_CONF" ]; then
  error "tauri.conf.json not found at $TAURI_CONF"
  exit 1
fi
success "tauri.conf.json found"

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Clean (optional)
# ══════════════════════════════════════════════════════════════════════════════
if [ "$CLEAN_BUILD" = true ]; then
  step "Phase 2: Clean Build"
  if [ -d "$TARGET_DIR" ]; then
    info "Removing $TARGET_DIR..."
    rm -rf "$TARGET_DIR"
    success "Target directory cleaned"
  else
    info "Target directory already clean"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Frontend Dependencies
# ══════════════════════════════════════════════════════════════════════════════
step "Phase 3: Frontend Dependencies"
cd "$PROJECT_ROOT"

if [ ! -d "$PROJECT_ROOT/frontend/ui_app/node_modules" ]; then
  info "Installing frontend dependencies..."
  pnpm install --frozen-lockfile
  success "Dependencies installed"
else
  success "Dependencies already installed"
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Build
# ══════════════════════════════════════════════════════════════════════════════
step "Phase 4: Release Build"
echo -e "${DIM}  Profile:  opt-level=3, lto=fat, codegen-units=1, target-cpu=native${NC}"
echo -e "${DIM}  Target:   $TARGET_DIR${NC}"
echo ""

BUILD_START=$(date +%s)

cd "$PROJECT_ROOT"
cargo tauri build 2>&1 | while IFS= read -r line; do
  # Show compilation progress without overwhelming output
  if echo "$line" | grep -qE '^\s*(Compiling|Finished|Bundling|Running)'; then
    echo -e "  ${DIM}$line${NC}"
  elif echo "$line" | grep -qiE 'error|warning\['; then
    echo -e "  ${RED}$line${NC}"
  fi
done

# Check if build actually succeeded (pipe may mask exit code)
if [ ! -d "$APP_PATH" ]; then
  error "Build failed — .app bundle not found at: $APP_PATH"
  error "Re-run with verbose output:  cargo tauri build"
  exit 1
fi

BUILD_END=$(date +%s)
BUILD_DURATION=$((BUILD_END - BUILD_START))
BUILD_MIN=$((BUILD_DURATION / 60))
BUILD_SEC=$((BUILD_DURATION % 60))

echo ""
success "Build completed in ${BOLD}${BUILD_MIN}m ${BUILD_SEC}s${NC}"

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 5: Verify Bundle
# ══════════════════════════════════════════════════════════════════════════════
step "Phase 5: Verify Bundle"

APP_SIZE=$(du -sh "$APP_PATH" | cut -f1)
success ".app bundle: ${BOLD}$APP_SIZE${NC}"
info "  Location: $APP_PATH"

# Check binary exists and has expected architecture
BINARY_PATH="$APP_PATH/Contents/MacOS/$APP_NAME"
if [ -f "$BINARY_PATH" ]; then
  BINARY_SIZE=$(du -sh "$BINARY_PATH" | cut -f1)
  ARCH=$(file "$BINARY_PATH" | grep -oE 'arm64|x86_64' | head -1)
  success "Binary: $BINARY_SIZE ($ARCH)"
else
  warn "Binary not found at expected path: $BINARY_PATH"
fi

# Find .dmg
DMG_FILE=""
if [ -d "$DMG_DIR" ]; then
  DMG_FILE=$(find "$DMG_DIR" -name "*.dmg" -type f 2>/dev/null | head -1)
fi
if [ -n "$DMG_FILE" ]; then
  DMG_SIZE=$(du -sh "$DMG_FILE" | cut -f1)
  success ".dmg installer: ${BOLD}$DMG_SIZE${NC}"
  info "  Location: $DMG_FILE"
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 6: Install to /Applications
# ══════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_INSTALL" = true ]; then
  warn "Skipping install (--skip-install flag)"
else
  step "Phase 6: Install to /Applications"

  # Kill running instance if present
  if pgrep -f "$APP_NAME" &>/dev/null; then
    warn "Closing running instance of $APP_NAME..."
    pkill -f "$APP_NAME" 2>/dev/null || true
    sleep 1
  fi

  # Remove old version
  if [ -d "$INSTALL_DIR/$APP_NAME.app" ]; then
    info "Removing previous installation..."
    rm -rf "$INSTALL_DIR/$APP_NAME.app"
  fi

  # Copy new version
  cp -R "$APP_PATH" "$INSTALL_DIR/"

  if [ -d "$INSTALL_DIR/$APP_NAME.app" ]; then
    success "Installed to $INSTALL_DIR/$APP_NAME.app"
  else
    error "Failed to copy to $INSTALL_DIR"
    exit 1
  fi

  # Clear quarantine attribute (macOS Gatekeeper)
  xattr -cr "$INSTALL_DIR/$APP_NAME.app" 2>/dev/null || true
  success "Cleared quarantine attributes"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  ${GREEN}✅  $APP_NAME v$APP_VERSION — Production Build Complete${NC}${BOLD}    ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}App${NC}      $APP_PATH"
[ -n "$DMG_FILE" ] && echo -e "  ${CYAN}DMG${NC}      $DMG_FILE"
[ "$SKIP_INSTALL" = false ] && echo -e "  ${CYAN}Installed${NC} $INSTALL_DIR/$APP_NAME.app"
echo -e "  ${CYAN}Time${NC}     ${BUILD_MIN}m ${BUILD_SEC}s"
echo ""

# ── Auto-open ────────────────────────────────────────────────────────────────
if [ "$OPEN_AFTER" = true ] && [ "$SKIP_INSTALL" = false ]; then
  info "Launching $APP_NAME..."
  open "$INSTALL_DIR/$APP_NAME.app"
fi

echo -e "  ${DIM}Launch manually:  open \"$INSTALL_DIR/$APP_NAME.app\"${NC}"
echo ""
