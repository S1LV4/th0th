#!/bin/bash
set -e

# ========================================
# th0th - VSCode Integration Validator
# ========================================
# Valida se a integração th0th + VSCode está funcionando
#
# Uso: ./scripts/validate-vscode-integration.sh
# ========================================

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           th0th - Integration Validation                      ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Get th0th root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TH0TH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- Test 1: Prerequisites ----
echo -e "${BOLD}[1/6] Checking prerequisites...${NC}"

if command -v bunx &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} bunx: $(bunx --version)"
elif command -v npx &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} npx: $(npx --version)"
else
    echo -e "  ${RED}✗${NC} bunx/npx: NOT INSTALLED"
    ERRORS=$((ERRORS + 1))
fi

if command -v curl &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} curl: available"
else
    echo -e "  ${RED}✗${NC} curl: NOT INSTALLED"
    ERRORS=$((ERRORS + 1))
fi

# ---- Test 2: Ollama ----
echo ""
echo -e "${BOLD}[2/6] Checking Ollama...${NC}"

OLLAMA_URL="${OLLAMA_HOST:-http://localhost:11434}"

if curl -s --max-time 2 "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
    OLLAMA_VERSION=$(curl -s "${OLLAMA_URL}/api/version" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")
    echo -e "  ${GREEN}✓${NC} Ollama: healthy (v${OLAMA_VERSION})"
    
    # Check embedding model
    MODEL="${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text:latest}"
    MODEL_EXISTS=$(curl -s "${OLLAMA_URL}/api/tags" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
models = [m['name'] for m in data.get('models', [])]
search = '${MODEL%%:*}'
print('yes' if any(search in m for m in models) else 'no')
" 2>/dev/null || echo "no")
    
    if [ "$MODEL_EXISTS" = "yes" ]; then
        echo -e "  ${GREEN}✓${NC} Embedding model: ${MODEL}"
    else
        echo -e "  ${YELLOW}⚠${NC} Embedding model: ${MODEL} not found"
        echo -e "      Fix: ollama pull ${MODEL}"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    echo -e "  ${YELLOW}⚠${NC} Ollama: not reachable at ${OLLAMA_URL}"
    echo -e "      Fix: ollama serve"
    WARNINGS=$((WARNINGS + 1))
fi

# ---- Test 3: th0th API ----
echo ""
echo -e "${BOLD}[3/6] Checking th0th API...${NC}"

API_URL="${TH0TH_API_URL:-http://localhost:3333}"

if curl -s --max-time 2 "${API_URL}/health" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} API: healthy at ${API_URL}"
    
    # Test search endpoint
    SEARCH_TEST=$(curl -s -X POST "${API_URL}/api/v1/search/project" \
        -H "Content-Type: application/json" \
        -d '{"query": "test", "projectId": "validation-test", "maxResults": 1}' 2>&1 || echo '{"error":"failed"}')
    
    if echo "$SEARCH_TEST" | grep -q '"success"'; then
        echo -e "  ${GREEN}✓${NC} Search endpoint: working"
    else
        echo -e "  ${YELLOW}⚠${NC} Search endpoint: test failed"
        echo -e "      Response: ${SEARCH_TEST:0:100}"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    echo -e "  ${RED}✗${NC} API: not reachable at ${API_URL}"
    echo -e "      Fix: bun run start:api"
    ERRORS=$((ERRORS + 1))
fi

# ---- Test 4: MCP Server ----
echo ""
echo -e "${BOLD}[4/6] Checking MCP server...${NC}"

if command -v bunx &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} MCP client: @th0th-ai/mcp-client (bunx)"
    
    # Test MCP server startup
    TEST_OUTPUT=$(echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
        TH0TH_API_URL="${API_URL}" timeout 10 bunx @th0th-ai/mcp-client 2>&1 || echo "TIMEOUT")
elif command -v npx &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} MCP client: @th0th-ai/mcp-client (npx)"
    
    # Test MCP server startup
    TEST_OUTPUT=$(echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
        TH0TH_API_URL="${API_URL}" timeout 10 npx @th0th-ai/mcp-client 2>&1 || echo "TIMEOUT")
    
    if echo "$TEST_OUTPUT" | grep -q "th0th_search"; then
        TOOL_COUNT=$(echo "$TEST_OUTPUT" | grep -o '"name":"th0th_[^"]*"' | wc -l)
        echo -e "  ${GREEN}✓${NC} MCP server: starts successfully (${TOOL_COUNT} tools)"
        
        # List tools
        echo -e "      Tools discovered:"
        echo "$TEST_OUTPUT" | grep -o '"name":"th0th_[^"]*"' | sed 's/"name":"//g' | sed 's/"//g' | while read tool; do
            echo -e "        ${BLUE}•${NC} ${tool}"
        done
    else
        echo -e "  ${RED}✗${NC} MCP server: failed to start"
        echo -e "      Output: ${TEST_OUTPUT:0:200}"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo -e "  ${RED}✗${NC} bunx/npx: NOT INSTALLED"
    echo -e "      Fix: install Bun from https://bun.sh or Node.js from https://nodejs.org"
    ERRORS=$((ERRORS + 1))
fi

# ---- Test 5: VSCode Config ----
echo ""
echo -e "${BOLD}[5/6] Checking VSCode configuration...${NC}"

if [ -f ".vscode/mcp.json" ]; then
    echo -e "  ${GREEN}✓${NC} VSCode MCP config: exists"
    
    # Validate JSON
    if python3 -c "import json; json.load(open('.vscode/mcp.json'))" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Config syntax: valid JSON"
        
        # Check if th0th is configured
        if grep -q "th0th" .vscode/mcp.json; then
            echo -e "  ${GREEN}✓${NC} th0th server: configured"
            
            # Extract command
            COMMAND=$(python3 -c "
import json
config = json.load(open('.vscode/mcp.json'))
server = config.get('servers', {}).get('th0th', {})
cmd = server.get('command', '')
args = ' '.join(server.get('args', []))
print(f'{cmd} {args}'[:80])
" 2>/dev/null || echo "parse error")
            
            echo -e "      Command: ${COMMAND}"
        else
            echo -e "  ${RED}✗${NC} th0th server: not configured"
            echo -e "      Fix: Add th0th to .vscode/mcp.json"
            ERRORS=$((ERRORS + 1))
        fi
    else
        echo -e "  ${RED}✗${NC} Config syntax: invalid JSON"
        echo -e "      Fix: validate .vscode/mcp.json"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo -e "  ${YELLOW}⚠${NC} VSCode MCP config: not found"
    echo -e "      Fix: ./scripts/setup-vscode.sh"
    WARNINGS=$((WARNINGS + 1))
fi

# ---- Test 6: Integration Test ----
echo ""
echo -e "${BOLD}[6/6] Running integration test...${NC}"

if [ $ERRORS -eq 0 ]; then
    # Test full flow
    echo -e "  Testing: index → search → recall"
    
    # Create temp test project
    TEST_DIR="/tmp/th0th-validation-test"
    mkdir -p "$TEST_DIR"
    echo "// Test file for validation" > "$TEST_DIR/test.ts"
    echo "function authenticate(user: string) { return true; }" >> "$TEST_DIR/test.ts"
    
    # Test index
    INDEX_RESULT=$(curl -s -X POST "${API_URL}/api/v1/project/index" \
        -H "Content-Type: application/json" \
        -d "{\"projectPath\": \"${TEST_DIR}\", \"projectId\": \"validation-test\"}" 2>&1 || echo '{"error":"failed"}')
    
    if echo "$INDEX_RESULT" | grep -q '"success"'; then
        echo -e "  ${GREEN}✓${NC} Index: working"
        
        # Test search
        SEARCH_RESULT=$(curl -s -X POST "${API_URL}/api/v1/search/project" \
            -H "Content-Type: application/json" \
            -d '{"query": "authentication", "projectId": "validation-test", "maxResults": 5}' 2>&1 || echo '{"error":"failed"}')
        
        if echo "$SEARCH_RESULT" | grep -q '"success"'; then
            echo -e "  ${GREEN}✓${NC} Search: working"
        else
            echo -e "  ${YELLOW}⚠${NC} Search: test failed"
            WARNINGS=$((WARNINGS + 1))
        fi
        
        # Test memory
        MEMORY_RESULT=$(curl -s -X POST "${API_URL}/api/v1/memory/store" \
            -H "Content-Type: application/json" \
            -d '{"content": "Validation test memory", "type": "pattern"}' 2>&1 || echo '{"error":"failed"}')
        
        if echo "$MEMORY_RESULT" | grep -q '"success"'; then
            echo -e "  ${GREEN}✓${NC} Memory: working"
        else
            echo -e "  ${YELLOW}⚠${NC} Memory: test failed"
            WARNINGS=$((WARNINGS + 1))
        fi
    else
        echo -e "  ${YELLOW}⚠${NC} Index: test failed"
        echo -e "      Response: ${INDEX_RESULT:0:100}"
        WARNINGS=$((WARNINGS + 1))
    fi
    
    # Cleanup
    rm -rf "$TEST_DIR"
else
    echo -e "  ${YELLOW}⚠${NC} Skipping: fix errors first"
fi

# ---- Summary ----
echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║                    Validation Results                         ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "  ${GREEN}✓ All checks passed!${NC}"
    echo ""
    echo -e "  ${BOLD}Integration is working correctly.${NC}"
    echo ""
    echo -e "  Next steps:"
    echo -e "    1. Restart VSCode/Antigravity"
    echo -e "    2. Test in chat: 'Use th0th to search for authentication'"
    echo ""
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "  ${YELLOW}⚠ Validation passed with warnings${NC}"
    echo ""
    echo -e "  ${BOLD}Errors: ${ERRORS}  Warnings: ${WARNINGS}${NC}"
    echo ""
    echo -e "  Integration should work, but some features may be limited."
    echo -e "  Review warnings above and fix if needed."
    echo ""
    exit 0
else
    echo -e "  ${RED}✗ Validation failed${NC}"
    echo ""
    echo -e "  ${BOLD}Errors: ${ERRORS}  Warnings: ${WARNINGS}${NC}"
    echo ""
    echo -e "  ${RED}Fix errors before using th0th.${NC}"
    echo ""
    echo -e "  Common fixes:"
    echo -e "    • Start API: bun run start:api"
    echo -e "    • Start Ollama: ollama serve"
    echo -e "    • Install Bun: https://bun.sh (or Node.js: https://nodejs.org)"
    echo -e "    • Setup config: ./scripts/setup-vscode.sh"
    echo -e "    • Check docs: docs/VSCODE_TROUBLESHOOTING.md"
    echo ""
    exit 1
fi
