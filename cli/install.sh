#!/usr/bin/env bash
set -euo pipefail

CLI_DIR="$(pwd)"

if [ "$(basename "$CLI_DIR")" != "cli" ] || [ "$(basename "$(dirname "$CLI_DIR")")" != "cf-submit" ]; then
    echo "Error: run install.sh from the cf-submit/cli directory"
    exit 1
fi

echo "==> Checking dependencies..."
command -v clang++ >/dev/null 2>&1 || { echo "Error: clang++ is required to compile the CLI wrapper."; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Error: python3 is required."; exit 1; }

if [ ! -f "$CLI_DIR/main.py" ] && [ -f "$CLI_DIR/main" ]; then
    cp "$CLI_DIR/main" "$CLI_DIR/main.py"
fi

chmod +x "$CLI_DIR/main.py"

if [ -x "$CLI_DIR/cf" ]; then
    echo "==> Binary '$CLI_DIR/cf' already exists, skipping compilation."
else
    echo "==> Compiling C++ wrapper..."
    clang++ -std=c++23 -O2 "$CLI_DIR/wrapper.cpp" -o "$CLI_DIR/cf"
    chmod +x "$CLI_DIR/cf"
fi

if [ "$EUID" -eq 0 ]; then
    INSTALL_DIR="/usr/local/bin"
else
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
fi

ln -sf "$CLI_DIR/cf" "$INSTALL_DIR/cf"
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
