#!/bin/bash
# Wrapper di avvio Native Messaging per macOS e Linux
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"
NODE_BIN="$(command -v node 2>/dev/null || which node 2>/dev/null || echo "node")"
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$NODE_BIN" "$DIR/updater_host.js"
