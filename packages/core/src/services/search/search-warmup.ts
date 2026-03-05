/**
 * Search Cache Warmup
 *
 * Pre-loads frequently searched queries into cache on startup
 * to improve initial search performance.
 */

import { logger } from "@th0th-ai/shared";
import { SearchAnalytics } from "./search-analytics.js";
import { ContextualSearchRLM } from "./contextual-search-rlm.js";

export class SearchCacheWarmup {
  private analytics: SearchAnalytics;
  private search: ContextualSearchRLM;

  constructor(search: ContextualSearchRLM, analytics: SearchAnalytics) {
    this.search = search;
    this.analytics = analytics;
  }

  /**
   * Warm up cache for a project by pre-loading top queries
   */
  async warmupProject(
    projectId: string,
    topN: number = 10,
  ): Promise<{
    queriesWarmed: number;
    totalDuration: number;
  }> {
    const startTime = Date.now();

    logger.info("Starting cache warmup", { projectId, topN });

    try {
      // Get top N most frequent queries for this project
      const topQueries = await this.analytics.getTopQueries(projectId, topN);

      if (topQueries.length === 0) {
        logger.info("No queries to warm up", { projectId });
        return { queriesWarmed: 0, totalDuration: 0 };
      }

      let warmed = 0;

      // Pre-execute each query to populate cache
      for (const queryStats of topQueries) {
        try {
          await this.search.search(queryStats.query, projectId, {
            maxResults: 10, // Standard size
          });
          warmed++;

          logger.debug("Warmed query", {
            query: queryStats.query,
            previousCount: queryStats.count,
          });
        } catch (error) {
          logger.error("Failed to warm query", error as Error, {
            query: queryStats.query,
          });
        }
      }

      const totalDuration = Date.now() - startTime;

      logger.info("Cache warmup completed", {
        projectId,
        queriesWarmed: warmed,
        totalDuration: `${totalDuration}ms`,
      });

      return { queriesWarmed: warmed, totalDuration };
    } catch (error) {
      logger.error("Cache warmup failed", error as Error, { projectId });
      return { queriesWarmed: 0, totalDuration: Date.now() - startTime };
    }
  }

  /**
   * Warm up cache for all projects
   */
  async warmupAll(topN: number = 10): Promise<{
    projects: number;
    totalQueries: number;
    totalDuration: number;
  }> {
    const startTime = Date.now();

    logger.info("Starting global cache warmup", { topN });

    try {
      // Get all projects that have been searched
      const projects = await this.analytics.getActiveProjects();

      let totalQueries = 0;

      for (const projectId of projects) {
        const result = await this.warmupProject(projectId, topN);
        totalQueries += result.queriesWarmed;
      }

      const totalDuration = Date.now() - startTime;

      logger.info("Global cache warmup completed", {
        projects: projects.length,
        totalQueries,
        totalDuration: `${totalDuration}ms`,
      });

      return {
        projects: projects.length,
        totalQueries,
        totalDuration,
      };
    } catch (error) {
      logger.error("Global cache warmup failed", error as Error);
      return {
        projects: 0,
        totalQueries: 0,
        totalDuration: Date.now() - startTime,
      };
    }
  }
}
