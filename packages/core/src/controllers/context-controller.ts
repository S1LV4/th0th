/**
 * Context Controller
 *
 * Orchestration layer for the "optimized context" use case.
 * Composes SearchController + MemoryController + CompressContextTool
 * to deliver token-efficient context to agents.
 */

import { logger, estimateTokens } from "@th0th/shared";
import { SearchController } from "./search-controller.js";
import { MemoryController } from "./memory-controller.js";
import { CompressContextTool } from "../tools/compress_context.js";

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
}

// ── Controller ───────────────────────────────────────────────

export class ContextController {
  private static instance: ContextController | null = null;

  private readonly searchCtrl: SearchController;
  private readonly memoryCtrl: MemoryController;
  private readonly compressor: CompressContextTool;

  private constructor() {
    this.searchCtrl = SearchController.getInstance();
    this.memoryCtrl = MemoryController.getInstance();
    this.compressor = new CompressContextTool();
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
      };
    }

    // Step 3: Assemble raw context
    const parts: string[] = [`# Context for: ${query}\n`];

    if (memorySection) {
      parts.push(memorySection, "");
    }

    if (workingSet.length > 0) {
      parts.push(
        `## Code (${workingSet.length} relevant sections, WM budget: ${wmBudget} tokens)\n`,
      );

      workingSet.forEach((r: any, idx: number) => {
        parts.push(
          `### ${idx + 1}. ${r.filePath || "Unknown"} (score: ${(r.score * 100).toFixed(1)}%)`,
        );
        parts.push(`Lines ${r.lineStart}-${r.lineEnd}\n`);
        parts.push("```" + (r.language || ""));
        parts.push(r.content || r.preview || "(no content)");
        parts.push("```\n");
      });
    }

    const rawContext = parts.join("\n");
    const rawTokens = estimateTokens(rawContext, "code");

    // Step 4: Compress if needed
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
    });

    return {
      context: finalContext,
      sources: workingSet.map((r: any) => r.filePath || "unknown"),
      resultsCount: workingSet.length,
      memoriesCount: memories.length,
      tokensSaved: rawTokens - finalTokens,
      compressionRatio,
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
