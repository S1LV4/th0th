/**
 * Tool Definitions for MCP Client
 *
 * Define as ferramentas expostas ao MCP host (OpenCode/Claude)
 * e o mapeamento para endpoints da Tools API.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  apiEndpoint: string;
  apiMethod: "GET" | "POST";
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "th0th_index",
    description:
      "Index a project directory for contextual code search with semantic embeddings",
    apiEndpoint: "/api/v1/project/index",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Absolute path to the project directory to index",
        },
        projectId: {
          type: "string",
          description:
            "Unique identifier for the project (defaults to directory name)",
        },
        forceReindex: {
          type: "boolean",
          description: "Force reindex even if project already exists",
          default: false,
        },
        warmCache: {
          type: "boolean",
          description:
            "Pre-cache common queries after indexing for faster initial searches",
          default: false,
        },
        warmupQueries: {
          type: "array",
          items: { type: "string" },
          description:
            "Custom queries to pre-cache (uses defaults if not provided)",
        },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "th0th_index_status",
    description:
      "Get the status of a background indexing job by its jobId. Use this after calling th0th_index to check progress.",
    apiEndpoint: "/api/v1/project/index/status/:jobId",
    apiMethod: "GET",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Job ID returned from th0th_index",
        },
      },
      required: ["jobId"],
    },
  },
  {
    name: "th0th_search",
    description:
      "Search for code in an indexed project using semantic and keyword search",
    apiEndpoint: "/api/v1/search/project",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (natural language or keywords)",
        },
        projectId: { type: "string", description: "Project ID to search in" },
        projectPath: {
          type: "string",
          description: "Project path (required for autoReindex)",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return",
          default: 10,
        },
        minScore: {
          type: "number",
          description: "Minimum relevance score (0-1)",
          default: 0.3,
        },
        responseMode: {
          type: "string",
          enum: ["summary", "full"],
          description:
            "Response format: 'summary' (preview only, saves 70% tokens) or 'full' (includes content)",
          default: "summary",
        },
        autoReindex: {
          type: "boolean",
          description:
            "Automatically reindex if project index is stale (can increase latency)",
          default: false,
        },
        include: {
          type: "array",
          items: { type: "string" },
          description:
            "Glob patterns to include (e.g., ['src/components/**/*.tsx', 'src/utils/**'])",
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description:
            "Glob patterns to exclude (e.g., ['**/*.test.*', '**/*.spec.*'])",
        },
        explainScores: {
          type: "boolean",
          description:
            "Include detailed score breakdown (vector, keyword, RRF components)",
          default: false,
        },
      },
      required: ["query", "projectId"],
    },
  },
  {
    name: "th0th_remember",
    description:
      "Store memory in the hierarchical memory system (local SQLite)",
    apiEndpoint: "/api/v1/memory/store",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to store" },
        type: {
          type: "string",
          enum: ["critical", "conversation", "code", "decision", "pattern"],
          description: "Type of memory",
        },
        userId: { type: "string", description: "User ID" },
        projectId: { type: "string", description: "Project ID" },
        sessionId: { type: "string", description: "Session ID" },
        agentId: {
          type: "string",
          description:
            "Agent ID (e.g., orchestrator, implementer, architect, optimizer)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization",
        },
        importance: {
          type: "number",
          description: "Importance score (0-1)",
          default: 0.5,
        },
        format: {
          type: "string",
          enum: ["json", "toon"],
          description: "Output format (json or toon)",
          default: "toon",
        },
      },
      required: ["content", "type"],
    },
  },
  {
    name: "th0th_recall",
    description:
      "Search stored memories across sessions using semantic search (recovers context from previous conversations)",
    apiEndpoint: "/api/v1/memory/search",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (what to remember)",
        },
        userId: { type: "string", description: "Filter by user ID" },
        projectId: { type: "string", description: "Filter by project ID" },
        sessionId: { type: "string", description: "Filter by session ID" },
        agentId: {
          type: "string",
          description:
            "Filter by agent ID (orchestrator, implementer, architect, optimizer)",
        },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: ["critical", "conversation", "code", "decision", "pattern"],
          },
          description: "Filter by memory types",
        },
        limit: {
          type: "number",
          description: "Maximum results to return",
          default: 10,
        },
        minImportance: {
          type: "number",
          description: "Minimum importance (0-1)",
          default: 0.3,
        },
        includePersistent: {
          type: "boolean",
          description: "Include persistent memories from other sessions",
          default: true,
        },
        format: {
          type: "string",
          enum: ["json", "toon"],
          description: "Output format (json or toon)",
          default: "toon",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "th0th_compress",
    description:
      "Compress context using semantic compression (keeps structure, removes details)",
    apiEndpoint: "/api/v1/context/compress",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to compress" },
        strategy: {
          type: "string",
          enum: [
            "code_structure",
            "conversation_summary",
            "semantic_dedup",
            "hierarchical",
          ],
          description: "Compression strategy",
          default: "code_structure",
        },
        targetRatio: {
          type: "number",
          description:
            "Target compression ratio (0-1, e.g., 0.7 = 70% reduction)",
          default: 0.7,
        },
        language: {
          type: "string",
          description: "Programming language (for code compression)",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "th0th_optimized_context",
    description:
      "Retrieve and compress context with maximum token efficiency (search + compress)",
    apiEndpoint: "/api/v1/context/optimized",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find relevant context",
        },
        projectId: {
          type: "string",
          description: "Project ID for code context",
        },
        projectPath: {
          type: "string",
          description: "Project path (for auto-reindex)",
        },
        maxTokens: {
          type: "number",
          description: "Maximum tokens in returned context",
          default: 4000,
        },
        maxResults: {
          type: "number",
          description: "Maximum search results to include",
          default: 5,
        },
      },
      required: ["query", "projectId"],
    },
  },
  {
    name: "th0th_analytics",
    description:
      "Get search analytics and performance metrics (usage patterns, cache performance, etc)",
    apiEndpoint: "/api/v1/analytics",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["summary", "project", "query", "cache", "recent"],
          description:
            "Type of analytics: 'summary' (overall), 'project' (specific project), 'query' (specific query), 'cache' (cache performance), 'recent' (recent searches)",
        },
        projectId: {
          type: "string",
          description: "Project ID (required for type='project' or 'cache')",
        },
        query: {
          type: "string",
          description: "Search query (required for type='query')",
        },
        limit: {
          type: "number",
          description:
            "Limit for results (default: 10 for most, 50 for recent)",
          default: 10,
        },
      },
        required: ["type"],
    },
  },

  // ── Symbol Graph tools ──────────────────────────────────────────────────

  {
    name: "th0th_list_projects",
    description:
      "List all indexed projects with their status (pending/indexing/indexed/error), file counts, symbol counts, and last indexed time.",
    apiEndpoint: "/api/v1/workspace/list",
    apiMethod: "GET",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "indexing", "indexed", "error", "all"],
          description: "Filter by workspace status. Defaults to 'all'.",
          default: "all",
        },
      },
    },
  },

  {
    name: "th0th_search_definitions",
    description:
      "Search for symbol definitions (functions, classes, variables, types, interfaces) in an indexed project. Returns name, kind, file location, line numbers, and doc comments.",
    apiEndpoint: "/api/v1/symbol/definitions",
    apiMethod: "GET",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The project ID to search in",
        },
        query: {
          type: "string",
          description: "Substring search on symbol name (case-insensitive)",
        },
        kind: {
          type: "string",
          description: "Comma-separated symbol kinds to filter: function,class,variable,type,interface,export",
        },
        file: {
          type: "string",
          description: "Filter by file path (relative to project root)",
        },
        exportedOnly: {
          type: "boolean",
          description: "Return only exported symbols",
          default: false,
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 20)",
          default: 20,
        },
      },
      required: ["projectId"],
    },
  },

  {
    name: "th0th_get_references",
    description:
      "Find all references (usages) of a symbol across the project. Returns file paths, line numbers, reference kinds (call/import/type_ref/extend/implement), and code context snippets.",
    apiEndpoint: "/api/v1/symbol/references",
    apiMethod: "GET",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The project ID to search in",
        },
        symbolName: {
          type: "string",
          description: "Name of the symbol to find references for",
        },
        fqn: {
          type: "string",
          description:
            "Fully-qualified name (e.g. 'services/search/rlm.ts#ContextualSearchRLM') to disambiguate when multiple definitions share the same name",
        },
        limit: {
          type: "number",
          description: "Maximum references to return (default: 50)",
          default: 50,
        },
      },
      required: ["projectId", "symbolName"],
    },
  },

  {
    name: "th0th_go_to_definition",
    description:
      "Find the definition of a symbol (function, class, variable, type, etc.) in the project. Disambiguates by calling file context. Returns file location, line numbers, doc comment, and code snippet.",
    apiEndpoint: "/api/v1/symbol/definition",
    apiMethod: "GET",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The project ID to search in",
        },
        symbolName: {
          type: "string",
          description: "Name of the symbol to find the definition for",
        },
        fromFile: {
          type: "string",
          description:
            "Relative path of the file where the symbol is used. Helps prioritize the correct definition when multiple exist.",
        },
      },
      required: ["projectId", "symbolName"],
    },
  },

  // ── File read ────────────────────────────────────────────────────────────

  {
    name: "th0th_read_file",
    description:
      "Read a specific file (or line range) with automatic compression, import extraction, and symbol metadata. " +
      "Use this instead of the native Read tool or Bash grep when you have a filePath and lineStart/lineEnd from a th0th_search result — " +
      "returns structured imports[], symbol definitions/references, and optionally compressed content. " +
      "Pass lineStart/lineEnd to read only the relevant section (saves tokens).",
    apiEndpoint: "/api/v1/file/read",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "File path (absolute, or relative to project root)",
        },
        projectId: {
          type: "string",
          description: "Project ID for symbol metadata (optional but recommended)",
        },
        lineStart: {
          type: "number",
          description: "First line to read, 1-indexed (default: start of file). Subtract 5-10 from search result lineStart for context.",
        },
        lineEnd: {
          type: "number",
          description: "Last line to read, 1-indexed (default: end of file). Add 5-10 to search result lineEnd for context.",
        },
        compress: {
          type: "boolean",
          description: "Auto-compress content > 100 lines to reduce tokens (default: true)",
          default: true,
        },
        includeSymbols: {
          type: "boolean",
          description: "Include symbol definitions and references in the read range (default: true)",
          default: true,
        },
        includeImports: {
          type: "boolean",
          description: "Extract and return the file's import statements (default: true)",
          default: true,
        },
      },
      required: ["filePath"],
    },
  },

  // ── Project reset ───────────────────────────────────────────────────────

  {
    name: "th0th_reset_project",
    description:
      "Delete all indexed data for a project: vector embeddings, symbol graph (definitions/references/imports/centrality), and stored memories. " +
      "Use before a full reindex or to free space. Each scope (vectors, symbols, memories) can be toggled independently.",
    apiEndpoint: "/api/v1/project/reset",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The project ID to reset",
        },
        clearVectors: {
          type: "boolean",
          description: "Delete vector embeddings used for semantic search (default: true)",
          default: true,
        },
        clearSymbols: {
          type: "boolean",
          description: "Delete symbol graph: definitions, references, imports, file index, centrality scores (default: true)",
          default: true,
        },
        clearMemories: {
          type: "boolean",
          description: "Delete stored memories for this project (default: true)",
          default: true,
        },
      },
      required: ["projectId"],
    },
  },

  // ── Synapse session management ───────────────────────────────────────────

  {
    name: "th0th_synapse_session",
    description:
      "Create (or resume) a Synapse cognitive session for a multi-step task. " +
      "Returns a sessionId to pass as `synapseSessionId` on every subsequent th0th_search call. " +
      "The session activates task alignment, agent affinity, the working-memory buffer, " +
      "chain inhibition, and the adaptive confidence gate. " +
      "Name sessions by intent: 'debug-auth', 'feature-payment', 'refactor-search'.",
    apiEndpoint: "/api/v1/synapse/session",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Reuse an existing session ID (omit to auto-generate). Use same ID across all turns of a task.",
        },
        agentId: { type: "string", description: "Stable agent identifier (e.g. 'claude-code')", default: "claude-code" },
        workspaceId: { type: "string", description: "Project ID this session is scoped to" },
        taskContext: { type: "string", description: "One-sentence description of the current task (used for task alignment scoring)" },
        ttlMs: { type: "number", description: "Session TTL in ms (default: 15 min)", default: 900000 },
      },
      required: [],
    },
  },

  {
    name: "th0th_synapse_prime",
    description:
      "Seed the Synapse working-memory buffer with known-relevant results before searching. " +
      "Call this at the start of a session with results from th0th_recall to warm the buffer — " +
      "subsequent th0th_search calls will boost these results automatically.",
    apiEndpoint: "/api/v1/synapse/session/:id/prime",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Session ID from th0th_synapse_session" },
        results: {
          type: "array",
          description: "Array of search results to seed into the buffer (from th0th_recall or th0th_search)",
          items: { type: "object" },
        },
      },
      required: ["id", "results"],
    },
  },

  {
    name: "th0th_synapse_access",
    description:
      "Record that the agent accessed a specific file/chunk during this session. " +
      "Increases agent-affinity score for that file in future searches — results from " +
      "frequently-accessed files get boosted. Call after reading or editing a file.",
    apiEndpoint: "/api/v1/synapse/session/:id/access",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Session ID from th0th_synapse_session" },
        memoryId: { type: "string", description: "Memory/chunk ID that was accessed (from search result id field)" },
        filePath: { type: "string", description: "File path that was accessed (alternative to memoryId)" },
      },
      required: ["id"],
    },
  },

  // ── Symbol snippet ───────────────────────────────────────────────────────

  {
    name: "th0th_symbol_snippet",
    description:
      "Get the source code snippet for a specific file and line range from an indexed project. " +
      "Faster than th0th_read_file when you already know the exact location — returns raw content without compression.",
    apiEndpoint: "/api/v1/symbol/snippet",
    apiMethod: "GET",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        file: { type: "string", description: "Relative file path" },
        lineStart: { type: "number", description: "Start line (1-indexed, default: 1)" },
        lineEnd: { type: "number", description: "End line (default: entire file)" },
      },
      required: ["projectId", "file"],
    },
  },

  // ── Memory list ──────────────────────────────────────────────────────────

  {
    name: "th0th_memory_list",
    description:
      "Browse stored memories for a project without a semantic query — useful when you want to " +
      "see all decisions, patterns, or critical facts stored for a project. " +
      "Use th0th_recall for semantic search, th0th_memory_list for browsing/auditing.",
    apiEndpoint: "/api/v1/memory/list",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Filter by project ID" },
        type: { type: "string", description: "Filter by memory type: critical | decision | pattern | code | conversation" },
        minImportance: { type: "number", description: "Minimum importance score (0-1, default: 0)" },
        limit: { type: "number", description: "Max results to return (default: 50)", default: 50 },
        offset: { type: "number", description: "Pagination offset (default: 0)", default: 0 },
      },
      required: [],
    },
  },

  // ── Workspace reindex ────────────────────────────────────────────────────

  {
    name: "th0th_reindex",
    description:
      "Force a full reindex of a project workspace — re-scans all files, regenerates embeddings, " +
      "and rebuilds the symbol graph. Use when files have changed significantly and autoReindex " +
      "on th0th_search is too slow (autoReindex only syncs up to 50 files at a time).",
    apiEndpoint: "/api/v1/workspace/:id/reindex",
    apiMethod: "POST",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project ID to reindex" },
        forceReindex: {
          type: "boolean",
          description: "Clear existing index before reindexing (default: false — incremental)",
          default: false,
        },
      },
      required: ["id"],
    },
  },
];

/**
 * Get tool definition by name
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}
