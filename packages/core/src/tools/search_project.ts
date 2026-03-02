/**
 * Search Project Tool
 *
 * Contextual search on an indexed project using
 * hybrid search (vector + keyword) with RRF.
 */

import { IToolHandler } from "@th0th/shared";
import { ToolResponse } from "@th0th/shared";
import { ContextualSearchRLM } from "../services/search/contextual-search-rlm.js";
import { logger } from "@th0th/shared";
import { minimatch } from "minimatch";

interface SearchProjectParams {
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
}

export class SearchProjectTool implements IToolHandler {
  name = "search_project";
  description =
    "Search for code in an indexed project using semantic and keyword search";
  inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (natural language or keywords)",
      },
      projectId: {
        type: "string",
        description: "Project ID to search in",
      },
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
        description: "Response format: 'summary' (preview only, saves 70% tokens) or 'full' (includes content)",
        default: "summary",
      },
      autoReindex: {
        type: "boolean",
        description: "Automatically reindex if project index is stale (can increase latency)",
        default: false,
      },
      include: {
        type: "array",
        items: { type: "string" },
        description: "Glob patterns to include (e.g., ['src/components/**/*.tsx', 'src/utils/**'])",
      },
      exclude: {
        type: "array",
        items: { type: "string" },
        description: "Glob patterns to exclude (e.g., ['**/*.test.*', '**/*.spec.*'])",
      },
      explainScores: {
        type: "boolean",
        description: "Include detailed score breakdown (vector, keyword, RRF components)",
        default: false,
      },
    },
    required: ["query", "projectId"],
  };

  private contextualSearch: ContextualSearchRLM;

  constructor() {
    this.contextualSearch = new ContextualSearchRLM();
  }

  /**
   * Generate a concise one-line preview from search result
   */
  private generatePreview(result: any): string {
    // If metadata has a preview, use it
    if (result.metadata?.context?.preview) {
      return result.metadata.context.preview;
    }

    // Otherwise, create a smart preview from content
    const content = result.content || "";
    const lines = content.split("\n").filter((l: string) => l.trim().length > 0);
    
    if (lines.length === 0) return "(empty)";
    
    // Find first significant line (skip imports/comments)
    const significantLine = lines.find((l: string) => {
      const trimmed = l.trim();
      return !trimmed.startsWith("import ") && 
             !trimmed.startsWith("//") && 
             !trimmed.startsWith("/*") &&
             !trimmed.startsWith("*");
    }) || lines[0];

    // Truncate to 100 chars
    const preview = significantLine.trim();
    return preview.length > 100 ? preview.substring(0, 97) + "..." : preview;
  }

  /**
   * Filter results by include/exclude glob patterns
   */
  private filterByPatterns(
    results: any[],
    include?: string[],
    exclude?: string[]
  ): any[] {
    return results.filter((result) => {
      const filePath = result.metadata?.filePath || "";
      
      if (!filePath) return true; // Keep results without filePath
      
      // Check exclude patterns first
      if (exclude && exclude.length > 0) {
        for (const pattern of exclude) {
          if (minimatch(filePath, pattern)) {
            return false; // Exclude this result
          }
        }
      }
      
      // Check include patterns
      if (include && include.length > 0) {
        for (const pattern of include) {
          if (minimatch(filePath, pattern)) {
            return true; // Include this result
          }
        }
        return false; // No include pattern matched
      }
      
      return true; // No filters, include by default
    });
  }

  async handle(params: unknown): Promise<ToolResponse> {
    const {
      query,
      projectId,
      projectPath,
      maxResults = 10,
      minScore = 0.3,
      responseMode = "summary",
      autoReindex = false,
      include,
      exclude,
      explainScores = false,
    } = params as SearchProjectParams;

    try {
      const startTime = Date.now();

      logger.info("Starting project search", {
        query,
        projectId,
        maxResults,
        autoReindex,
        explainScores,
      });

      // Check index freshness and reindex if needed
      let reindexInfo = null;
      if (autoReindex && projectPath) {
        const freshnessStart = Date.now();
        reindexInfo = await this.contextualSearch.ensureFreshIndex(
          projectId,
          projectPath,
          {
            allowFullReindex: false,
            maxSyncFiles: 50,
          },
        );

        logger.info("Index freshness check completed", {
          projectId,
          latencyMs: Date.now() - freshnessStart,
          wasStale: reindexInfo.wasStale,
          reindexed: reindexInfo.reindexed,
          reason: reindexInfo.reason,
          deferred: (reindexInfo as any).deferred || false,
          filesPending: (reindexInfo as any).filesPending || 0,
        });

        if (reindexInfo.reindexed) {
          logger.info("Index was stale and reindexed", {
            projectId,
            reason: reindexInfo.reason,
          });
        } else if ((reindexInfo as any).deferred) {
          logger.warn("Reindex deferred to avoid request timeout", {
            projectId,
            reason: reindexInfo.reason,
            filesPending: (reindexInfo as any).filesPending || 0,
            hint: "Use th0th_index + th0th_get_index_status for full indexing",
          });
        }
      }

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

      // Apply glob pattern filtering
      const filteredResults = this.filterByPatterns(results, include, exclude);
      
      if (filteredResults.length < results.length) {
        logger.info("Results filtered by patterns", {
          before: results.length,
          after: filteredResults.length,
          include,
          exclude,
        });
      }

      // Format results based on response mode
      const formattedResults = filteredResults.map((r) => {
        const baseResult = {
          id: r.id,
          score: r.score,
          filePath: r.metadata?.filePath,
          lineStart: r.metadata?.lineStart,
          lineEnd: r.metadata?.lineEnd,
          language: r.metadata?.language,
          preview: this.generatePreview(r),
          ...(r.explanation && { explanation: r.explanation }),
        };

        // Only include full content in 'full' mode
        if (responseMode === "full") {
          return {
            ...baseResult,
            content: r.content,
          };
        }

        return baseResult;
      });

      return {
        success: true,
        data: {
          query,
          projectId,
          responseMode,
          tokenSavings: responseMode === "summary" ? "~70% vs full mode" : "none",
          indexStatus: reindexInfo || { wasStale: false, reindexed: false },
          recommendations:
            (reindexInfo as any)?.deferred
              ? [
                  "Indexing deferred to keep this search responsive",
                  "Run th0th_index(projectPath, projectId) and poll th0th_get_index_status(jobId)",
                ]
              : [],
          filters: {
            applied: (include && include.length > 0) || (exclude && exclude.length > 0),
            include: include || [],
            exclude: exclude || [],
            totalResults: results.length,
            filteredResults: filteredResults.length,
          },
          results: formattedResults,
        },
      };
    } catch (error) {
      logger.error("Failed to search project", error as Error, {
        query,
        projectId,
      });

      return {
        success: false,
        error: `Failed to search project: ${(error as Error).message}`,
      };
    }
  }
}
