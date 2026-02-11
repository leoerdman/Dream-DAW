#!/bin/bash
# ============================================================================
# Dream DAW — Build & Install Script
# ============================================================================
# Creates a proper macOS .app bundle with icon, Info.plist, and code signing.
# The app is installed to ~/Applications/Dream DAW.app so it can be pinned
# to the Dock. Subsequent runs rebuild and update the same bundle in-place.
#
# Usage:
#   ./build.sh          — Build, install, and launch
#   ./build.sh build    — Build only (no launch)
#   ./build.sh run      — Build, install, and launch
#   ./build.sh clean    — Clean build artifacts
# ============================================================================

set -euo pipefail

# === Configuration ===
APP_NAME="Dream DAW"
BUNDLE_ID="com.dreamdaw.app"
EXECUTABLE_NAME="DreamDAW"
VERSION="1.0.0"
BUILD_NUMBER="1"
MIN_MACOS="13.0"

# Paths
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/.build"
RESOURCES_DIR="${SCRIPT_DIR}/Resources"
INSTALL_DIR="${HOME}/Applications"
APP_BUNDLE="${INSTALL_DIR}/${APP_NAME}.app"
CONTENTS_DIR="${APP_BUNDLE}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_BUNDLE_DIR="${CONTENTS_DIR}/Resources"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# === Functions ===

print_step() {
    echo -e "${CYAN}▸${NC} $1"
}

print_success() {
    echo -e "${GREEN}✔${NC} $1"
}

print_error() {
    echo -e "${RED}✘${NC} $1"
}

print_header() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  ${APP_NAME} — Build System${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# Build the Swift package
build_swift() {
    print_step "Building Swift package (release)..."
    cd "${SCRIPT_DIR}"
    swift build -c release 2>&1 | while IFS= read -r line; do
        # Show only important lines
        if [[ "$line" == *"error:"* ]]; then
            echo -e "  ${RED}${line}${NC}"
        elif [[ "$line" == *"warning:"* ]]; then
            echo -e "  ${YELLOW}${line}${NC}"
        elif [[ "$line" == *"Build complete"* ]]; then
            echo -e "  ${GREEN}${line}${NC}"
        fi
    done
    
    # Verify binary exists
    local binary="${BUILD_DIR}/release/${EXECUTABLE_NAME}"
    if [ ! -f "${binary}" ]; then
        print_error "Build failed — binary not found at ${binary}"
        exit 1
    fi
    print_success "Build succeeded"
}

# Create the .icns file from AppIcon.png
create_icon() {
    local icon_png="${RESOURCES_DIR}/AppIcon.png"
    local iconset_dir="${BUILD_DIR}/AppIcon.iconset"
    local icns_file="${BUILD_DIR}/AppIcon.icns"

    if [ ! -f "${icon_png}" ]; then
        print_step "No AppIcon.png found, skipping icon generation"
        return
    fi

    print_step "Generating .icns from AppIcon.png..."
    
    rm -rf "${iconset_dir}"
    mkdir -p "${iconset_dir}"

    # Generate all required sizes for macOS
    sips -z 16 16     "${icon_png}" --out "${iconset_dir}/icon_16x16.png"      > /dev/null 2>&1
    sips -z 32 32     "${icon_png}" --out "${iconset_dir}/icon_16x16@2x.png"   > /dev/null 2>&1
    sips -z 32 32     "${icon_png}" --out "${iconset_dir}/icon_32x32.png"      > /dev/null 2>&1
    sips -z 64 64     "${icon_png}" --out "${iconset_dir}/icon_32x32@2x.png"   > /dev/null 2>&1
    sips -z 128 128   "${icon_png}" --out "${iconset_dir}/icon_128x128.png"    > /dev/null 2>&1
    sips -z 256 256   "${icon_png}" --out "${iconset_dir}/icon_128x128@2x.png" > /dev/null 2>&1
    sips -z 256 256   "${icon_png}" --out "${iconset_dir}/icon_256x256.png"    > /dev/null 2>&1
    sips -z 512 512   "${icon_png}" --out "${iconset_dir}/icon_256x256@2x.png" > /dev/null 2>&1
    sips -z 512 512   "${icon_png}" --out "${iconset_dir}/icon_512x512.png"    > /dev/null 2>&1
    sips -z 1024 1024 "${icon_png}" --out "${iconset_dir}/icon_512x512@2x.png" > /dev/null 2>&1

    iconutil -c icns "${iconset_dir}" -o "${icns_file}" 2>/dev/null
    
    if [ -f "${icns_file}" ]; then
        print_success "Icon generated: AppIcon.icns"
    else
        print_error "Icon generation failed"
    fi
}

# Create the .app bundle structure
create_bundle() {
    print_step "Creating application bundle..."

    # Kill any running instance gracefully
    pkill -f "${APP_BUNDLE}/Contents/MacOS/${EXECUTABLE_NAME}" 2>/dev/null || true
    sleep 0.5

    # Create/update directory structure
    mkdir -p "${MACOS_DIR}"
    mkdir -p "${RESOURCES_BUNDLE_DIR}"
    mkdir -p "${INSTALL_DIR}"

    # Copy executable
    cp "${BUILD_DIR}/release/${EXECUTABLE_NAME}" "${MACOS_DIR}/${EXECUTABLE_NAME}"
    chmod +x "${MACOS_DIR}/${EXECUTABLE_NAME}"

    # Copy icon if exists
    if [ -f "${BUILD_DIR}/AppIcon.icns" ]; then
        cp "${BUILD_DIR}/AppIcon.icns" "${RESOURCES_BUNDLE_DIR}/AppIcon.icns"
    fi

    # Create Info.plist
    cat > "${CONTENTS_DIR}/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleExecutable</key>
    <string>${EXECUTABLE_NAME}</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${BUILD_NUMBER}</string>
    <key>LSMinimumSystemVersion</key>
    <string>${MIN_MACOS}</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>Dream DAW needs microphone access for audio recording.</string>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>ddpj</string>
            </array>
            <key>CFBundleTypeName</key>
            <string>Dream DAW Project</string>
            <key>CFBundleTypeRole</key>
            <string>Editor</string>
            <key>LSHandlerRank</key>
            <string>Owner</string>
        </dict>
    </array>
</dict>
</plist>
PLIST

    # Create PkgInfo
    echo -n "APPL????" > "${CONTENTS_DIR}/PkgInfo"

    print_success "Application bundle created: ${APP_BUNDLE}"
}

# Code sign the app (ad-hoc for local development)
sign_app() {
    print_step "Code signing (ad-hoc)..."
    codesign --force --deep --sign - "${APP_BUNDLE}" 2>/dev/null
    print_success "Code signed"
}

# Touch the app to refresh Dock/Finder icon cache
refresh_icon() {
    print_step "Refreshing icon cache..."
    touch "${APP_BUNDLE}"
    # Kill Dock only if needed (icon changed)
    /usr/bin/killall Dock 2>/dev/null || true
    print_success "Icon cache refreshed"
}

# Launch the app
launch_app() {
    print_step "Launching ${APP_NAME}..."
    open "${APP_BUNDLE}"
    print_success "${APP_NAME} is running!"
    echo ""
    echo -e "  ${CYAN}App location:${NC} ${APP_BUNDLE}"
    echo -e "  ${CYAN}Pin to Dock:${NC} Right-click on Dock icon → Options → Keep in Dock"
    echo ""
}

# Clean build artifacts
clean() {
    print_step "Cleaning build artifacts..."
    cd "${SCRIPT_DIR}"
    swift package clean 2>/dev/null || true
    rm -rf "${BUILD_DIR}/AppIcon.iconset"
    rm -f "${BUILD_DIR}/AppIcon.icns"
    print_success "Clean complete"
}

# === Main ===

print_header

case "${1:-run}" in
    build)
        build_swift
        create_icon
        create_bundle
        sign_app
        refresh_icon
        echo ""
        print_success "Build complete! App at: ${APP_BUNDLE}"
        ;;
    run)
        build_swift
        create_icon
        create_bundle
        sign_app
        refresh_icon
        launch_app
        ;;
    clean)
        clean
        ;;
    *)
        echo "Usage: $0 [build|run|clean]"
        exit 1
        ;;
esac
