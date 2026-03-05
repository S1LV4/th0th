/**
 * Context Controller
 *
 * Orchestration layer for the "optimized context" use case.
 * Composes SearchController + MemoryController + CompressContextTool
 * + SymbolGraphService to deliver token-efficient context to agents.
 *
 * Ranking pipeline (2 phases):
 *   Phase 1 — Graph prefilter: if query looks like a symbol name,
 *             fetch structural context (definition + references) from
 *             the Symbol Graph (pure SQLite, <20ms).
 *   Phase 2 — Hybrid semantic search: vector + FTS5 + RRF, with
 *             centrality boost and graph-file boosting applied.
 */

import { logger, estimateTokens } from "@th0th-ai/shared";
import { SearchController } from "./search-controller.js";
import { MemoryController } from "./memory-controller.js";
import { CompressContextTool } from "../tools/compress_context.js";
import {
  SessionFileCache,
  REFERENCE_TOKEN_COST,
} from "../services/context/session-file-cache.js";
import { symbolGraphService } from "../services/symbol/symbol-graph.service.js";
import { TokenMetrics } from "../services/metrics/token-metrics.js";

// ── Types ────────────────────────────────────────────────────

export interface GetOptimizedContextInput {
  query: string;
  projectId: string;
  projectPath?: string;
  maxTokens?: number;
  maxResults?: number;
  workingMemoryBudget?: number;
  userId?: string;
  sessionId?: string;
  includeMemories?: boolean;
  memoryBudgetRatio?: number;
}

export interface OptimizedContextResult {
  context: string;
  sources: string[];
  resultsCount: number;
  memoriesCount: number;
  tokensSaved: number;
  compressionRatio: number;
  /** Number of file chunks skipped (reference token) or diff-only in this call. */
  sessionCacheHits: number;
  /** Tokens saved specifically by the session file cache (ref + diff-only). */
  tokensSavedBySessionCache: number;
}

// ── Controller ───────────────────────────────────────────────

export class ContextController {
  private static instance: ContextController | null = null;

  private readonly searchCtrl: SearchController;
  private readonly memoryCtrl: MemoryController;
  private readonly compressor: CompressContextTool;
  private readonly sessionCache: SessionFileCache;

  private constructor() {
    this.searchCtrl = SearchController.getInstance();
    this.memoryCtrl = MemoryController.getInstance();
    this.compressor = new CompressContextTool();
    this.sessionCache = SessionFileCache.getInstance();
  }

  static getInstance(): ContextController {
    if (!ContextController.instance) {
      ContextController.instance = new ContextController();
    }
    return ContextController.instance;
  }

  // ── Main use case ──────────────────────────────────────────

  async getOptimizedContext(
    input: GetOptimizedContextInput,
  ): Promise<OptimizedContextResult> {
    const {
      query,
      projectId,
      projectPath,
      maxTokens = 4000,
      maxResults = 5,
      workingMemoryBudget,
      userId,
      sessionId,
      includeMemories = true,
      memoryBudgetRatio = 0.2,
    } = input;

    // Budget allocation
    const clampedRatio = Math.max(0, Math.min(0.5, memoryBudgetRatio));
    const memoryTokenBudget = includeMemories
      ? Math.floor(maxTokens * clampedRatio)
      : 0;
    const codeTokenBudget = maxTokens - memoryTokenBudget;
    const wmBudget =
      workingMemoryBudget || Math.floor(codeTokenBudget * 0.8);

    logger.info("Getting optimized context", {
      query: query.slice(0, 50),
      projectId,
      maxTokens,
      includeMemories,
      memoryTokenBudget,
      codeTokenBudget,
      workingMemoryBudget: wmBudget,
    });

    // ── Phase 1: Graph prefilter (structural context) ───────────────────
    // If query looks like a symbol name (<= 60 chars, no complex phrases)
    // fetch definition + references from the Symbol Graph (SQLite, ~10ms).
    // The graph-mentioned files are passed to the semantic search as boostFiles.
    let graphContextSection = "";
    let graphBoostFiles: string[] = [];

    if (projectId && symbolGraphService.hasData(projectId) && looksLikeSymbol(query)) {
      try {
        const [defs, refs] = await Promise.all([
          symbolGraphService.goToDefinition(projectId, query),
          symbolGraphService.getReferences(projectId, query),
        ]);

        if (defs.length > 0) {
          const graphTokenBudget = Math.floor(codeTokenBudget * 0.2);
          graphContextSection = formatGraphContext(defs, refs, graphTokenBudget);
          graphBoostFiles = [
            ...new Set([
              ...defs.map((d) => d.file),
              ...refs.slice(0, 10).map((r) => r.fromFile),
            ]),
          ];

          logger.debug("Graph prefilter hit", {
            query,
            defs: defs.length,
            refs: refs.length,
            boostFiles: graphBoostFiles.length,
          });
        }
      } catch (err) {
        // Graph errors are non-fatal — fall through to semantic search only
        logger.warn("Graph prefilter failed", { query, error: (err as Error).message });
      }
    }

    // Step 1: Search code + memories in parallel
    const [searchResult, memories] = await Promise.all([
      this.searchCtrl.searchProject({
        query,
        projectId,
        projectPath,
        maxResults,
        responseMode: "full",
        autoReindex: false,
        minScore: 0.4,
        // Phase 2: boost files identified by the graph prefilter
        boostFiles: graphBoostFiles.length > 0 ? graphBoostFiles : undefined,
      }),
      includeMemories
        ? this.searchMemoriesSafe(query, {
            projectId,
            userId,
            sessionId,
            limit: 5,
          })
        : Promise.resolve([]),
    ]);

    const codeResults = searchResult.results;

    // Step 2: Build working set + memory section
    const workingSet = this.selectWorkingSet(codeResults, wmBudget);
    const memorySection = this.formatMemorySection(
      memories,
      memoryTokenBudget,
    );

    if (workingSet.length === 0 && memories.length === 0) {
      return {
        context: `No relevant code or memories found for query: "${query}"`,
        sources: [],
        resultsCount: 0,
        memoriesCount: 0,
        tokensSaved: 0,
        compressionRatio: 0,
        sessionCacheHits: 0,
        tokensSavedBySessionCache: 0,
      };
    }

    // Step 3: Build session-cache delivery plan for each code chunk
    //
    // If the caller supplies a sessionId we check each chunk against
    // SessionFileCache.  Unchanged chunks are replaced with a compact
    // reference tag; changed chunks are replaced with a diff block.  This
    // eliminates redundant re-reading of stable files across calls.
    interface DeliveryItem {
      result: any;
      kind: "full" | "ref" | "diff";
      diff?: string;
      tokensSaved: number;
    }

    let sessionCacheHits = 0;
    let tokensSavedBySessionCache = 0;

    const deliveryPlan: DeliveryItem[] = workingSet.map((r: any) => {
      if (!sessionId) {
        return { result: r, kind: "full", tokensSaved: 0 };
      }

      const content = r.content || r.preview || "";
      const key = this.sessionCache.chunkKey(
        r.filePath || "unknown",
        r.lineStart ?? 0,
        r.lineEnd ?? 0,
      );
      const check = this.sessionCache.check(sessionId, key, content);

      if (check.status === "unchanged") {
        sessionCacheHits++;
        tokensSavedBySessionCache += check.tokensSaved;
        return { result: r, kind: "ref", tokensSaved: check.tokensSaved };
      }

      if (check.status === "changed" && check.diff !== undefined) {
        sessionCacheHits++;
        tokensSavedBySessionCache += check.tokensSaved;
        return { result: r, kind: "diff", diff: check.diff, tokensSaved: check.tokensSaved };
      }

      return { result: r, kind: "full", tokensSaved: 0 };
    });

    // Step 4: Assemble raw context
    const parts: string[] = [`# Context for: ${query}\n`];

    // Prepend graph structural context if available
    if (graphContextSection) {
      parts.push(graphContextSection, "");
    }

    if (memorySection) {
      parts.push(memorySection, "");
    }

    if (deliveryPlan.length > 0) {
      const fullCount = deliveryPlan.filter((d) => d.kind === "full").length;
      const refCount  = deliveryPlan.filter((d) => d.kind === "ref").length;
      const diffCount = deliveryPlan.filter((d) => d.kind === "diff").length;

      parts.push(
        `## Code (${deliveryPlan.length} sections — ${fullCount} full, ${refCount} cached, ${diffCount} diff | WM budget: ${wmBudget} tokens)\n`,
      );

      deliveryPlan.forEach(({ result: r, kind, diff }, idx) => {
        const filePath   = r.filePath || "Unknown";
        const scoreLabel = (r.score * 100).toFixed(1);
        const lineRange  = `${r.lineStart ?? "?"}-${r.lineEnd ?? "?"}`;

        parts.push(`### ${idx + 1}. ${filePath} (score: ${scoreLabel}%)`);
        parts.push(`Lines ${lineRange}\n`);

        if (kind === "ref") {
          // Reference token — the LLM already holds this content in context
          parts.push(`[CACHED: ${filePath}:${lineRange}]\n`);
        } else if (kind === "diff" && diff) {
          // Diff-only block
          parts.push("```diff");
          parts.push(diff);
          parts.push("```\n");
        } else {
          // Full content (first delivery or session cache disabled)
          parts.push("```" + (r.language || ""));
          parts.push(r.content || r.preview || "(no content)");
          parts.push("```\n");
        }
      });
    }

    const rawContext = parts.join("\n");
    const rawTokens = estimateTokens(rawContext, "code");

    // Step 5: Compress if needed
    let finalContext = rawContext;
    let compressionRatio = 0;
    let tokensSaved = 0;

    if (rawTokens > maxTokens) {
      logger.info("Context exceeds maxTokens, compressing", {
        rawTokens,
        maxTokens,
      });

      const resp = await this.compressor.handle({
        content: rawContext,
        strategy: "code_structure",
        targetRatio: 0.6,
      });

      if (resp.success && resp.data) {
        finalContext = (resp.data as any).compressed;
        compressionRatio = resp.metadata?.compressionRatio || 0;
        tokensSaved = resp.metadata?.tokensSaved || 0;
      }
    }

    const finalTokens = estimateTokens(finalContext, "code");
    const totalTokensSaved = rawTokens - finalTokens;
    const compressionSavings = tokensSaved; // From compressor

    // Record in global TokenMetrics
    TokenMetrics.getInstance().recordContextRequest(
      rawTokens,
      finalTokens,
      tokensSavedBySessionCache,
      compressionSavings,
    );

    logger.info("Optimized context retrieved", {
      rawTokens,
      finalTokens,
      tokensSaved: totalTokensSaved,
      compressionRatio,
      codeSources: workingSet.length,
      memoriesIncluded: memories.length,
      wmBudget,
      sessionCacheHits,
      tokensSavedBySessionCache,
    });

    return {
      context: finalContext,
      sources: workingSet.map((r: any) => r.filePath || "unknown"),
      resultsCount: workingSet.length,
      memoriesCount: memories.length,
      tokensSaved: totalTokensSaved,
      compressionRatio,
      sessionCacheHits,
      tokensSavedBySessionCache,
    };
  }

  // ── Private helpers ────────────────────────────────────────

  private async searchMemoriesSafe(
    query: string,
    opts: {
      projectId: string;
      userId?: string;
      sessionId?: string;
      limit: number;
    },
  ): Promise<any[]> {
    try {
      const result = await this.memoryCtrl.search({
        query,
        projectId: opts.projectId,
        userId: opts.userId,
        sessionId: opts.sessionId,
        includePersistent: true,
        minImportance: 0.3,
        limit: opts.limit,
      });

      return result.memories;
    } catch (error) {
      logger.warn("Memory search failed, continuing without memories", {
        error: (error as Error).message,
        query: query.slice(0, 30),
      });
      return [];
    }
  }

  private formatMemorySection(
    memories: any[],
    tokenBudget: number,
  ): string | null {
    if (memories.length === 0 || tokenBudget <= 0) return null;

    const parts: string[] = [
      `## Relevant Memories (from previous sessions)\n`,
    ];
    let usedTokens = estimateTokens(parts[0], "text");

    for (const memory of memories) {
      const typeLabel = (memory.type || "unknown").toUpperCase();
      const score = memory.score
        ? ` (relevance: ${(memory.score * 100).toFixed(0)}%)`
        : "";
      const importance = memory.importance
        ? ` [importance: ${(memory.importance * 100).toFixed(0)}%]`
        : "";
      const agent = memory.agentId ? ` (by: ${memory.agentId})` : "";

      const entry = `- **[${typeLabel}]**${score}${importance}${agent}: ${memory.content}`;
      const entryTokens = estimateTokens(entry, "text");

      if (usedTokens + entryTokens > tokenBudget) break;

      parts.push(entry);
      usedTokens += entryTokens;
    }

    return parts.length <= 1 ? null : parts.join("\n");
  }

  private selectWorkingSet(results: any[], tokenBudget: number): any[] {
    if (!results.length || tokenBudget <= 0) return [];

    const selected: any[] = [];
    const selectedFiles = new Set<string>();
    let usedTokens = 0;

    const sorted = [...results].sort(
      (a, b) => (b.score || 0) - (a.score || 0),
    );

    // Pass 1: best from distinct files
    for (const result of sorted) {
      const filePath = result.filePath || "unknown";
      if (selectedFiles.has(filePath)) continue;

      const content = result.content || result.preview || "";
      const tokens = estimateTokens(content, "code");
      if (usedTokens + tokens > tokenBudget) continue;

      selected.push(result);
      selectedFiles.add(filePath);
      usedTokens += tokens;
    }

    // Pass 2: fill remaining budget
    for (const result of sorted) {
      if (selected.includes(result)) continue;

      const content = result.content || result.preview || "";
      const tokens = estimateTokens(content, "code");
      if (usedTokens + tokens > tokenBudget) continue;

      selected.push(result);
      usedTokens += tokens;
    }

    return selected;
  }
}

// ── Module-level helpers for graph prefilter ────────────────────────────────

/**
 * Heuristic: a query "looks like a symbol name" if it's short,
 * has no spaces (or at most 1 word separator), and matches identifier-like chars.
 * Examples: "ContextualSearchRLM", "searchProject", "EtlPipeline"
 */
function looksLikeSymbol(query: string): boolean {
  if (query.length > 80) return false;
  const words = query.trim().split(/\s+/);
  if (words.length > 3) return false;
  // Must look like a camelCase/PascalCase/snake_case identifier
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(words[0]);
}

/**
 * Format Symbol Graph results into a compact Markdown section.
 * Token budget capped to avoid dominating the context window.
 */
function formatGraphContext(
  defs: Array<{ name: string; kind: string; file: string; lineStart: number; lineEnd: number; docComment?: string; snippet?: string }>,
  refs: Array<{ fromFile: string; fromLine: number; refKind: string }>,
  tokenBudget: number,
): string {
  const parts: string[] = ["## Symbol Graph\n"];

  // Definitions
  if (defs.length > 0) {
    parts.push("### Definition(s)\n");
    for (const def of defs.slice(0, 3)) {
      parts.push(`- **${def.kind}** \`${def.name}\` → \`${def.file}\` L${def.lineStart}–${def.lineEnd}`);
      if (def.docComment) parts.push(`  > ${def.docComment.slice(0, 120)}`);
      if (def.snippet) {
        parts.push("  ```");
        parts.push(def.snippet.split("\n").slice(0, 8).join("\n"));
        parts.push("  ```");
      }
    }
    parts.push("");
  }

  // References summary
  if (refs.length > 0) {
    parts.push(`### References (${refs.length} total)\n`);
    // Group by file
    const byFile = new Map<string, number[]>();
    for (const r of refs.slice(0, 30)) {
      const arr = byFile.get(r.fromFile) ?? [];
      arr.push(r.fromLine);
      byFile.set(r.fromFile, arr);
    }
    for (const [file, lines] of byFile) {
      parts.push(`- \`${file}\` L${lines.join(", ")}`);
    }
    parts.push("");
  }

  const section = parts.join("\n");

  // Respect token budget (rough estimate: 4 chars/token)
  const charBudget = tokenBudget * 4;
  return section.length > charBudget ? section.slice(0, charBudget) + "\n...\n" : section;
}
