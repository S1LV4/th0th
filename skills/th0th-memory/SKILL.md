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
| 3 | `th0th_search` | Semantic search — use `responseMode:"enriched"` to get content + imports + parentSymbol in one call |
| 4 | `th0th_read_file` | Read specific lines of a file with symbol metadata and imports — **use instead of Read/grep for focused reads** |
| 5 | `th0th_optimized_context` | Search + compress in one call (max token efficiency) |
| 6 | `th0th_search_definitions` | Find symbol definitions (functions, classes, types) |
| 7 | `th0th_get_references` | Find all usages of a symbol across the project |
| 8 | `th0th_go_to_definition` | Jump to a symbol's definition with code snippet |
| 9 | `th0th_project_map` | One-shot project overview: stats, top central files (PageRank backbone), symbols by kind, files by language — use before deep search to orient yourself |
| 10 | `th0th_list_projects` | List all indexed projects and their status |
| 11 | `th0th_reset_project` | Delete all indexed data for a project (vectors, symbols, memories) |
| 12 | `th0th_synapse_session` | Create/resume a Synapse cognitive session — returns sessionId to pass on every search |
| 13 | `th0th_synapse_prime` | Seed session buffer with recalled memories before searching |
| 14 | `th0th_synapse_access` | Record file access for affinity scoring (boosts that file in future searches) |
| 15 | `th0th_symbol_snippet` | Get raw code snippet by file + line range (faster than read_file for known locations) |
| 16 | `th0th_memory_list` | Browse stored memories by type/importance (auditing, not semantic search) |
| 17 | `th0th_reindex` | Force full reindex of a project (when autoReindex is too slow) |
| 18 | `th0th_remember` | Store important information in persistent memory |
| 19 | `th0th_recall` | Retrieve memories from previous sessions |
| 20 | `th0th_compress` | Reduce context size (70-98%) |
| 21 | `th0th_analytics` | Usage patterns and metrics |
| 22 | Glob/Grep/Read | **Last resort only** — use th0th tools above first |

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
  minScore: 0.5,             // validated default — real scores cluster 0.6-0.9
  responseMode: "enriched",  // recommended: content + fileImports + parentSymbol
  autoReindex: false,        // set true to auto-refresh stale index
  explainScores: false,      // set true for vector/keyword/RRF breakdown
  include: ["src/**/*.ts"],
  exclude: ["**/*.test.*"]
})
```

**responseMode — choose based on need:**
- `"enriched"` (**recommended for dev assistance**) — full chunk content + `fileImports` (all imports of the file) + `parentSymbol` (enclosing function/class) + `chunkIndex`/`totalChunks`. Eliminates most follow-up Read/grep calls for context.
- `"summary"` (default) — signature preview only; use when scanning many results for the right file.
- `"full"` — full content without enrichment metadata.

**After a search result, navigate without grep:**
- Need adjacent code? Use `chunkIndex` and `totalChunks` from the result — adjacent chunks have IDs `projectId:filePath:chunkIndex±1`.
- Need the full function? Check `totalChunks` — if > 1, the function spans multiple chunks. Use `th0th_read_file` with `lineStart`/`lineEnd` from the result.
- Need callers? Use `th0th_get_references` with `symbolName` from `parentSymbol`.

### 4. th0th_read_file

Read specific lines of a file with symbol metadata and imports — **use this instead of the native Read tool or Bash grep** when you have a file path and line range from a search result.

```
th0th_read_file({
  filePath: "src/services/search.ts",
  projectId: "my-project",
  lineStart: 45,      // from search result lineStart (optionally subtract 5-10 for context)
  lineEnd: 80,        // from search result lineEnd (optionally add 5-10 for context)
  includeSymbols: true,   // returns symbol definitions/references in this range
  includeImports: true    // returns import statements at top of file
})
```

**Why use this instead of Read/grep:**
- Returns `imports[]` (all file imports) and `symbols{}` (definitions + references in range)
- Handles compression automatically for large reads
- Respects th0th caching — repeated reads of the same range are instant

### 5. th0th_optimized_context

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

### 6. th0th_search_definitions

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

### 7. th0th_get_references

Find all usages of a symbol across the project. Returns file paths, line numbers, reference kinds (`call`, `import`, `type_ref`, `extend`, `implement`), and code context.

```
th0th_get_references({
  projectId: "my-project",
  symbolName: "UserService",
  fqn: "services/user.ts#UserService",  // disambiguates when name is shared
  limit: 50
})
```

### 8. th0th_go_to_definition

Jump to a symbol's definition. Disambiguates using calling file context.

```
th0th_go_to_definition({
  projectId: "my-project",
  symbolName: "getPrismaClient",
  fromFile: "src/controllers/search-controller.ts"
})
```

### 9. th0th_project_map

One-shot architectural overview of an indexed project. Use this **before diving into search** on an unfamiliar codebase — gives you the backbone in one call.

Returns:
- **Stats**: total files, chunks, symbols, last indexed
- **Top central files**: PageRank backbone (files most depended on — start here)
- **Symbols by kind**: count of functions, classes, interfaces, types
- **Files by language**: distribution across extensions
- **Recently indexed files**: what changed last

```
th0th_project_map({
  projectId: "my-project",
  topFiles: 20,       // top central files to show (default 20)
  recentFiles: 10     // most recently indexed files (default 10)
})
```

**When to use:** starting a new task in an unfamiliar project → call `th0th_project_map` first, then `th0th_search` for specifics.

### 10. th0th_list_projects

List all indexed projects and their current status.

```
th0th_list_projects({
  status: "all"   // pending | indexing | indexed | error | all
})
```

### 10. th0th_reset_project

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

### 11. th0th_remember

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

### 12. th0th_recall

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

### 13. th0th_compress

Compress context (keeps structure, removes details).

```
th0th_compress({
  content: "...large code...",
  strategy: "code_structure",
  targetRatio: 0.7,
  language: "typescript"
})
```

### 14. th0th_analytics

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

## Memory Types & Tiers

| Type | Tier | Use |
|------|------|-----|
| `critical` | Semantic | Hard constraints, env secrets, non-negotiable rules |
| `decision` | Semantic | Architecture decisions with rationale |
| `pattern` | Semantic | Recurring patterns discovered through work |
| `code` | Episodic | Code patterns found in a specific session |
| `conversation` | Episodic | Key conversation points, resolved ambiguities |
| *(tagged `working`)* | Working | Short-lived task state — tag `working`, low importance |
| *(tagged `procedure`)* | Procedural | How-to steps that recur across projects |

**Tier guidance:**
- **Working**: ephemeral (current task state). Tag: `working`. Importance ≤ 0.5.
- **Episodic**: session discoveries. Importance 0.5–0.7.
- **Semantic**: cross-session facts that compound. Importance ≥ 0.7.
- **Procedural**: reusable recipes. Tag: `procedure`. Importance ≥ 0.7.

## Memory Importance Rubric

**Never set importance by gut feel.** Use this 5-question rubric — base is 0.50:

| Question | If YES → add |
|----------|-------------|
| 1. Would forgetting this cause a bug or wrong decision? | +0.15 |
| 2. Affects more than one module/service? | +0.10 |
| 3. A future agent would choose wrong without this? | +0.15 |
| 4. Took significant effort to discover (hours, not minutes)? | +0.10 |
| 5. Is this a hard constraint, not a preference? | +0.10 |

**Named levels:** CRITICAL ≥ 0.95 · HIGH ≥ 0.80 · MEDIUM ≥ 0.70 · LOW ≥ 0.60 · SKIP < 0.60

**Examples:**
- "Auth uses short-lived JWT + refresh token (15 min TTL)" → 0.95 (CRITICAL — all 5 yes)
- "Team prefers async/await over .then()" → 0.60 (LOW — preference, not constraint)
- "SQLite fails on concurrent writes > 50/s" → 0.85 (HIGH — hard constraint, multi-module)
- "Found that lazy-loading reduces TTI by 40%" → 0.70 (MEDIUM — 1+3+4)

## Session Management

**Always pass `sessionId` to `th0th_search`, `th0th_remember`, and `th0th_recall`.**

**Name sessions by intent:**
```
debug-[entity]       → "debug-auth-middleware"
feature-[entity]     → "feature-payment-flow"
refactor-[entity]    → "refactor-search-pipeline"
review-[entity]      → "review-pr-142"
explore-[entity]     → "explore-onboarding-flow"
```

**Session rules:**
- Reuse the same `sessionId` across ALL turns of a task (don't generate a new one each call)
- At task END: call `th0th_remember` with decisions, patterns, and unresolved issues found
- At task START: call `th0th_recall` with the same topic before doing any search

## Decision Flow

```
Need to find code?
  → th0th_search with responseMode:"enriched" (preferred — returns content + imports + parentSymbol)
  → responseMode:"summary" if scanning many results to locate the right file
  → Glob/Grep/Read — LAST RESORT ONLY, after th0th_search returned nothing useful

Got a search result and need more context?
  → result already has fileImports (imports of the file) and parentSymbol (enclosing function/class)
  → Need surrounding lines? → th0th_read_file(filePath, lineStart-10, lineEnd+10)  [NOT Read/grep]
  → Need callers of this function? → th0th_get_references(symbolName=parentSymbol)
  → Function spans multiple chunks? → th0th_read_file with full lineStart..lineEnd range
  → NEVER grep just to see surrounding lines or imports — enriched mode already has them

Need to navigate symbols?
  → th0th_go_to_definition (jump to definition with code snippet)
  → th0th_get_references (find all usages — replaces grep for symbol search)
  → th0th_search_definitions (list all matching symbols by name/kind)

Need to read a specific file section?
  → th0th_read_file(filePath, lineStart, lineEnd) — returns content + symbols + imports
  → Do NOT use Read/grep when you have file + line numbers from a search result

Starting work on an unfamiliar project?
  → th0th_project_map (one-shot overview: backbone files, symbol counts, languages)
  → th0th_recall (check memories from prior sessions)
  → th0th_search with responseMode:"enriched" (dive into specifics)

Need to understand architecture?
  → th0th_project_map (central files by PageRank = dependency backbone)
  → th0th_search_definitions (enumerate public API by kind)
  → th0th_recall (check stored decisions)

Debugging an issue?
  → th0th_recall("debug [component]") FIRST — check if this was investigated before
  → Only pursue hypotheses NOT already ruled out in prior sessions
  → After resolving: th0th_remember with what the root cause was AND what was ruled out
  → NEVER re-investigate a hypothesis without recalling prior attempts first

Found important pattern/decision?
  → Score importance with the 5-question rubric above (never pick a float by feel)
  → th0th_remember with sessionId, type="decision"|"pattern", calibrated importance
  → Tag constraints as `critical`, preferences as `pattern`

Task complete? — Evidence gate (don't just say "done"):
  → Tests pass / build succeeds → show output
  → If code changed: verify the changed artifact exists and compiles
  → th0th_remember any decisions/blockers/patterns discovered during the task

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

Starting a multi-step task (debugging, code review, refactor)?
  → th0th_synapse_session(taskContext="<one sentence>", workspaceId="<projectId>") → get sessionId
  → th0th_recall("<topic>") → th0th_synapse_prime(id=sessionId, results=[...recalled])
  → Pass sessionId as synapseSessionId on every th0th_search call
  → After reading/editing a file: th0th_synapse_access(id=sessionId, filePath="...")
  → On task end: th0th_remember(sessionId=sessionId, ...) to persist discoveries

Want to audit stored knowledge?
  → th0th_memory_list(projectId="...", type="decision") — browse all decisions
  → th0th_memory_list(minImportance=0.8) — browse only critical/high memories

Index is stale after large refactor?
  → th0th_reindex(id="<projectId>") — full reindex (use when autoReindex misses > 50 files)
```

## Companion Skill: synapse-usage

For multi-step tasks where the same files and concepts will reappear across
several searches, layer the **synapse-usage** skill on top of these tools.
Synapse is th0th's cognitive modulation layer — it does not replace
`th0th_search` or `th0th_optimized_context`; it sits between RRF and the
caller, modulating which results survive and in what order.

**When to combine:** any task with ≥2 related searches in the same
conversation. Synapse opens a session, primes a working-memory buffer with
known-relevant memories (from `th0th_recall`), and applies per-query the
attention, chain, diversity, temporal, and confidence-gate filters.

**Integration point with the tools above:**

| th0th tool | How synapse-usage extends it |
|------------|------------------------------|
| `th0th_search` / `th0th_optimized_context` | Pass `synapseSessionId` — server runs the full Synapse pipeline automatically |
| `th0th_recall` | Use returned memories to `prime` the Synapse buffer at session start |
| `th0th_go_to_definition`, `th0th_get_references` | Call `/session/:id/prefetch` with the resolved `filePath` to warm the buffer before the next search |
| `th0th_remember` (decision) | Reference the new memory id in `/session/:id/access` so future agent-affinity scoring favors it |

See `skills/synapse-usage/SKILL.md` for the full lifecycle, REST endpoints,
decision flow, and pitfalls.

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
