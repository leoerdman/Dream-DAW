#!/bin/zsh

# ============================================================================
# Dream DAW — Development Build & Run Script
# ============================================================================
# This script builds the application and launches it directly in the terminal
# so that all print statements, logs, and errors are visible in real-time.
# ============================================================================

# 1. Build the app bundle (using the production script's build-only mode)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "▸ Building for Development..."
"${SCRIPT_DIR}/Build_Production.sh" build-only

if [ $? -eq 0 ]; then
    echo "✔ Build successful. Launching with Console Output..."
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  APP OUTPUT STARTS BELOW"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # 2. Launch binary directly to see all terminal outputs
    # The application is installed to ~/Applications/Dream DAW.app
    "${HOME}/Applications/Dream DAW.app/Contents/MacOS/DreamDAW" | tee "${SCRIPT_DIR}/app_terminal.log"
else
    echo "❌ Build failed. Check logs above."
    exit 1
fi
