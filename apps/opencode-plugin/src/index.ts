import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { configExists, initConfig, loadConfig } from "@th0th/shared/config"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TH0TH_API_URL = process.env.TH0TH_API_URL || "http://localhost:3333"
const FETCH_TIMEOUT_MS = 5_000
const REINDEX_DEBOUNCE_MS = 60_000
const REINDEX_FILE_THRESHOLD = 15
const MAX_EDITED_FILES_TRACKED = 200

// ---------------------------------------------------------------------------
// Auto-configuration
// ---------------------------------------------------------------------------

function ensureConfig(): void {
  if (!configExists()) {
    initConfig()
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  th0th initialized with default configuration                  ║
║                                                                ║
║  Config: ~/.config/th0th/config.json                           ║
║  Provider: Ollama (local, free)                                ║
║                                                                ║
║  To change provider:                                           ║
║    npx th0th-config use mistral --api-key YOUR_KEY             ║
║    npx th0th-config use openai --api-key YOUR_KEY              ║
╚═══════════════════════════════════════════════════════════════╝
`)
  }
}

// ---------------------------------------------------------------------------
// HTTP client with timeout + abort
// ---------------------------------------------------------------------------

async function th0thFetch<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${TH0TH_API_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`th0th ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function th0thGet<T = unknown>(
  endpoint: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${TH0TH_API_URL}${endpoint}`, {
      method: "GET",
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`th0th ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const Th0thPlugin: Plugin = async ({ project, directory, worktree, client }: PluginInput) => {
  // Auto-configure on first run
  ensureConfig()
  
  const config = loadConfig()
  
  const projectId = project?.id || directory?.split("/").pop() || "default"
  const projectPath = worktree || directory

  // Per-plugin-instance state
  const editedFiles = new Set<string>()
  let reindexTimer: ReturnType<typeof setTimeout> | null = null
  let reindexInFlight = false
  let apiAvailable = true

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function log(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
    client.app.log({
      body: { service: "th0th", level, message, extra },
    }).catch(() => {})
  }

  function toast(message: string, variant: "success" | "error" | "info" = "info") {
    client.tui.showToast({
      body: { message: `[th0th] ${message}`, variant },
    }).catch(() => {})
  }

  function fireAndForget(endpoint: string, body: Record<string, unknown>, label: string) {
    th0thFetch(endpoint, body).catch((err) => {
      log("warn", `${label} failed`, { error: err instanceof Error ? err.message : String(err) })
    })
  }

  function scheduleReindex() {
    if (!apiAvailable || reindexInFlight) return
    if (reindexTimer) clearTimeout(reindexTimer)

    reindexTimer = setTimeout(async () => {
      if (reindexInFlight) return
      reindexInFlight = true
      const count = editedFiles.size
      try {
        await th0thFetch("/api/v1/project/index", {
          projectPath,
          projectId,
          forceReindex: false,
          warmCache: false,
        })
        editedFiles.clear()
        log("info", `Incremental reindex completed (${count} files changed)`)
      } catch (err) {
        log("warn", "Reindex failed", { error: err instanceof Error ? err.message : String(err) })
      } finally {
        reindexInFlight = false
        reindexTimer = null
      }
    }, REINDEX_DEBOUNCE_MS)
  }

  function trackFile(filePath: string | undefined) {
    if (!filePath || typeof filePath !== "string") return
    if (editedFiles.size >= MAX_EDITED_FILES_TRACKED) return
    editedFiles.add(filePath)
    if (editedFiles.size >= REINDEX_FILE_THRESHOLD) {
      scheduleReindex()
    }
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  return {
    tool: {
      "th0th_search": tool({
        description:
          "Semantic code search in indexed project. Uses hybrid vector + keyword search with RRF ranking. Returns relevant code snippets with file paths and line numbers.",
        args: {
          query: tool.schema.string().describe("Search query (natural language or keywords)"),
          maxResults: tool.schema.number().optional().default(10).describe("Max results to return"),
          minScore: tool.schema.number().optional().default(0.3).describe("Minimum relevance score (0-1)"),
          include: tool.schema.array(tool.schema.string()).optional().describe("Glob patterns to include"),
          exclude: tool.schema.array(tool.schema.string()).optional().describe("Glob patterns to exclude"),
        },
        async execute(args, ctx: ToolContext) {
          const result = await th0thFetch("/api/v1/search/project", {
            query: args.query,
            projectId,
            projectPath: ctx.worktree || projectPath,
            maxResults: args.maxResults ?? 10,
            minScore: args.minScore ?? 0.3,
            responseMode: "summary",
            autoReindex: true,
            include: args.include,
            exclude: args.exclude,
          })
          return JSON.stringify(result)
        },
      }),

      "th0th_remember": tool({
        description:
          "Store important information in th0th memory. Persists across sessions. Use for: user preferences, architectural decisions, discovered patterns.",
        args: {
          content: tool.schema.string().describe("Content to store"),
          type: tool.schema.enum(["preference", "conversation", "code", "decision", "pattern"]).describe("Memory type"),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Tags for categorization"),
          importance: tool.schema.number().min(0).max(1).optional().default(0.5).describe("Importance 0-1"),
        },
        async execute(args, ctx: ToolContext) {
          const result = await th0thFetch("/api/v1/memory/store", {
            content: args.content,
            type: args.type,
            projectId,
            sessionId: ctx.sessionID,
            agentId: ctx.agent,
            tags: args.tags,
            importance: args.importance ?? 0.5,
            format: "toon",
          })
          return JSON.stringify(result)
        },
      }),

      "th0th_recall": tool({
        description:
          "Search stored memories from previous sessions. Recovers decisions, patterns, and context.",
        args: {
          query: tool.schema.string().describe("What to remember"),
          types: tool.schema.array(tool.schema.enum(["preference", "conversation", "code", "decision", "pattern"])).optional().describe("Filter by type"),
          limit: tool.schema.number().optional().default(10).describe("Max results"),
          minImportance: tool.schema.number().optional().default(0.3).describe("Minimum importance"),
        },
        async execute(args, ctx: ToolContext) {
          const result = await th0thFetch("/api/v1/memory/search", {
            query: args.query,
            projectId,
            sessionId: ctx.sessionID,
            types: args.types,
            limit: args.limit ?? 10,
            minImportance: args.minImportance ?? 0.3,
            includePersistent: true,
            format: "toon",
          })
          return JSON.stringify(result)
        },
      }),

      "th0th_index": tool({
        description:
          "Index the current project for semantic search. Async - returns jobId.",
        args: {
          forceReindex: tool.schema.boolean().optional().default(false).describe("Force full reindex"),
          warmCache: tool.schema.boolean().optional().default(true).describe("Pre-cache common queries"),
        },
        async execute(args, ctx: ToolContext) {
          toast("Indexing project...", "info")
          const result = await th0thFetch("/api/v1/project/index", {
            projectPath: ctx.worktree || projectPath,
            projectId,
            forceReindex: args.forceReindex ?? false,
            warmCache: args.warmCache ?? true,
          }, 15_000)
          toast("Indexing started", "success")
          return JSON.stringify(result)
        },
      }),

      "th0th_compress": tool({
        description:
          "Compress context using semantic compression. Keeps structure, removes details. 70-98% token reduction.",
        args: {
          content: tool.schema.string().describe("Content to compress"),
          strategy: tool.schema.enum(["code_structure", "conversation_summary", "semantic_dedup", "hierarchical"]).optional().default("code_structure"),
          targetRatio: tool.schema.number().min(0).max(1).optional().default(0.7).describe("Compression ratio (0.7 = 70% reduction)"),
          language: tool.schema.string().optional().describe("Programming language"),
        },
        async execute(args) {
          const result = await th0thFetch("/api/v1/context/compress", {
            content: args.content,
            strategy: args.strategy ?? "code_structure",
            targetRatio: args.targetRatio ?? 0.7,
            language: args.language,
          }, 10_000)
          return JSON.stringify(result)
        },
      }),

      "th0th_optimized_context": tool({
        description:
          "Search + compress in one call. Maximum token efficiency for limited context budgets.",
        args: {
          query: tool.schema.string().describe("Search query"),
          maxTokens: tool.schema.number().optional().default(4000).describe("Max tokens in result"),
          maxResults: tool.schema.number().optional().default(5).describe("Max search results"),
        },
        async execute(args, ctx: ToolContext) {
          const result = await th0thFetch("/api/v1/context/optimized", {
            query: args.query,
            projectId,
            projectPath: ctx.worktree || projectPath,
            maxTokens: args.maxTokens ?? 4000,
            maxResults: args.maxResults ?? 5,
          }, 10_000)
          return JSON.stringify(result)
        },
      }),

      "th0th_index_status": tool({
        description:
          "Check the status and progress of an async indexing job. Use the jobId returned by th0th_index.",
        args: {
          jobId: tool.schema.string().describe("Job ID returned by th0th_index"),
        },
        async execute(args) {
          const result = await th0thGet(`/api/v1/project/index/status/${encodeURIComponent(args.jobId)}`)
          return JSON.stringify(result)
        },
      }),

      "th0th_analytics": tool({
        description: "Get th0th usage analytics and performance metrics.",
        args: {
          type: tool.schema.enum(["summary", "project", "cache", "recent"]).optional().default("summary"),
          limit: tool.schema.number().optional().default(10),
        },
        async execute(args) {
          const result = await th0thFetch("/api/v1/analytics/", {
            type: args.type ?? "summary",
            projectId,
            limit: args.limit ?? 10,
          })
          return JSON.stringify(result)
        },
      }),
    },

    // -----------------------------------------------------------------------
    // Events - typed to real Hooks interface
    // -----------------------------------------------------------------------

    // Health check + auto-index on session start
    "session.created": async () => {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3_000)
        const res = await fetch(`${TH0TH_API_URL}/health`, { signal: controller.signal })
        clearTimeout(timer)
        apiAvailable = res.ok
        if (apiAvailable) {
          log("info", `Connected to th0th API at ${TH0TH_API_URL}`)
        } else {
          toast("th0th API unhealthy", "error")
        }
      } catch {
        apiAvailable = false
        log("warn", `th0th API unreachable at ${TH0TH_API_URL}`)
      }
    },

    // Capture git operations after bash execution
    // Hooks interface: tool.execute.after(input: { tool, sessionID, callID, args }, output: { title, output, metadata })
    "tool.execute.after": async (input, output) => {
      if (!apiAvailable) return
      if (input.tool !== "bash") return

      const cmd = String(input.args?.command || "")
      if (!cmd.includes("git commit") && !cmd.includes("git merge") && !cmd.includes("git rebase")) return

      const result = String(output.output || "").slice(0, 300)
      fireAndForget("/api/v1/memory/store", {
        content: `Git: ${cmd.slice(0, 200)}\nResult: ${result}`,
        type: "code",
        projectId,
        sessionId: input.sessionID,
        tags: ["git"],
        importance: 0.6,
        format: "toon",
      }, "git-capture")
    },

    // Compaction: fetch real memories and inject as context
    // Hooks interface: experimental.session.compacting(input: { sessionID }, output: { context: string[], prompt?: string })
    "experimental.session.compacting": async (input, output) => {
      if (!apiAvailable) return

      try {
        const memories = await th0thFetch<{ results?: Array<{ content: string }> }>(
          "/api/v1/memory/search",
          {
            query: `project ${projectId} preferences decisions patterns`,
            projectId,
            sessionId: input.sessionID,
            limit: 5,
            minImportance: 0.5,
            includePersistent: true,
            format: "toon",
          },
          3_000,
        )

        if (memories?.results?.length) {
          const memoryText = memories.results
            .map((m, i) => `${i + 1}. ${m.content}`)
            .join("\n")
          output.context.push(`## th0th - Persistent Memories\n${memoryText}`)
        }
      } catch (err) {
        log("debug", "Failed to fetch memories for compaction", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },

    // Inject th0th env vars into shell
    // Hooks interface: shell.env(input: { cwd, sessionID?, callID? }, output: { env })
    "shell.env": async (_input, output) => {
      output.env.TH0TH_PROJECT_ID = projectId
      output.env.TH0TH_PROJECT_PATH = projectPath
      output.env.TH0TH_API_URL = TH0TH_API_URL
    },

    // Unified event handler for file tracking + LSP diagnostics
    event: async ({ event }) => {
      // Track file edits for incremental reindex
      if (event.type === "file.edited") {
        trackFile(event.properties.file)
        return
      }
      if (event.type === "file.watcher.updated") {
        trackFile(event.properties.file)
        return
      }

      // LSP diagnostics: track persistent errors
      if (!apiAvailable) return
      if (event.type !== "lsp.client.diagnostics") return

      const props = event.properties as { path?: string; diagnostics?: Array<{ severity?: number; message?: string }> }
      const errors = props.diagnostics?.filter(d => d.severity === 1) || []
      if (errors.length === 0) return

      // Only track files with 3+ errors (persistent problems)
      if (errors.length >= 3) {
        const file = props.path || "unknown"
        const messages = errors.slice(0, 3).map(e => e.message).join("; ")
        fireAndForget("/api/v1/memory/store", {
          content: `LSP errors in ${file}: ${messages} (${errors.length} total)`,
          type: "pattern",
          projectId,
          tags: ["lsp", "error", "diagnostics"],
          importance: 0.4,
          format: "toon",
        }, "lsp-diagnostics")
      }
    },
  }
}

export default Th0thPlugin
