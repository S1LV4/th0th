---
name: th0th-memory
description: Mandatory rules for using th0th semantic search, compression, memory, and symbol graph tools. Prioritize th0th tools over native tools (Glob, Grep, Read) to explore and understand code. Triggers on tasks involving code search, context compression, storing decisions, symbol navigation, or retrieving project knowledge.
license: MIT
metadata:
  author: S1LV4
  version: "2.0.0"
---

# th0th-memory Skill

Mandatory rules for using th0th tools. Prioritize semantic search, compression, memory, and symbol graph tools over native tools (Glob, Grep, Read) to explore and understand code.

## When to Apply

Reference these guidelines when:
- Searching for code patterns or implementations
- Navigating to symbol definitions or finding all usages of a symbol
- Understanding codebase architecture
- Storing important decisions or patterns
- Compressing large code contexts
- Retrieving memories from previous sessions
- Listing or checking the status of indexed projects
- Analyzing usage and performance metrics

## Available Tools

| Priority | Tool | Use |
|----------|------|-----|
| 1 | `th0th_index` | Index project before searching (returns jobId for background jobs) |
| 2 | `th0th_index_status` | Poll background indexing job status by jobId |
| 3 | `th0th_search` | Semantic + keyword search with filters |
| 4 | `th0th_optimized_context` | Search + compress in one call (max token efficiency) |
| 5 | `th0th_search_definitions` | Find symbol definitions (functions, classes, types) |
| 6 | `th0th_get_references` | Find all usages of a symbol across the project |
| 7 | `th0th_go_to_definition` | Jump to a symbol's definition with context |
| 8 | `th0th_list_projects` | List all indexed projects and their status |
| 9 | `th0th_reset_project` | Delete all indexed data for a project (vectors, symbols, memories) |
| 10 | `th0th_remember` | Store important information in persistent memory |
| 11 | `th0th_recall` | Retrieve memories from previous sessions |
| 12 | `th0th_compress` | Reduce context size (70-98%) |
| 13 | `th0th_analytics` | Usage patterns and metrics |
| 14 | Glob/Grep/Read | Only when th0th doesn't find what you need |

## Tool Reference

### 1. th0th_index

Index a project directory for semantic search. Returns immediately with a `jobId`; polling is optional (use `th0th_index_status`).

```
th0th_index({
  projectPath: "/home/user/my-project",
  projectId: "my-project",
  forceReindex: false,
  warmCache: true,
  warmupQueries: ["authentication", "database schema"]
})
```

### 2. th0th_index_status

Poll a background indexing job by the `jobId` returned from `th0th_index`.

```
th0th_index_status({
  jobId: "job_abc123"
})
```

**CRITICAL — polling discipline (mandatory):**

Never call `th0th_index_status` in a tight loop. Choose one strategy:

**Strategy A — single Bash sleep loop (preferred for normal tasks):**
```bash
# TH0TH_API_URL is set by the MCP server environment; falls back to localhost:3333
TH0TH_API_URL="${TH0TH_API_URL:-http://localhost:3333}"

for i in $(seq 1 40); do
  result=$(curl -s "$TH0TH_API_URL/api/v1/project/index/status/JOB_ID")
  status=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['status'])")
  progress=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'].get('progress',0))")
  echo "[$i] status=$status progress=$progress%"
  [ "$status" = "completed" ] || [ "$status" = "failed" ] && break
  sleep 15
done
```

**Strategy B — ScheduleWakeup (only inside /loop mode):**
```
ScheduleWakeup({ delaySeconds: 30, reason: "waiting for th0th indexing job JOB_ID", prompt: "<<autonomous-loop-dynamic>>" })
```
Then on the next wake-up call `th0th_index_status` once and repeat or finish.

**Never do this:**
```
# BAD: calling th0th_index_status repeatedly in successive turns without sleeping
th0th_index_status(...)  # turn 1
th0th_index_status(...)  # turn 2 — WRONG, wastes context and burns turns
th0th_index_status(...)  # turn 3 — WRONG
```

### 3. th0th_search

Semantic + keyword search with RRF (Reciprocal Rank Fusion).

```
th0th_search({
  query: "JWT authentication middleware",
  projectId: "my-project",
  maxResults: 10,
  minScore: 0.3,
  responseMode: "summary",   // "summary" saves ~70% tokens vs "full"
  autoReindex: false,        // set true to auto-refresh stale index
  explainScores: false,      // set true for vector/keyword/RRF breakdown
  include: ["src/**/*.ts"],
  exclude: ["**/*.test.*"]
})
```

**responseMode:**
- `"summary"` (default) — returns preview only; saves ~70% tokens.
- `"full"` — includes full file content; use when you need to read code.

### 4. th0th_optimized_context

Search + compress in one call. Maximum token efficiency.

**Always pass `sessionId`** to activate the session file cache. On repeated calls within the same conversation, unchanged file chunks are replaced with a compact reference token (~8 tokens) instead of full content, saving 50-70% of input tokens in long sessions.

```
th0th_optimized_context({
  query: "how does authentication work?",
  projectId: "my-project",
  sessionId: "<stable identifier for the current conversation>",
  maxTokens: 4000,
  maxResults: 5
})
```

The response includes `metadata.tokensSavedBySessionCache` and `data.sessionCacheHits` so you can observe the savings.

### 5. th0th_search_definitions

Find symbol definitions (functions, classes, variables, types, interfaces, exports) in an indexed project.

```
th0th_search_definitions({
  projectId: "my-project",
  query: "UserService",       // substring match, case-insensitive
  kind: "class,function",    // comma-separated: function,class,variable,type,interface,export
  file: "src/services/user.ts",
  exportedOnly: false,
  limit: 20
})
```

### 6. th0th_get_references

Find all usages of a symbol across the project. Returns file paths, line numbers, reference kinds (`call`, `import`, `type_ref`, `extend`, `implement`), and code context.

```
th0th_get_references({
  projectId: "my-project",
  symbolName: "UserService",
  fqn: "services/user.ts#UserService",  // disambiguates when name is shared
  limit: 50
})
```

### 7. th0th_go_to_definition

Jump to a symbol's definition. Disambiguates using calling file context.

```
th0th_go_to_definition({
  projectId: "my-project",
  symbolName: "getPrismaClient",
  fromFile: "src/controllers/search-controller.ts"
})
```

### 8. th0th_list_projects

List all indexed projects and their current status.

```
th0th_list_projects({
  status: "all"   // pending | indexing | indexed | error | all
})
```

### 9. th0th_reset_project

Delete all indexed data for a project. Each scope is independent and defaults to `true`.

```
th0th_reset_project({
  projectId: "my-project",
  clearVectors: true,    // remove vector embeddings (semantic search index)
  clearSymbols: true,    // remove symbol graph (definitions, references, imports, centrality)
  clearMemories: true    // remove stored memories for this project
})
```

**When to use:**
- Before a full reindex to ensure a clean slate (`th0th_reset_project` → `th0th_index`)
- To free space from a project that is no longer needed
- To clear stale data after a major refactor

**Response includes:** `vectorsDeleted`, `symbolsCleared`, `memoriesDeleted` counts.

### 10. th0th_remember

Store important information in persistent memory.

```
th0th_remember({
  content: "Using PostgreSQL for user data",
  type: "decision",
  importance: 0.8,
  tags: ["database", "architecture"],
  projectId: "my-project",
  sessionId: "session-123",
  agentId: "architect",
  format: "toon"   // "json" or "toon"
})
```

### 11. th0th_recall

Search stored memories from previous sessions.

```
th0th_recall({
  query: "database decisions",
  types: ["decision"],
  limit: 10,
  minImportance: 0.3,
  projectId: "my-project",
  agentId: "architect",
  includePersistent: true,
  format: "toon"
})
```

### 12. th0th_compress

Compress context (keeps structure, removes details).

```
th0th_compress({
  content: "...large code...",
  strategy: "code_structure",
  targetRatio: 0.7,
  language: "typescript"
})
```

### 13. th0th_analytics

Usage patterns, cache performance, metrics.

```
th0th_analytics({
  type: "summary",   // summary | project | query | cache | recent
  projectId: "my-project",
  limit: 10
})
```

## Compression Strategies

| Strategy | Use Case | Reduction |
|----------|----------|-----------|
| `code_structure` | Source code | 70-90% |
| `conversation_summary` | Chat history | 80-95% |
| `semantic_dedup` | Repetitive content | 50-70% |
| `hierarchical` | Structured docs | 60-80% |

## Memory Types

| Type | Use |
|------|-----|
| `critical` | Critical user-defined facts |
| `conversation` | Important conversation points |
| `code` | Code patterns discovered |
| `decision` | Architecture decisions |
| `pattern` | Recurring patterns |

## Decision Flow

```
Need to find code?
  → th0th_search with responseMode:"summary" (first)
  → Glob/Grep/Read (fallback only)

Need to navigate symbols?
  → th0th_go_to_definition (jump to definition)
  → th0th_get_references (find all usages)
  → th0th_search_definitions (list matching symbols)

Need to understand architecture?
  → th0th_recall (check memories first)
  → th0th_search (explore code)
  → th0th_search_definitions (enumerate public API)

Found important pattern/decision?
  → th0th_remember (store for future sessions)

Context too large?
  → th0th_compress (reduce tokens)

Maximum efficiency needed?
  → th0th_optimized_context (search + compress + session cache)

Need to check indexed projects?
  → th0th_list_projects (see status, file counts, last indexed)

Indexing taking long?
  → th0th_index_status (poll jobId from th0th_index)
  → WAIT between polls: use a single Bash sleep loop (15s intervals) or ScheduleWakeup in /loop mode
  → NEVER call th0th_index_status in successive turns without sleeping first

Need a clean slate before reindexing?
  → th0th_reset_project (wipe vectors + symbols + memories)
  → th0th_index (reindex from scratch)
```

## Installation

### One-command (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/S1LV4/th0th/main/install.sh | bash
```

Supports three modes (select interactively or override with `TH0TH_MODE`):

| Mode | `TH0TH_MODE` | Requirements | Best for |
|------|--------------|--------------|---------|
| Docker | `docker` | Docker | Production, quick start |
| Docker build | `build` | Docker + Git | Custom builds, local changes |
| From source | `source` | Git + Bun | Development, contributors |

Non-interactive example:

```bash
TH0TH_MODE=docker TH0TH_API_PORT=4000 TH0TH_NO_START=1 \
  curl -fsSL https://raw.githubusercontent.com/S1LV4/th0th/main/install.sh | bash
```

## Configuration

Config file: `~/.config/th0th/config.json` (auto-created on first run)

### Embedding Providers

| Provider | Default Model | Dimensions | Cost |
|----------|---------------|------------|------|
| **Ollama** (default) | `bge-m3` | 1024 | Free |
| Ollama alt | `qwen3-embedding` | 4096 | Free |
| **Mistral** | `mistral-embed` | — | $$ |
| **OpenAI** | `text-embedding-3-small` | — | $$ |

### Quick Config Commands

```bash
npx @th0th-ai/mcp-client --config-show                          # print current config
npx @th0th-ai/mcp-client --config-path                          # show config file path
npx @th0th-ai/mcp-client --config-init                          # init with Ollama defaults
npx @th0th-ai/mcp-client --config-init --mistral YOUR_KEY       # init with Mistral
npx @th0th-ai/mcp-client --config-init --openai YOUR_KEY        # init with OpenAI
npx @th0th-ai/mcp-client --config-init --ollama-model bge-m3    # switch Ollama model
npx @th0th-ai/mcp-client --config-set embedding.dimensions 1024 # set specific value
```

### Validate Stack

```bash
bun run diagnose   # checks Ollama, database, embeddings, migration status
```

## Deployment Notes

- **Docker mode**: PostgreSQL + auto-migration via entrypoint script on container startup. Uses `bge-m3` / 1024d by default.
- **Source mode**: SQLite via `prisma-adapter-bun-sqlite`. Run `bun run diagnose` after setup.
- **WSL / Linux**: Ollama connectivity via `host.docker.internal:host-gateway` in `docker-compose.yml`.
- **PostgreSQL**: Set `DATABASE_URL=postgresql://...` and `POSTGRES_PASSWORD`. Migrations run automatically on `docker compose up`.
