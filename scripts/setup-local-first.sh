#!/bin/bash
set -e

# ========================================
# th0th - Local-First Setup Script
# ========================================
# Sets up th0th to work 100% offline
# with no dependency on external services.
#
# Usage: ./scripts/setup-local-first.sh
# ========================================

# shellcheck source=scripts/banner.sh
source "$(dirname "${BASH_SOURCE[0]}")/banner.sh"
th0th_banner
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

# ---- Step 3: Database selection ----
echo ""
echo -e "${BOLD}[3/5] Database selection...${NC}"
echo ""
echo -e "  Choose your database backend:"
echo -e "    ${BLUE}1)${NC} SQLite (default, zero-config, local-first)"
echo -e "    ${BLUE}2)${NC} PostgreSQL + pgvector (better performance for large datasets)"
echo ""
read -rp "  Enter your choice [1]: " DB_CHOICE </>/dev/tty || true
DB_CHOICE=${DB_CHOICE:-1}

USE_POSTGRES=false
DATABASE_URL=""

if [ "$DB_CHOICE" = "2" ]; then
    USE_POSTGRES=true
    echo ""
    echo -e "  ${YELLOW}⚠${NC} PostgreSQL requires Docker or a running PostgreSQL instance"
    echo ""
    
    # Check if docker is available
    if command -v docker &> /dev/null; then
        echo -e "  ${GREEN}✓${NC} Docker is installed"
        
        # Find available port starting from 5432
        POSTGRES_PORT=5432
        while netstat -tuln 2>/dev/null | grep -q ":${POSTGRES_PORT} " || ss -tuln 2>/dev/null | grep -q ":${POSTGRES_PORT} "; do
            echo -e "  ${YELLOW}⚠${NC} Port ${POSTGRES_PORT} is already in use"
            POSTGRES_PORT=$((POSTGRES_PORT + 1))
        done
        
        if [ "$POSTGRES_PORT" != "5432" ]; then
            echo -e "  ${GREEN}✓${NC} Using alternative port: ${POSTGRES_PORT}"
        fi
        
        # Check if postgres container is running
        if docker ps --format '{{.Names}}' | grep -q "th0th-postgres"; then
            echo -e "  ${GREEN}✓${NC} PostgreSQL container already running"
            
            # Get the port from running container
            RUNNING_PORT=$(docker port th0th-postgres 5432 2>/dev/null | cut -d: -f2)
            if [ -n "$RUNNING_PORT" ]; then
                POSTGRES_PORT=$RUNNING_PORT
                echo -e "  ${GREEN}✓${NC} Using existing container port: ${POSTGRES_PORT}"
            fi
        else
            echo -e "  ${YELLOW}⚠${NC} Starting PostgreSQL with Docker..."
            
            # Get project root
            SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
            PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
            
            # Export port for docker-compose
            export TH0TH_POSTGRES_PORT=$POSTGRES_PORT
            
            cd "$PROJECT_ROOT"
            docker compose up -d postgres
            
            if [ $? -eq 0 ]; then
                echo -e "  ${GREEN}✓${NC} PostgreSQL started successfully on port ${POSTGRES_PORT}"
                sleep 3  # Wait for postgres to be ready
            else
                echo -e "  ${RED}✗${NC} Failed to start PostgreSQL"
                echo -e "      Try manually: cd ${PROJECT_ROOT} && TH0TH_POSTGRES_PORT=${POSTGRES_PORT} docker compose up -d postgres"
                exit 1
            fi
        fi
        
        DATABASE_URL="postgresql://th0th:th0th_password@localhost:${POSTGRES_PORT}/th0th"
        echo -e "  ${GREEN}✓${NC} Database URL: ${DATABASE_URL}"
    else
        echo -e "  ${YELLOW}⚠${NC} Docker not found. Please provide PostgreSQL connection URL:"
        read -rp "  DATABASE_URL: " DATABASE_URL </>/dev/tty || true
        
        if [ -z "$DATABASE_URL" ]; then
            echo -e "  ${RED}✗${NC} No DATABASE_URL provided. Falling back to SQLite."
            USE_POSTGRES=false
        fi
    fi
else
    echo -e "  ${GREEN}✓${NC} Using SQLite (local-first)"
fi

# ---- Step 4: Create directories and config ----
echo ""
echo -e "${BOLD}[4/5] Creating directories and config...${NC}"

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
    if [ "$USE_POSTGRES" = true ]; then
        cat > "$ENV_FILE" << ENVEOF
# MCP TH0TH - Auto-generated by setup-local-first.sh

# Database Configuration
DATABASE_URL=${DATABASE_URL}

# Ollama Configuration (Local)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=bge-m3
OLLAMA_EMBEDDING_DIMENSIONS=1024

# Vector Database (file-based)
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
    else
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
    fi
    echo -e "  ${GREEN}✓${NC} Created .env file: ${ENV_FILE}"
else
    if [ "$USE_POSTGRES" = true ]; then
        # Update existing .env with DATABASE_URL
        if grep -q "^DATABASE_URL=" "$ENV_FILE"; then
            # Replace existing DATABASE_URL
            sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" "$ENV_FILE"
            echo -e "  ${GREEN}✓${NC} Updated DATABASE_URL in .env: ${ENV_FILE}"
        else
            # Add DATABASE_URL at the beginning
            echo -e "\n# Database Configuration (added by setup-local-first.sh)\nDATABASE_URL=${DATABASE_URL}\n$(cat $ENV_FILE)" > "$ENV_FILE.tmp"
            mv "$ENV_FILE.tmp" "$ENV_FILE"
            echo -e "  ${GREEN}✓${NC} Added DATABASE_URL to .env: ${ENV_FILE}"
        fi
    fi
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
    "dimensions": 1024
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

# Run Prisma migrations if using PostgreSQL
if [ "$USE_POSTGRES" = true ]; then
    echo ""
    echo -e "  ${YELLOW}⚠${NC} Running database migrations..."
    
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
    
    cd "${PROJECT_ROOT}/packages/core"
    
    if command -v bun &> /dev/null; then
        # Export DATABASE_URL for prisma
        export DATABASE_URL="${DATABASE_URL}"
        
        # Check if migration_lock.toml exists and has wrong provider
        MIGRATION_LOCK="${PROJECT_ROOT}/packages/core/prisma/migrations/migration_lock.toml"
        if [ -f "$MIGRATION_LOCK" ]; then
            CURRENT_PROVIDER=$(grep "^provider = " "$MIGRATION_LOCK" | cut -d'"' -f2)
            if [ "$CURRENT_PROVIDER" = "sqlite" ]; then
                echo -e "  ${YELLOW}⚠${NC} Detected SQLite migrations, updating to PostgreSQL..."
                sed -i.bak 's/provider = "sqlite"/provider = "postgresql"/' "$MIGRATION_LOCK"
                echo -e "  ${GREEN}✓${NC} Updated migration_lock.toml"
            fi
        fi
        
        bunx prisma migrate deploy
        if [ $? -eq 0 ]; then
            echo -e "  ${GREEN}✓${NC} Database migrations completed"
        else
            echo -e "  ${YELLOW}⚠${NC} Migrations failed. Run manually:"
            echo -e "      cd ${PROJECT_ROOT}/packages/core"
            echo -e "      DATABASE_URL='${DATABASE_URL}' bunx prisma migrate deploy"
        fi
    else
        echo -e "  ${YELLOW}⚠${NC} Bun not found. Please run migrations manually:"
        echo -e "      cd ${PROJECT_ROOT}/packages/core"
        echo -e "      DATABASE_URL='${DATABASE_URL}' bunx prisma migrate deploy"
    fi
fi

# ---- Step 5: Verify setup ----
echo ""
echo -e "${BOLD}[5/5] Verifying setup...${NC}"

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

# Check database
if [ "$USE_POSTGRES" = true ]; then
    # Try to connect to PostgreSQL
    if command -v psql &> /dev/null; then
        if psql "${DATABASE_URL}" -c "SELECT 1" > /dev/null 2>&1; then
            echo -e "  ${GREEN}✓${NC} PostgreSQL: connected"
        else
            echo -e "  ${YELLOW}⚠${NC} PostgreSQL: connection failed (but may work at runtime)"
        fi
    elif command -v docker &> /dev/null; then
        if docker ps --format '{{.Names}}' | grep -q "th0th-postgres"; then
            echo -e "  ${GREEN}✓${NC} PostgreSQL: container running"
        else
            echo -e "  ${RED}✗${NC} PostgreSQL: container not running"
        fi
    fi
else
    echo -e "  ${GREEN}✓${NC} Database: SQLite (local files)"
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
if [ "$USE_POSTGRES" = true ]; then
    echo -e "    ${BLUE}•${NC} Database: PostgreSQL + pgvector"
    echo -e "    ${BLUE}•${NC} Vector DB: PostgreSQL pgvector"
else
    echo -e "    ${BLUE}•${NC} Database: SQLite (local)"
    echo -e "    ${BLUE}•${NC} Vector DB: SQLite (local)"
fi
echo -e "    ${BLUE}•${NC} Cost: ${GREEN}\$0${NC}"
echo ""
echo -e "  ${BOLD}Config file:${NC}     ${CONFIG_FILE}"
echo -e "  ${BOLD}Data directory:${NC}  ${DATA_DIR}"
if [ "$USE_POSTGRES" = true ]; then
    echo -e "  ${BOLD}Database URL:${NC}    ${DATABASE_URL}"
fi
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

# ---- Run diagnose to validate the full stack ----
if command -v bun &> /dev/null && [ -f "${SCRIPT_DIR}/../scripts/diagnose.ts" 2>/dev/null ] || [ -f "${PROJECT_ROOT}/scripts/diagnose.ts" ]; then
    echo -e "  ${BOLD}Running stack validation (bun run diagnose)...${NC}"
    echo ""
    cd "${PROJECT_ROOT}"
    bun run diagnose || echo -e "  ${YELLOW}⚠${NC}  Some checks failed — review the output above before starting."
    echo ""
fi

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
