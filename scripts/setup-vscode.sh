#!/bin/bash
set -e

# ========================================
# th0th - VSCode/Antigravity Setup Script
# ========================================
# Configura th0th para uso com VSCode Copilot ou Antigravity
#
# Uso: ./scripts/setup-vscode.sh
# ========================================

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║             th0th - VSCode/Antigravity Setup                 ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Get th0th root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TH0TH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- Step 1: Check prerequisites ----
echo -e "${BOLD}[1/5] Checking prerequisites...${NC}"

# Check bun
if ! command -v bun &> /dev/null; then
    echo -e "  ${RED}✗${NC} bun is not installed"
    echo -e "      Install from: https://bun.sh"
    exit 1
else
    BUN_VERSION=$(bun --version)
    echo -e "  ${GREEN}✓${NC} bun: ${BUN_VERSION}"
fi

# Check if bunx or npx is available
if command -v bunx &> /dev/null; then
    BUNX_VERSION=$(bunx --version)
    echo -e "  ${GREEN}✓${NC} bunx: ${BUNX_VERSION}"
    MCP_CMD="bunx"
elif command -v npx &> /dev/null; then
    NPX_VERSION=$(npx --version)
    echo -e "  ${GREEN}✓${NC} npx: ${NPX_VERSION}"
    MCP_CMD="npx"
else
    echo -e "  ${RED}✗${NC} bunx/npx is not installed"
    echo -e "      Install Bun from: https://bun.sh"
    echo -e "      Or Node.js from: https://nodejs.org"
    exit 1
fi

# ---- Step 2: Check Ollama ----
echo ""
echo -e "${BOLD}[2/5] Checking Ollama...${NC}"

OLLAMA_URL="${OLLAMA_HOST:-http://localhost:11434}"

if curl -s "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
    OLLAMA_VERSION=$(curl -s "${OLLAMA_URL}/api/version" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")
    echo -e "  ${GREEN}✓${NC} Ollama: healthy at ${OLLAMA_URL} (v${OLLAMA_VERSION})"
else
    echo -e "  ${YELLOW}⚠${NC} Ollama not reachable at ${OLLAMA_URL}"
    echo -e "      Run: ./scripts/setup-local-first.sh"
    echo -e "      Or start manually: ollama serve"
    echo ""
    echo -e "      ${YELLOW}Continue anyway? (y/n)${NC}"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# ---- Step 3: Start API if not running ----
echo ""
echo -e "${BOLD}[3/5] Checking th0th API...${NC}"

API_URL="${TH0TH_API_URL:-http://localhost:3333}"

if curl -s "${API_URL}/health" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} API: healthy at ${API_URL}"
else
    echo -e "  ${YELLOW}⚠${NC} API not running at ${API_URL}"
    echo -e "      Starting API..."
    
    cd "$TH0TH_ROOT"
    nohup bun run start:api > /tmp/th0th-api.log 2>&1 &
    API_PID=$!
    
    # Wait for API to start
    echo -n "      Waiting for API"
    for i in {1..10}; do
        sleep 1
        echo -n "."
        if curl -s "${API_URL}/health" > /dev/null 2>&1; then
            echo ""
            echo -e "  ${GREEN}✓${NC} API started successfully (PID: ${API_PID})"
            break
        fi
    done
    
    if ! curl -s "${API_URL}/health" > /dev/null 2>&1; then
        echo ""
        echo -e "  ${RED}✗${NC} Failed to start API"
        echo -e "      Check logs: /tmp/th0th-api.log"
        exit 1
    fi
fi

# ---- Step 4: Create VSCode MCP config ----
echo ""
echo -e "${BOLD}[4/5] Configuring VSCode/Antigravity...${NC}"

# Determine workspace
if [ -f ".vscode/mcp.json" ]; then
    echo -e "  ${YELLOW}⚠${NC} .vscode/mcp.json already exists"
    echo -e "      ${YELLOW}Overwrite? (y/n)${NC}"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo -e "  ${BLUE}ℹ${NC} Skipping config creation"
    else
        CREATE_CONFIG=true
    fi
else
    CREATE_CONFIG=true
fi

if [ "$CREATE_CONFIG" = true ]; then
    mkdir -p .vscode
    
    cat > .vscode/mcp.json << EOF
{
  "servers": {
    "th0th": {
      "command": "${MCP_CMD}",
      "args": ["@th0th-ai/mcp-client"],
      "env": {
        "TH0TH_API_URL": "${API_URL}"
      }
    }
  }
}
EOF
    
    echo -e "  ${GREEN}✓${NC} Created: .vscode/mcp.json"
fi

# Also create user-level config example
USER_CONFIG_DIR="${HOME}/.config/th0th"
mkdir -p "$USER_CONFIG_DIR"

cat > "$USER_CONFIG_DIR/mcp.json.example" << EOF
{
  "servers": {
    "th0th": {
      "command": "${MCP_CMD}",
      "args": ["@th0th-ai/mcp-client"],
      "env": {
        "TH0TH_API_URL": "${API_URL}"
      }
    }
  }
}
EOF

echo -e "  ${GREEN}✓${NC} Created example: ${USER_CONFIG_DIR}/mcp.json.example"

# ---- Step 5: Test MCP server ----
echo ""
echo -e "${BOLD}[5/5] Testing MCP server...${NC}"

# Test if MCP server can start
TEST_OUTPUT=$(echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
    TH0TH_API_URL="${API_URL}" ${MCP_CMD} @th0th-ai/mcp-client 2>&1 || true)

if echo "$TEST_OUTPUT" | grep -q "th0th_search"; then
    TOOL_COUNT=$(echo "$TEST_OUTPUT" | grep -o '"name":"th0th_[^"]*"' | wc -l)
    echo -e "  ${GREEN}✓${NC} MCP server: OK (${TOOL_COUNT} tools discovered)"
else
    echo -e "  ${YELLOW}⚠${NC} MCP server test failed"
    echo -e "      Output: ${TEST_OUTPUT:0:200}"
fi

# ---- Summary ----
echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║                    Setup Complete                             ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}Configuration:${NC}"
echo -e "    ${BLUE}•${NC} API: ${API_URL}"
echo -e "    ${BLUE}•${NC} MCP Config: .vscode/mcp.json"
echo -e "    ${BLUE}•${NC} th0th Root: ${TH0TH_ROOT}"
echo ""
echo -e "  ${BOLD}Next Steps:${NC}"
echo ""
echo -e "  ${YELLOW}For VSCode:${NC}"
echo -e "    1. Restart VSCode: Cmd+Shift+P → 'Reload Window'"
echo -e "    2. Open Copilot Chat"
echo -e "    3. Test: 'List all th0th tools'"
echo ""
echo -e "  ${YELLOW}For Antigravity:${NC}"
echo -e "    1. Restart Antigravity"
echo -e "    2. Open chat/agent interface"
echo -e "    3. Test: 'List all th0th tools'"
echo ""
echo -e "  ${YELLOW}If tools don't appear:${NC}"
echo -e "    1. Check VSCode Output: View → Output → MCP"
echo -e "    2. Run validation: ./scripts/validate-vscode-integration.sh"
echo -e "    3. Check docs: docs/VSCODE_TROUBLESHOOTING.md"
echo ""
echo -e "  ${BOLD}API Management:${NC}"
echo -e "    ${BLUE}•${NC} Stop API: kill \$(lsof -t -i:3333)"
echo -e "    ${BLUE}•${NC} View logs: tail -f /tmp/th0th-api.log"
echo -e "    ${BLUE}•${NC} Restart API: bun run start:api"
echo ""
