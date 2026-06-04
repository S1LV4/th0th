/**
 * Search Controller
 *
 * Orchestration layer for project search operations.
 * Extracts preview generation, glob filtering, and auto-reindex
 * coordination from the SearchProjectTool.
 */

import { logger } from "@th0th-ai/shared";
import { ContextualSearchRLM } from "../services/search/contextual-search-rlm.js";
import { minimatch } from "minimatch";

// ── Types ────────────────────────────────────────────────────

export interface ProjectSearchInput {
  query: string;
  projectId: string;
  projectPath?: string;
  maxResults?: number;
  minScore?: number;
  /**
   * - "summary": preview only (~70% token savings vs full)
   * - "full": includes complete chunk content
   * - "enriched": full content + fileImports + parentSymbol — best for dev assistance,
   *   eliminates most grep/read_file calls for context
   */
  responseMode?: "summary" | "full" | "enriched";
  autoReindex?: boolean;
  include?: string[];
  exclude?: string[];
  explainScores?: boolean;
  /**
   * Files to boost in ranking (from Symbol Graph prefilter).
   * Results whose filePath is in this list get score * 1.3.
   */
  boostFiles?: string[];
}

export interface ProjectSearchResult {
  query: string;
  projectId: string;
  responseMode: string;
  tokenSavings: string;
  indexStatus: any;
  recommendations: string[];
  filters: {
    applied: boolean;
    include: string[];
    exclude: string[];
    totalResults: number;
    filteredResults: number;
  };
  results: FormattedResult[];
}

interface FormattedResult {
  id: string;
  score: number;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  language?: string;
  /** Full function/class signature (or first meaningful line) — no 150-char truncation */
  preview: string;
  explanation?: string;
  /** Full chunk content (responseMode full or enriched) */
  content?: string;
  /** Enclosing function/class name — pre-computed at index time */
  parentSymbol?: string;
  /** Top-level imports of the file — pre-computed at index time, eliminates grep for context */
  fileImports?: string;
  /** Index of this chunk within the file (0-based) */
  chunkIndex?: number;
  /** Total chunks in the file */
  totalChunks?: number;
}

// ── Controller ───────────────────────────────────────────────

export class SearchController {
  private static instance: SearchController | null = null;
  private contextualSearch: ContextualSearchRLM;

  private constructor() {
    this.contextualSearch = new ContextualSearchRLM();
  }

  static getInstance(): SearchController {
    if (!SearchController.instance) {
      SearchController.instance = new SearchController();
    }
    return SearchController.instance;
  }

  /** Expose the underlying search engine for direct use by ContextController. */
  getSearchEngine(): ContextualSearchRLM {
    return this.contextualSearch;
  }

  // ── Main search use case ───────────────────────────────────

  async searchProject(input: ProjectSearchInput): Promise<ProjectSearchResult> {
    const {
      query,
      projectId,
      projectPath,
      maxResults = 10,
      minScore = Number(process.env.SEARCH_MIN_SCORE ?? "0.3"),
      responseMode = "summary",
      autoReindex = false,
      include,
      exclude,
      explainScores = false,
      boostFiles,
    } = input;

    const startTime = Date.now();

    logger.info("Starting project search", {
      query,
      projectId,
      maxResults,
      autoReindex,
      explainScores,
    });

    // Auto-reindex if requested
    let reindexInfo = null;
    if (autoReindex && projectPath) {
      reindexInfo = await this.handleAutoReindex(projectId, projectPath);
    }

    // Execute search
    const results = await this.contextualSearch.search(query, projectId, {
      maxResults,
      minScore,
      explainScores,
    });

    logger.info("Project search completed", {
      projectId,
      resultCount: results.length,
      totalLatencyMs: Date.now() - startTime,
    });

    // Apply glob filters
    const filteredResults = this.filterByPatterns(results, include, exclude);

    if (filteredResults.length < results.length) {
      logger.info("Results filtered by patterns", {
        before: results.length,
        after: filteredResults.length,
        include,
        exclude,
      });
    }

    // Apply centrality/graph boost: files identified by Symbol Graph prefilter
    // get a 30% score multiplier, then re-sort
    const boostedResults = boostFiles && boostFiles.length > 0
      ? this.applyBoost(filteredResults, boostFiles)
      : filteredResults;

    // Format results
    const formattedResults = boostedResults.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const base: FormattedResult = {
        id: r.id,
        score: r.score,
        filePath: meta.filePath as string,
        lineStart: meta.lineStart as number | undefined,
        lineEnd: meta.lineEnd as number | undefined,
        language: meta.language as string | undefined,
        preview: this.generatePreview(r, query),
        chunkIndex: meta.chunkIndex as number | undefined,
        totalChunks: meta.totalChunks as number | undefined,
      };
      if (meta.parentSymbol) base.parentSymbol = meta.parentSymbol as string;
      if (r.explanation) base.explanation = r.explanation;

      if (responseMode === "full" || responseMode === "enriched") {
        base.content = r.content;
      }
      if (responseMode === "enriched") {
        if (meta.fileImports) base.fileImports = meta.fileImports as string;
      }

      return base;
    });

    // Generate intelligent recommendations
    const recommendations: string[] = [];
    
    // Add reindex recommendations
    if ((reindexInfo as any)?.deferred) {
      recommendations.push("Indexing deferred to keep this search responsive");
      recommendations.push("Run th0th_index(projectPath, projectId) and poll th0th_get_index_status(jobId)");
    }

    // Add usage recommendations based on response mode
    if (responseMode === "summary" && formattedResults.length > 0) {
      recommendations.push(
        "Use responseMode='enriched' to get full content + file imports + parentSymbol without extra tool calls"
      );
      if (formattedResults.length >= 3) {
        recommendations.push("Use th0th_optimized_context(query) for compressed multi-file context");
      }
    }

    if (responseMode === "full") {
      recommendations.push(
        "Try responseMode='enriched' — same content plus fileImports and parentSymbol, same token cost"
      );
    }

    if (responseMode === "enriched" && formattedResults.length > 0) {
      recommendations.push(
        "Enriched mode: content + fileImports + parentSymbol included. Use chunkIndex/totalChunks to navigate adjacent chunks."
      );
    }

    // Add project-specific recommendations
    if (formattedResults.length === 0) {
      recommendations.push("Try lowering minScore (current: " + minScore + ") or different query terms");
      recommendations.push("Check if project is indexed: th0th_list_projects()");
    }

    return {
      query,
      projectId,
      responseMode,
      tokenSavings: responseMode === "summary" ? "~70% vs full mode" : "none",
      indexStatus: reindexInfo || { wasStale: false, reindexed: false },
      recommendations,
      filters: {
        applied:
          (include && include.length > 0) ||
          (exclude && exclude.length > 0) ||
          false,
        include: include || [],
        exclude: exclude || [],
        totalResults: results.length,
        filteredResults: filteredResults.length,
      },
      results: formattedResults,
    };
  }

  // ── Helpers ────────────────────────────────────────────────

  private async handleAutoReindex(
    projectId: string,
    projectPath: string,
  ): Promise<any> {
    const freshnessStart = Date.now();
    const info = await this.contextualSearch.ensureFreshIndex(
      projectId,
      projectPath,
      { allowFullReindex: false, maxSyncFiles: 50 },
    );

    logger.info("Index freshness check completed", {
      projectId,
      latencyMs: Date.now() - freshnessStart,
      wasStale: info.wasStale,
      reindexed: info.reindexed,
      reason: info.reason,
      deferred: (info as any).deferred || false,
      filesPending: (info as any).filesPending || 0,
    });

    return info;
  }

  generatePreview(result: any, _query?: string): string {
    // Priority: pre-computed preview stored during addContextToResults
    if (result.metadata?.context?.preview) return result.metadata.context.preview;

    const content = result.content || "";
    const allLines = content.split("\n");
    if (!allLines.some((l: string) => l.trim())) return "(empty)";

    const lang = (result.metadata?.language as string) || "";
    const isCode = /^(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|dart|cpp|c|cs|rb|php)$/.test(lang);

    if (isCode) {
      // Skip chunker-injected headers (// File: / // Section: / repeated labels)
      const bodyLines = allLines.filter((l: string) => {
        const t = l.trim();
        return t && !t.startsWith("// File:") && !t.startsWith("// Section:");
      });

      // Collect up to 8 lines of the function/class signature (up to and including
      // the line ending with `{`, `=>`, or `;`). This gives the AI the full
      // signature — parameters, return type, generics — without truncation.
      const sigLines: string[] = [];
      for (const line of bodyLines) {
        const t = line.trim();
        // Skip pure comment/decorator lines at the top
        if (sigLines.length === 0 && (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("@"))) continue;
        // Skip bare import lines
        if (sigLines.length === 0 && t.startsWith("import ")) continue;
        sigLines.push(line.trimEnd());
        // Signature ends at `{`, `=>`, or `;` — covers functions, arrow fns, interfaces
        if (t.endsWith("{") || t.endsWith("=>") || t.endsWith(";") || t.endsWith(",")) {
          if (t.endsWith("{") || t.endsWith("=>") || t.endsWith(";")) break;
        }
        if (sigLines.length >= 8) break;
      }
      if (sigLines.length > 0) return sigLines.join("\n");
    }

    // Non-code (or unknown language): skip imports and comments, truncate at 150 chars.
    const meaningful = allLines.find((l: string) => {
      const t = l.trim();
      return (
        t &&
        !t.startsWith("import ") &&
        !t.startsWith("//") &&
        !t.startsWith("#") &&
        !t.startsWith("/*") &&
        !t.startsWith("*")
      );
    }) || allLines.find((l: string) => l.trim()) || allLines[0];
    const preview = meaningful.trimEnd();
    return preview.length > 150 ? preview.substring(0, 147) + "..." : preview;
  }

  filterByPatterns(
    results: any[],
    include?: string[],
    exclude?: string[],
  ): any[] {
    return results.filter((result) => {
      const filePath = result.metadata?.filePath || "";
      if (!filePath) return true;

      if (exclude && exclude.length > 0) {
        for (const pattern of exclude) {
          if (minimatch(filePath, pattern)) return false;
        }
      }

      if (include && include.length > 0) {
        for (const pattern of include) {
          if (minimatch(filePath, pattern)) return true;
        }
        return false;
      }

      return true;
    });
  }

  /**
   * Apply a 30% score boost to results whose filePath is in boostFiles.
   * Re-sorts by boosted score descending.
   */
  applyBoost(results: any[], boostFiles: string[]): any[] {
    const boostSet = new Set(boostFiles);
    const BOOST_FACTOR = 1.3;

    return results
      .map((r) => {
        const filePath = r.metadata?.filePath || r.filePath || "";
        const boosted = boostSet.has(filePath)
          ? { ...r, score: Math.min(1, r.score * BOOST_FACTOR) }
          : r;
        return boosted;
      })
      .sort((a, b) => b.score - a.score);
  }
}
