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
  responseMode?: "summary" | "full";
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
  preview: string;
  explanation?: string;
  content?: string;
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
      minScore = 0.3,  // Reverted to 0.3: new algorithm produces more distributed scores
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
      const base: FormattedResult = {
        id: r.id,
        score: r.score,
        filePath: r.metadata?.filePath,
        lineStart: r.metadata?.lineStart,
        lineEnd: r.metadata?.lineEnd,
        language: r.metadata?.language,
        preview: this.generatePreview(r, query),  // Passar query para gerar preview contextual
        ...(r.explanation && { explanation: r.explanation }),
      };

      if (responseMode === "full") {
        base.content = r.content;
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
      recommendations.push("Use Read(file, lineStart, lineEnd) for specific code snippets (60% token savings)");

      if (formattedResults.length >= 3) {
        recommendations.push("Use th0th_optimized_context(query) for compressed multi-file context");
      }
    }

    if (responseMode === "full") {
      recommendations.push("Full mode uses ~3x more tokens. Consider summary mode + Read() for better efficiency");
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

  generatePreview(result: any, query?: string): string {
    if (result.metadata?.context?.preview) {
      return result.metadata.context.preview;
    }

    const content = result.content || "";
    const lines = content
      .split("\n")
      .filter((l: string) => l.trim().length > 0);

    if (lines.length === 0) return "(empty)";

    // Se temos uma query, tentar encontrar linhas que contenham termos relevantes
    if (query) {
      const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      
      // Primeiro, tentar encontrar linhas que contenham termos da query
      for (const line of lines) {
        const lowerLine = line.toLowerCase();
        const hasQueryTerm = queryTerms.some(term => lowerLine.includes(term));
        
        if (hasQueryTerm) {
          const trimmed = line.trim();
          if (trimmed.length > 0 && !trimmed.startsWith("import ")) {
            return trimmed.length > 150
              ? trimmed.substring(0, 147) + "..."
              : trimmed;
          }
        }
      }
    }

    // Fallback: primeira linha significativa
    const significantLine =
      lines.find((l: string) => {
        const t = l.trim();
        return (
          !t.startsWith("import ") &&
          !t.startsWith("//") &&
          !t.startsWith("/*") &&
          !t.startsWith("*")
        );
      }) || lines[0];

    const preview = significantLine.trim();
    return preview.length > 150
      ? preview.substring(0, 147) + "..."
      : preview;
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
