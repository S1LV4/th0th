/**
 * Context Controller
 *
 * Orchestration layer for the "optimized context" use case.
 * Composes SearchController + MemoryController + CompressContextTool
 * to deliver token-efficient context to agents.
 */

import { logger, estimateTokens } from "@th0th-ai/shared";
import { SearchController } from "./search-controller.js";
import { MemoryController } from "./memory-controller.js";
import { CompressContextTool } from "../tools/compress_context.js";
import {
  SessionFileCache,
  REFERENCE_TOKEN_COST,
} from "../services/context/session-file-cache.js";

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

    logger.info("Optimized context retrieved", {
      rawTokens,
      finalTokens,
      tokensSaved: rawTokens - finalTokens,
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
      tokensSaved: rawTokens - finalTokens,
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
