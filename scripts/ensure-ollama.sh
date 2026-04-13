#!/bin/bash
# ========================================
# th0th - Ollama Auto-Start Script
# ========================================
# Ensures Ollama is running before dev/start.
# Used as a predev hook in package.json.
#
# Usage: bash scripts/ensure-ollama.sh
#
# Environment variables:
#   OLLAMA_BASE_URL  - Ollama API URL (default: http://localhost:11434)
# ========================================
set -e

# shellcheck source=scripts/banner.sh
source "$(dirname "${BASH_SOURCE[0]}")/banner.sh"
th0th_banner

OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"

echo "[th0th] Checking Ollama service at ${OLLAMA_URL}..."

# Already running? Nothing to do.
if curl -s --max-time 2 "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
    echo "[th0th] Ollama is already running."
    exit 0
fi

echo "[th0th] Ollama is not running. Attempting to start..."

# Check if ollama binary exists
if ! command -v ollama &> /dev/null; then
    echo "[th0th] WARNING: Ollama executable not found in PATH."
    echo "[th0th] Install it: curl -fsSL https://ollama.com/install.sh | sh"
    echo "[th0th] Or set OLLAMA_BASE_URL to point to a remote instance."
    # Exit 0 to not block dev workflow - provider fallback will handle it
    exit 0
fi

# Start ollama in background
nohup ollama serve > /tmp/ollama-th0th.log 2>&1 &

# Wait for it to be ready
MAX_RETRIES=10
COUNT=0
while [ $COUNT -lt $MAX_RETRIES ]; do
    if curl -s --max-time 2 "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
        echo "[th0th] Ollama started successfully."
        exit 0
    fi
    sleep 1
    COUNT=$((COUNT + 1))
    echo "[th0th] Waiting for Ollama... ($COUNT/$MAX_RETRIES)"
done

echo "[th0th] WARNING: Ollama did not start within ${MAX_RETRIES}s."
echo "[th0th] Check logs: cat /tmp/ollama-th0th.log"
echo "[th0th] Continuing without local Ollama (remote providers may be used)."
# Exit 0 to not block dev workflow
exit 0
