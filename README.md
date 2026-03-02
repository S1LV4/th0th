<img src="https://i.imgur.com/5EJK9OF.png" alt="th0th" style="visibility: visible; max-width: 60%; display: block; margin: 0 auto;" />

# th0th

**Ancient knowledge keeper for modern code**

Semantic search with 98% token reduction for AI assistants.

---

## Architecture

```
th0th/
├── apps/
│   ├── mcp-client/           # MCP Server (stdio) - Claude Desktop, OpenCode
│   │   └── src/
│   ├── tools-api/            # REST API (port 3333) - standalone/plugin
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   └── middleware/
│   │   └── data/
│   └── opencode-plugin/      # OpenCode-specific plugin
│       └── src/
├── packages/
│   ├── core/                 # Core business logic
│   │   ├── src/
│   │   │   ├── services/     # Search, cache, embeddings, compression
│   │   │   ├── models/       # Data models
│   │   │   ├── tools/        # MCP tool implementations
│   │   │   ├── data/         # Data access layer
│   │   │   └── scripts/      # Utility scripts
│   │   └── prisma/           # Database schema & migrations
│   └── shared/               # Shared utilities & types
│       └── src/
│           ├── types/
│           ├── utils/
│           └── config/
├── scripts/
│   └── setup-local-first.sh  # 100% offline setup
└── docs/
    └── architecture/
```

---

## How It Works

### Core Components

| Component | Description |
|-----------|-------------|
| **Semantic Search** | Hybrid search (vector + keyword) with RRF (Reciprocal Rank Fusion) |
| **Embeddings** | Ollama local models (nomic-embed-text, bge-m3) or Mistral API |
| **Compression** | Rule-based code structure extraction (70-98% token reduction) |
| **Memory** | Hierarchical persistent storage (SQLite) for context across sessions |
| **Cache** | Multi-level L1/L2 cache with TTL for frequently accessed queries |

### Available Tools

| Tool | Description |
|------|-------------|
| `th0th_index` | Index a project directory for semantic search |
| `th0th_search` | Semantic + keyword search with filters |
| `th0th_remember` | Store important information in persistent memory |
| `th0th_recall` | Search stored memories from previous sessions |
| `th0th_compress` | Compress context (keeps structure, removes details) |
| `th0th_optimized_context` | Search + compress in one call (max token efficiency) |
| `th0th_analytics` | Usage patterns, cache performance, metrics |

---

## Usage Examples

### 1. Index a Project

```bash
# Via MCP tool
th0th_index({
  projectPath: "/home/user/my-project",
  projectId: "my-project",
  forceReindex: false,
  warmCache: true
})
```

### 2. Semantic Search

```bash
# Search for code patterns
th0th_search({
  query: "authentication middleware JWT validation",
  projectId: "my-project",
  maxResults: 10,
  minScore: 0.3,
  responseMode: "summary",  # 70% token savings
  include: ["src/**/*.ts"],
  exclude: ["**/*.test.*"]
})
```

### 3. Store & Recall Memories

```bash
# Store important decisions
th0th_remember({
  content: "Using PostgreSQL for user data, Redis for sessions",
  type: "decision",
  projectId: "my-project",
  importance: 0.8,
  tags: ["database", "architecture"]
})

# Recall later
th0th_recall({
  query: "what database are we using?",
  types: ["decision"],
  projectId: "my-project"
})
```

### 4. Context Compression

```bash
# Compress large code files
th0th_compress({
  content: "... 5000 lines of code ...",
  strategy: "code_structure",  # Keeps imports, signatures, exports
  targetRatio: 0.7             # 70% reduction
})
```

### 5. Optimized Context (Search + Compress)

```bash
# One call for maximum efficiency
th0th_optimized_context({
  query: "how does authentication work?",
  projectId: "my-project",
  maxTokens: 4000,
  maxResults: 5
})
```

### Compression Strategies

| Strategy | Use Case | Reduction |
|----------|----------|-----------|
| `code_structure` | Source code | 70-90% |
| `conversation_summary` | Chat history | 80-95% |
| `semantic_dedup` | Repetitive content | 50-70% |
| `hierarchical` | Structured docs | 60-80% |

---

## MCP vs OpenCode Plugin

| Feature | MCP Server | OpenCode Plugin |
|---------|------------|-----------------|
| **Protocol** | Model Context Protocol (stdio) | REST API HTTP |
| **Usage** | Claude Desktop, OpenCode, other MCP clients | OpenCode only |
| **Execution** | `start:mcp` - child process via stdio | `start:api` - HTTP server :3333 |
| **Config** | `opencode.json` with `command` | `opencode.json` with `url` |
| **Advantage** | Universal standard, multi-client | Simpler for OpenCode |
| **Disadvantage** | Communication via stdin/stdout only | Limited to OpenCode |

---

## Installation

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd th0th
bun install
```

### 2. Configure environment

**Option A: Local-First (100% offline, recommended)**

```bash
./scripts/setup-local-first.sh
# This sets up Ollama, downloads embedding models, and creates .env
```

**Option B: With external APIs (Mistral, etc.)**

```bash
cp .env.example .env
# Edit .env with your API keys
```

### 3. Build

```bash
bun run build
```

---

## Running

### REST API (port 3333)

```bash
# Development (hot reload)
bun run dev:api

# Production
bun run start:api
```

Verify: `curl http://localhost:3333/health`

### API Endpoints (curl examples)

```bash
# Health check
curl http://localhost:3333/health

# Index a project
curl -X POST http://localhost:3333/api/v1/project/index \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/home/user/my-project", "projectId": "my-project"}'

# Search
curl -X POST http://localhost:3333/api/v1/search/project \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication", "projectId": "my-project"}'

# Store memory
curl -X POST http://localhost:3333/api/v1/memory/store \
  -H "Content-Type: application/json" \
  -d '{"content": "Important decision...", "type": "decision"}'

# Compress context
curl -X POST http://localhost:3333/api/v1/context/compress \
  -H "Content-Type: application/json" \
  -d '{"content": "...", "strategy": "code_structure"}'
```

Swagger docs: `http://localhost:3333/swagger`

### MCP Server (stdio)

```bash
# Development (watch)
bun run dev:mcp

# Production
bun run start:mcp
```

---

## Configuring OpenCode

### After npm install (recommended)

**Via MCP Server:**

```json
{
  "mcpServers": {
    "th0th": {
      "type": "local",
      "command": ["npx", "@th0th/mcp-client"],
      "enabled": true
    }
  }
}
```

**Via Plugin:**

```json
{
  "plugin": ["@th0th/opencode-plugin"]
}
```

### From source

File: `~/.config/opencode/opencode.json`

**Option 1: Via MCP (recommended)**

```json
{
  "mcpServers": {
    "th0th": {
      "type": "local",
      "command": ["bun", "run", "/path/to/th0th/apps/mcp-client/src/index.ts"],
      "enabled": true
    }
  }
}
```

**Option 2: Via Plugin (REST)**

```json
{
  "plugins": {
    "th0th": {
      "type": "remote",
      "url": "http://localhost:3333",
      "enabled": true
    }
  }
}
```

---

## Configuration

Config file: `~/.config/th0th/config.json`

### Automatic Setup (Zero Config)

th0th auto-configures on first run with **Ollama** (local, free):

```json
// Just add to opencode.json - config is created automatically
{
  "mcpServers": {
    "th0th": {
      "type": "local",
      "command": ["npx", "@th0th/mcp-client"],
      "enabled": true
    }
  }
}
```

Or via plugin:

```json
{
  "plugin": ["@th0th/opencode-plugin"]
}
```

On first run, th0th creates `~/.config/th0th/config.json` with Ollama defaults.

### Manual Setup

```bash
# Initialize with Ollama (local, free)
npx th0th-config init

# Or with Mistral
npx th0th-config init --mistral your-api-key

# Or with OpenAI
npx th0th-config init --openai your-api-key
```

### Switch Provider

```bash
# Use Ollama with different model
npx th0th-config use ollama --model bge-m3:latest

# Switch to Mistral
npx th0th-config use mistral --api-key your-key

# Switch to OpenAI
npx th0th-config use openai --api-key your-key

# Show current config
npx th0th-config show

# Show config path
npx th0th-config path
```

### Config File Structure

`~/.config/th0th/config.json`:

```json
{
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text:latest",
    "baseURL": "http://localhost:11434",
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
    "l2MaxSizeMB": 500
  },
  "logging": {
    "level": "info",
    "enableMetrics": false
  }
}
```

### Providers

| Provider | Model | Cost | Quality |
|----------|-------|------|---------|
| **Ollama** (default) | nomic-embed-text, bge-m3 | Free | Good |
| **Mistral** | mistral-embed, codestral-embed | $$ | Great |
| **OpenAI** | text-embedding-3-small | $$ | Great |

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `bun run build` | Build all packages |
| `bun run dev` | Development (all apps) |
| `bun run dev:api` | REST API with hot reload |
| `bun run dev:mcp` | MCP server with watch |
| `bun run start:api` | Start REST API in production |
| `bun run start:mcp` | Start MCP server in production |
| `bun run test` | Run tests |
| `bun run lint` | Lint code |
| `bun run type-check` | Type checking |

---

## Docker

### Quick Start

```bash
# Start API + MCP
docker compose up -d

# API only
docker compose up -d api

# Check health
curl http://localhost:3333/health
```

### MCP via Docker (Claude Desktop / OpenCode)

Add to your MCP config:

```json
{
  "mcpServers": {
    "th0th": {
      "type": "local",
      "command": ["docker", "compose", "run", "--rm", "-i", "mcp"],
      "enabled": true
    }
  }
}
```

Or build and run directly:

```bash
# Build MCP image
docker build --target mcp -t th0th-mcp .

# Use in MCP config
{
  "mcpServers": {
    "th0th": {
      "type": "local",
      "command": [
        "docker", "run", "--rm", "-i",
        "--network", "host",
        "-e", "TH0TH_API_URL=http://localhost:3333",
        "th0th-mcp"
      ],
      "enabled": true
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TH0TH_API_PORT` | `3333` | API port |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Ollama endpoint |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text:latest` | Embedding model |
| `OLLAMA_EMBEDDING_DIMENSIONS` | `768` | Embedding dimensions |
| `RLM_LLM_ENABLED` | `false` | Enable LLM compression |
| `MISTRAL_API_KEY` | - | Mistral API key |

### Data Persistence

The API container uses a named volume `th0th-data` at `/data` for SQLite databases. Data persists across container restarts.

```bash
# View volume
docker volume inspect th0th_th0th-data

# Backup
docker cp th0th-api:/data ./backup

# Clean everything
docker compose down -v
```

---

## Local-First Mode (100% Offline)

### Quick Setup

```bash
./scripts/setup-local-first.sh
```

This script:
1. **Ollama** - Installs and starts if needed
2. **Embedding models** - Downloads `nomic-embed-text`
3. **Config** - Creates `~/.config/th0th/config.json`
4. **Data directories** - Creates `~/.rlm/`

### Manual Setup

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull embedding model
ollama pull nomic-embed-text

# Initialize config
npx th0th-config init
```

### Features

- Embeddings: Ollama (nomic-embed-text, bge-m3, etc.)
- Compression: Rule-based (no LLM)
- Cache: Local SQLite
- Vector DB: Local SQLite
- Cost: $0

---

## License

MIT

---

**th0th** - Intelligent semantic search for code
