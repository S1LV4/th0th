#!/bin/bash
set -e

# ========================================
# th0th - Local-First Setup Script
# ========================================
# Configura o th0th para funcionar 100% offline
# sem dependencia de servicos externos.
#
# Uso: ./scripts/setup-local-first.sh
# ========================================

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║             th0th - Local-First Setup                         ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ---- Step 1: Check Ollama ----
echo -e "${BOLD}[1/4] Checking Ollama...${NC}"

OLLAMA_URL="${OLLAMA_HOST:-http://localhost:11434}"
OLLAMA_HAS_CLI=false
OLLAMA_API_REACHABLE=false

# Check if Ollama CLI is available
if command -v ollama &> /dev/null; then
    OLLAMA_HAS_CLI=true
    echo -e "  ${GREEN}✓${NC} Ollama CLI is installed"
fi

# Check if Ollama API is reachable (covers WSL -> Windows host, remote, etc.)
if curl -s "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
    OLLAMA_API_REACHABLE=true
    OLLAMA_VERSION=$(curl -s "${OLLAMA_URL}/api/version" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")
    echo -e "  ${GREEN}✓${NC} Ollama API reachable at ${OLLAMA_URL} (v${OLLAMA_VERSION})"
fi

if [ "$OLLAMA_HAS_CLI" = false ] && [ "$OLLAMA_API_REACHABLE" = false ]; then
    # Neither CLI nor API available - try to install
    echo -e "  ${YELLOW}⚠${NC} Ollama not found. Installing..."
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        curl -fsSL https://ollama.com/install.sh | sh
        OLLAMA_HAS_CLI=true
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        echo -e "  ${YELLOW}⚠${NC} On macOS, install Ollama from: https://ollama.com/download"
        echo -e "  ${YELLOW}⚠${NC} Then re-run this script."
        exit 1
    else
        echo -e "  ${RED}✗${NC} Unsupported OS. Install Ollama manually: https://ollama.com"
        exit 1
    fi
elif [ "$OLLAMA_HAS_CLI" = false ] && [ "$OLLAMA_API_REACHABLE" = true ]; then
    # API reachable but no CLI (e.g. WSL with Ollama on Windows host)
    echo -e "  ${GREEN}✓${NC} Using remote Ollama API (no local CLI needed)"
fi

# If API is not reachable yet, try to start it
if [ "$OLLAMA_API_REACHABLE" = false ]; then
    if [ "$OLLAMA_HAS_CLI" = true ]; then
        echo -e "  ${YELLOW}⚠${NC} Ollama API not responding. Starting..."
        nohup ollama serve > /dev/null 2>&1 &
        sleep 2

        if curl -s "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
            OLLAMA_API_REACHABLE=true
            echo -e "  ${GREEN}✓${NC} Ollama started successfully"
        else
            echo -e "  ${RED}✗${NC} Failed to start Ollama. Please start it manually: ollama serve"
            exit 1
        fi
    else
        echo -e "  ${RED}✗${NC} Ollama API not reachable at ${OLLAMA_URL}"
        echo -e "      Set OLLAMA_HOST to point to your Ollama instance."
        exit 1
    fi
fi

# ---- Step 2: Pull embedding models ----
echo ""
echo -e "${BOLD}[2/4] Pulling embedding models...${NC}"

EMBEDDING_MODEL="${OLLAMA_EMBEDDING_MODEL:-bge-m3}"

# Check if model is already available via API
MODEL_EXISTS=$(curl -s "${OLLAMA_URL}/api/tags" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
models = [m['name'] for m in data.get('models', [])]
search = '${EMBEDDING_MODEL%%:*}'
print('yes' if any(search in m for m in models) else 'no')
" 2>/dev/null || echo "no")

if [ "$MODEL_EXISTS" = "yes" ]; then
    echo -e "  ${GREEN}✓${NC} Model ${EMBEDDING_MODEL} already available"
else
    echo -e "  Pulling ${EMBEDDING_MODEL}..."
    if [ "$OLLAMA_HAS_CLI" = true ]; then
        ollama pull "$EMBEDDING_MODEL"
    else
        # Pull via API (works for remote/WSL scenarios)
        curl -s "${OLLAMA_URL}/api/pull" -d "{\"name\": \"${EMBEDDING_MODEL}\"}" | while IFS= read -r line; do
            STATUS=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || true)
            if [ -n "$STATUS" ]; then
                printf "\r  %s" "$STATUS"
            fi
        done
        echo ""
    fi
    echo -e "  ${GREEN}✓${NC} Model ${EMBEDDING_MODEL} pulled"
fi

# ---- Step 3: Create directories and config ----
echo ""
echo -e "${BOLD}[3/4] Creating directories and config...${NC}"

# Data directory
DATA_DIR="${HOME}/.rlm"
mkdir -p "$DATA_DIR"
echo -e "  ${GREEN}✓${NC} Data directory: ${DATA_DIR}"

# Config directory
CONFIG_DIR="${HOME}/.config/th0th"
mkdir -p "$CONFIG_DIR"
CONFIG_FILE="${CONFIG_DIR}/config.json"

# Get project root (assuming script is in scripts/ directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

# Create .env file if not exists
if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" << 'ENVEOF'
# MCP TH0TH - Auto-generated by setup-local-first.sh

# Ollama Configuration (Local)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=bge-m3
OLLAMA_EMBEDDING_DIMENSIONS=1024

# Database Paths (relative to project root)
VECTOR_DB_PATH=./data/chroma
CACHE_DB_PATH=./data/cache.db
KEYWORD_DB_PATH=./data/keyword.db
EMBEDDING_CACHE_DB_PATH=./data/embedding-cache.db

# Logging
LOG_LEVEL=info
ENABLE_METRICS=false

# Cache Configuration
L1_CACHE_MAX_SIZE=104857600  # 100MB
L1_CACHE_TTL=300             # 5 minutes
L2_CACHE_MAX_SIZE=524288000  # 500MB
L2_CACHE_TTL=3600            # 1 hour
ENVEOF
    echo -e "  ${GREEN}✓${NC} Created .env file: ${ENV_FILE}"
else
    echo -e "  ${YELLOW}⚠${NC} .env file already exists: ${ENV_FILE}"
fi

# Create config file if not exists
if [ ! -f "$CONFIG_FILE" ]; then
    cat > "$CONFIG_FILE" << EOF
{
  "embedding": {
    "provider": "ollama",
    "model": "${EMBEDDING_MODEL}",
    "baseURL": "${OLLAMA_URL}",
    "dimensions": 768
  },
  "compression": {
    "enabled": true,
    "strategy": "code_structure",
    "targetRatio": 0.7
  },
  "cache": {
    "enabled": true,
    "l1MaxSizeMB": 100,
    "l2MaxSizeMB": 500,
    "defaultTTLSeconds": 3600
  },
  "dataDir": "${DATA_DIR}",
  "logging": {
    "level": "info",
    "enableMetrics": false
  }
}
EOF
    echo -e "  ${GREEN}✓${NC} Created config: ${CONFIG_FILE}"
else
    echo -e "  ${YELLOW}⚠${NC} Config already exists: ${CONFIG_FILE}"
fi

# ---- Step 4: Verify setup ----
echo ""
echo -e "${BOLD}[4/4] Verifying setup...${NC}"

# Check Ollama health
if curl -s "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
    MODELS=$(curl -s "${OLLAMA_URL}/api/tags" | python3 -c "import sys,json; data=json.load(sys.stdin); print(len(data.get('models',[])))" 2>/dev/null || echo "?")
    echo -e "  ${GREEN}✓${NC} Ollama: healthy at ${OLLAMA_URL} (${MODELS} models)"
else
    echo -e "  ${RED}✗${NC} Ollama: not responding"
fi

# Check data directory
if [ -d "$DATA_DIR" ] && [ -w "$DATA_DIR" ]; then
    echo -e "  ${GREEN}✓${NC} Data directory: ${DATA_DIR}"
else
    echo -e "  ${RED}✗${NC} Data directory: not writable"
fi

# Check config
if [ -f "$CONFIG_FILE" ]; then
    echo -e "  ${GREEN}✓${NC} Config: ${CONFIG_FILE}"
else
    echo -e "  ${RED}✗${NC} Config: not found"
fi

# ---- Summary ----
echo ""
echo -e "${BOLD}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║                    Setup Complete                             ║${NC}"
echo -e "${BOLD}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}Local-First Configuration:${NC}"
echo -e "    ${BLUE}•${NC} Embeddings: Ollama (${EMBEDDING_MODEL})"
echo -e "    ${BLUE}•${NC} Compression: Rule-based (no LLM)"
echo -e "    ${BLUE}•${NC} Cache: SQLite (local)"
echo -e "    ${BLUE}•${NC} Vector DB: SQLite (local)"
echo -e "    ${BLUE}•${NC} Cost: ${GREEN}\$0${NC}"
echo ""
echo -e "  ${BOLD}Config file:${NC}     ${CONFIG_FILE}"
echo -e "  ${BOLD}Data directory:${NC}  ${DATA_DIR}"
echo ""
echo -e "  ${BOLD}To change provider:${NC}"
echo -e "    npx th0th-config use mistral --api-key YOUR_KEY"
echo -e "    npx th0th-config use openai --api-key YOUR_KEY"
echo ""
echo -e "  ${BOLD}Next steps (from source):${NC}"
echo -e "    1. ${BLUE}bun install${NC}"
echo -e "    2. ${BLUE}bun run build${NC}"
echo -e "    3. ${BLUE}bun run start:api${NC}"
echo ""
echo -e "  ${BOLD}Or use with OpenCode:${NC}"
echo -e '    Add to ~/.config/opencode/opencode.json:'
echo ""
echo -e '    {'
echo -e '      "mcpServers": {'
echo -e '        "th0th": {'
echo -e '          "type": "local",'
echo -e '          "command": ["npx", "@th0th-ai/mcp-client"],'
echo -e '          "enabled": true'
echo -e '        }'
echo -e '      }'
echo -e '    }'
echo ""
