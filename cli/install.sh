#!/usr/bin/env bash
set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_SCRIPT="$CLI_DIR/main.js"
CLI_BINARY="$CLI_DIR/cf"
BRIDGE_CONFIG="$(dirname "$CLI_DIR")/extension/bridge-config.js"

echo "==> Checking dependencies..."
NODE_BIN="$(command -v node 2>/dev/null)" || { echo "Error: Node.js is required."; exit 1; }
if [ ! -f "$BRIDGE_CONFIG" ]; then
    node -e 'const fs = require("node:fs"); const crypto = require("node:crypto"); const secret = crypto.randomBytes(32).toString("hex"); const source = `globalThis.CF_SUBMIT_BRIDGE_SECRET = ${JSON.stringify(secret)};\nif (typeof module !== "undefined") module.exports = ${JSON.stringify(secret)};\n`; fs.writeFileSync(process.argv[1], source, { mode: 0o600 });' "$BRIDGE_CONFIG"
fi
if [ -n "${SUDO_UID:-}" ] && [ -n "${SUDO_GID:-}" ]; then
    chown "$SUDO_UID:$SUDO_GID" "$BRIDGE_CONFIG"
fi
chmod +x "$CLI_SCRIPT"

if command -v clang++ >/dev/null 2>&1; then
    COMPILER="$(command -v clang++)"
elif command -v g++ >/dev/null 2>&1; then
    COMPILER="$(command -v g++)"
else
    echo "Error: clang++ or g++ is required to build the CP Editor launcher."
    exit 1
fi

echo "==> Building native CP Editor launcher..."
"$COMPILER" -std=c++17 -O2 "-DNODE_EXECUTABLE=\"$NODE_BIN\"" "$CLI_DIR/wrapper.cpp" -o "$CLI_BINARY"
chmod +x "$CLI_BINARY"

if [ "$EUID" -eq 0 ]; then
    INSTALL_DIR="/usr/local/bin"
else
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
fi

ln -sf "$CLI_BINARY" "$INSTALL_DIR/cf"
echo "==> Installed 'cf' to $INSTALL_DIR/cf"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo "Warning: $INSTALL_DIR is not in your PATH. Add this to your ~/.bashrc or ~/.zshrc:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
fi

echo ""
echo "Next steps:"
echo "  1. Load '$(dirname "$CLI_DIR")/extension' as an unpacked extension in Chrome / Brave / Edge."
echo "  2. In CP Editor -> Preferences -> Extensions -> CF Tool -> Path, set:"
echo "     $INSTALL_DIR/cf"
