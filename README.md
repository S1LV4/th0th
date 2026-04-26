<img src="https://i.imgur.com/WP7ivBc.png" alt="th0th" style="visibility: visible; max-width: 60%; display: block; margin: 0 auto;" />

# th0th

**Ancient knowledge keeper for modern code**

Semantic search with 98% token reduction for AI assistants.

Como reduzi 98% do uso de contexto (e custos) de IA no meu workflow / How I reduced AI context usage (and costs) by 98% in my workflow
https://www.tabnews.com.br/S1LV4/como-reduzi-em-98-por-cento-o-uso-de-contexto-e-os-custos-de-ia-no-meu-workflow

---

## Quick Start

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/S1LV4/th0th/main/install.sh | bash
```

Installs interactively. Three modes:

| Mode | Requires | Best for |
|------|----------|----------|
| **Docker** (default) | Docker | Production, quick start |
| **Docker build** | Docker + Git | Custom builds, local changes |
| **Source** | Git + Bun | Development, contributors |

Non-interactive (CI/scripted):

```bash
# Docker mode, custom port, skip start
TH0TH_MODE=docker TH0TH_API_PORT=4000 TH0TH_NO_START=1 \
  curl -fsSL https://raw.githubusercontent.com/S1LV4/th0th/main/install.sh | bash
```

### Manual setup (from source)

```bash
# 1. Clone and install
git clone https://github.com/S1LV4/th0th.git
cd th0th
bun install

# 2. Setup (100% offline with Ollama)
./scripts/setup-local-first.sh
# - Installs/starts Ollama
# - Pulls bge-m3 embedding model (1024 dimensions)
# - Creates .env with defaults
# - Runs bun run diagnose to validate the stack

# 3. Build and start
bun run build
bun run start:api
```

Verify: `curl http://localhost:3333/health`

> **Tip:** Run `bun run diagnose` at any time to validate Ollama connectivity,
> database access, embedding generation, and migration status.

---

## Integration

### OpenCode (recommended)

File: `~/.config/opencode/opencode.json`

**Via MCP package:**

```json
{
  "mcp": {
    "th0th": {
      "type": "local",
      "command": [
        "bunx",
        "@th0th-ai/mcp-client"
      ],
      "environment": {
        "TH0TH_API_URL": "http://localhost:3333"
      },
      "enabled": true
    }
  }
}
```

**Via Plugin:**

```json
{
  "plugin": ["@th0th-ai/opencode-plugin"]
}
```

**From source (development):**

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

### VSCode / Antigravity

Create `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "th0th": {
      "command": "bunx",
        "args": ["@th0th-ai/mcp-client"],
      "env": {
        "TH0TH_API_URL": "http://localhost:3333"
      }
    }
  }
}
```

Or run `./scripts/setup-vscode.sh` for automatic configuration.

### Docker

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

---

## Available Tools

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

## REST API

```bash
# Development
bun run dev:api

# Production
bun run start:api
```

Swagger docs: `http://localhost:3333/swagger`

### Endpoints

```bash
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

---

## Configuration

Config file: `~/.config/th0th/config.json` (auto-created on first run)

### Quick Config Commands

```bash
# Show current configuration
npx @th0th-ai/mcp-client --config-show

# Show config file path
npx @th0th-ai/mcp-client --config-path

# Show config directory
npx @th0th-ai/mcp-client --config-dir

# Initialize configuration
npx @th0th-ai/mcp-client --config-init

# Show help
npx @th0th-ai/mcp-client --help
```

### Embedding Providers

| Provider | Model | Cost | Quality |
|----------|-------|------|---------|
| **Ollama** (default) | qwen3-embedding, bge-m3, nomic-embed-text | Free | Good-Excellent |
| **Mistral** | mistral-embed, codestral-embed | $$ | Great |
| **OpenAI** | text-embedding-3-small | $$ | Great |

### Advanced Configuration

For detailed configuration management, use the config CLI:

```bash
# Initialize with specific provider
npx @th0th-ai/mcp-client --config-init                          # Ollama (default)
npx @th0th-ai/mcp-client --config-init --mistral your-api-key   # Mistral
npx @th0th-ai/mcp-client --config-init --openai your-api-key    # OpenAI

# Switch provider
npx @th0th-ai/mcp-client --config-init --mistral your-api-key
npx @th0th-ai/mcp-client --config-init --ollama-model qwen3-embedding

# Set specific configuration values
npx @th0th-ai/mcp-client --config-set embedding.dimensions 4096
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `bun run build` | Build all packages |
| `bun run dev` | Development (all apps) |
| `bun run dev:api` | REST API with hot reload |
| `bun run dev:mcp` | MCP server with watch |
| `bun run start:api` | Start REST API |
| `bun run start:mcp` | Start MCP server |
| `bun run test` | Run tests |
| `bun run lint` | Lint code |
| `bun run type-check` | Type checking |
| `bun run diagnose` | Validate full stack (Ollama, database, embeddings) |

---

## Architecture

```
th0th/
├── apps/
│   ├── mcp-client/           # MCP Server (stdio)
│   ├── tools-api/            # REST API (port 3333)
│   └── opencode-plugin/      # OpenCode plugin
├── packages/
│   ├── core/                 # Business logic, search, embeddings, compression
│   └── shared/               # Shared types & utilities
└── scripts/
```

| Component | Description |
|-----------|-------------|
| **Semantic Search** | Hybrid vector + keyword with RRF ranking |
| **Embeddings** | Ollama (local) or Mistral/OpenAI API |
| **Compression** | Rule-based code structure extraction (70-98% reduction) |
| **Memory** | Persistent SQLite storage across sessions |
| **Cache** | Multi-level L1/L2 with TTL |

---

## License

MIT
