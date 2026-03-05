/**
 * Search Analytics
 *
 * Tracks search usage patterns, performance metrics, and cache efficiency.
 * Helps identify:
 * - Most searched queries
 * - Cache hit rates
 * - Performance bottlenecks
 * - Query patterns by project
 */

import { logger } from "@th0th-ai/shared";
import { Database } from "bun:sqlite";
import path from "path";
import os from "os";
import fs from "fs";

interface SearchEvent {
  timestamp: number;
  projectId: string;
  query: string;
  resultCount: number;
  duration: number; // milliseconds
  cacheHit: boolean;
  score?: number; // average score
}

interface QueryStats {
  query: string;
  count: number;
  avgDuration: number;
  avgResults: number;
  cacheHitRate: number;
  lastSearched: number;
}

interface ProjectStats {
  projectId: string;
  totalSearches: number;
  uniqueQueries: number;
  avgDuration: number;
  cacheHitRate: number;
  topQueries: Array<{ query: string; count: number }>;
}

interface AnalyticsSummary {
  totalSearches: number;
  uniqueQueries: number;
  uniqueProjects: number;
  overallCacheHitRate: number;
  avgSearchDuration: number;
  topQueries: Array<{ query: string; count: number; projects: number }>;
  topProjects: Array<{ projectId: string; searches: number }>;
}

export class SearchAnalytics {
  private db: Database;

  constructor(dbPath?: string) {
    const defaultPath = path.join(os.homedir(), ".rlm", "search-analytics.db");
    const finalPath = dbPath || defaultPath;

    // Ensure directory exists
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(finalPath);
    this.initializeDatabase();

    logger.info("SearchAnalytics initialized", { dbPath: finalPath });
  }

  /**
   * Initialize database schema
   */
  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        query TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        cache_hit INTEGER NOT NULL,
        avg_score REAL
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON search_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_project_id ON search_events(project_id);
      CREATE INDEX IF NOT EXISTS idx_query ON search_events(query);
      CREATE INDEX IF NOT EXISTS idx_cache_hit ON search_events(cache_hit);
    `);
  }

  /**
   * Track a search event
   */
  trackSearch(event: SearchEvent): void {
    try {
      // DEBUG: Log the exact event being tracked
      logger.debug("trackSearch called with event", {
        cacheHit: event.cacheHit,
        duration: event.duration,
        durationMs: `${event.duration}ms`,
        query: event.query.substring(0, 40),
        timestamp: event.timestamp,
      });

      const stmt = this.db.prepare(`
        INSERT INTO search_events 
          (timestamp, project_id, query, result_count, duration, cache_hit, avg_score)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        event.timestamp,
        event.projectId,
        event.query,
        event.resultCount,
        event.duration,
        event.cacheHit ? 1 : 0,
        event.score || null,
      );

      logger.debug("Tracked search event", {
        projectId: event.projectId,
        query: event.query,
        duration: event.duration,
        cacheHit: event.cacheHit,
      });
    } catch (error) {
      logger.error("Failed to track search event", error as Error);
    }
  }

  /**
   * Get statistics for a specific query
   */
  getQueryStats(query: string, projectId?: string): QueryStats | null {
    try {
      const whereClause = projectId
        ? "WHERE query = ? AND project_id = ?"
        : "WHERE query = ?";
      const params = projectId ? [query, projectId] : [query];

      const stmt = this.db.prepare(`
        SELECT 
          query,
          COUNT(*) as count,
          AVG(duration) as avgDuration,
          AVG(result_count) as avgResults,
          AVG(CAST(cache_hit AS REAL)) as cacheHitRate,
          MAX(timestamp) as lastSearched
        FROM search_events
        ${whereClause}
        GROUP BY query
      `);

      const row = stmt.get(...params) as any;

      if (!row) return null;

      return {
        query: row.query,
        count: row.count,
        avgDuration: row.avgDuration,
        avgResults: row.avgResults,
        cacheHitRate: row.cacheHitRate,
        lastSearched: row.lastSearched,
      };
    } catch (error) {
      logger.error("Failed to get query stats", error as Error, { query });
      return null;
    }
  }

  /**
   * Get statistics for a project
   */
  getProjectStats(projectId: string, limit: number = 10): ProjectStats | null {
    try {
      // Overall project stats
      const overallStmt = this.db.prepare(`
        SELECT 
          COUNT(*) as totalSearches,
          COUNT(DISTINCT query) as uniqueQueries,
          AVG(duration) as avgDuration,
          AVG(CAST(cache_hit AS REAL)) as cacheHitRate
        FROM search_events
        WHERE project_id = ?
      `);

      const overall = overallStmt.get(projectId) as any;

      if (!overall || overall.totalSearches === 0) return null;

      // Top queries for this project
      const topQueriesStmt = this.db.prepare(`
        SELECT query, COUNT(*) as count
        FROM search_events
        WHERE project_id = ?
        GROUP BY query
        ORDER BY count DESC
        LIMIT ?
      `);

      const topQueries = topQueriesStmt.all(projectId, limit) as Array<{
        query: string;
        count: number;
      }>;

      return {
        projectId,
        totalSearches: overall.totalSearches,
        uniqueQueries: overall.uniqueQueries,
        avgDuration: overall.avgDuration,
        cacheHitRate: overall.cacheHitRate,
        topQueries,
      };
    } catch (error) {
      logger.error("Failed to get project stats", error as Error, {
        projectId,
      });
      return null;
    }
  }

  /**
   * Get top N queries for a project
   */
  getTopQueries(projectId: string, limit: number = 10): QueryStats[] {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          query,
          COUNT(*) as count,
          AVG(duration) as avgDuration,
          AVG(result_count) as avgResults,
          AVG(CAST(cache_hit AS REAL)) as cacheHitRate,
          MAX(timestamp) as lastSearched
        FROM search_events
        WHERE project_id = ?
        GROUP BY query
        ORDER BY count DESC
        LIMIT ?
      `);

      return stmt.all(projectId, limit).map((row: any) => ({
        query: row.query,
        count: row.count,
        avgDuration: row.avgDuration,
        avgResults: row.avgResults,
        cacheHitRate: row.cacheHitRate,
        lastSearched: row.lastSearched,
      }));
    } catch (error) {
      logger.error("Failed to get top queries", error as Error, { projectId });
      return [];
    }
  }

  /**
   * Get list of active projects (that have search events)
   */
  getActiveProjects(): string[] {
    try {
      const stmt = this.db.prepare(`
        SELECT DISTINCT project_id
        FROM search_events
        ORDER BY project_id
      `);

      return stmt.all().map((row: any) => row.project_id);
    } catch (error) {
      logger.error("Failed to get active projects", error as Error);
      return [];
    }
  }

  /**
   * Get overall analytics summary
   */
  getSummary(topN: number = 10): AnalyticsSummary {
    try {
      // Overall stats
      const overallStmt = this.db.prepare(`
        SELECT 
          COUNT(*) as totalSearches,
          COUNT(DISTINCT query) as uniqueQueries,
          COUNT(DISTINCT project_id) as uniqueProjects,
          AVG(CAST(cache_hit AS REAL)) as overallCacheHitRate,
          AVG(duration) as avgSearchDuration
        FROM search_events
      `);

      const overall = overallStmt.get() as any;

      // Top queries across all projects
      const topQueriesStmt = this.db.prepare(`
        SELECT 
          query, 
          COUNT(*) as count,
          COUNT(DISTINCT project_id) as projects
        FROM search_events
        GROUP BY query
        ORDER BY count DESC
        LIMIT ?
      `);

      const topQueries = topQueriesStmt.all(topN) as Array<{
        query: string;
        count: number;
        projects: number;
      }>;

      // Top projects by search count
      const topProjectsStmt = this.db.prepare(`
        SELECT 
          project_id as projectId,
          COUNT(*) as searches
        FROM search_events
        GROUP BY project_id
        ORDER BY searches DESC
        LIMIT ?
      `);

      const topProjects = topProjectsStmt.all(topN) as Array<{
        projectId: string;
        searches: number;
      }>;

      return {
        totalSearches: overall.totalSearches || 0,
        uniqueQueries: overall.uniqueQueries || 0,
        uniqueProjects: overall.uniqueProjects || 0,
        overallCacheHitRate: overall.overallCacheHitRate || 0,
        avgSearchDuration: overall.avgSearchDuration || 0,
        topQueries,
        topProjects,
      };
    } catch (error) {
      logger.error("Failed to get analytics summary", error as Error);
      return {
        totalSearches: 0,
        uniqueQueries: 0,
        uniqueProjects: 0,
        overallCacheHitRate: 0,
        avgSearchDuration: 0,
        topQueries: [],
        topProjects: [],
      };
    }
  }

  /**
   * Get recent searches
   */
  getRecentSearches(limit: number = 50, projectId?: string): SearchEvent[] {
    try {
      const whereClause = projectId ? "WHERE project_id = ?" : "";
      const params = projectId ? [projectId, limit] : [limit];

      const stmt = this.db.prepare(`
        SELECT 
          timestamp,
          project_id as projectId,
          query,
          result_count as resultCount,
          duration,
          CAST(cache_hit AS INTEGER) as cacheHit,
          avg_score as score
        FROM search_events
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT ?
      `);

      return stmt.all(...params) as SearchEvent[];
    } catch (error) {
      logger.error("Failed to get recent searches", error as Error);
      return [];
    }
  }

  /**
   * Get cache performance metrics
   */
  getCachePerformance(projectId?: string): {
    hitRate: number;
    avgCacheHitDuration: number;
    avgCacheMissDuration: number;
    speedup: number;
  } {
    try {
      const whereClause = projectId ? "WHERE project_id = ?" : "";
      const params = projectId ? [projectId] : [];

      const stmt = this.db.prepare(`
        SELECT 
          AVG(CASE WHEN cache_hit = 1 THEN duration END) as avgCacheHitDuration,
          AVG(CASE WHEN cache_hit = 0 THEN duration END) as avgCacheMissDuration,
          AVG(CAST(cache_hit AS REAL)) as hitRate
        FROM search_events
        ${whereClause}
      `);

      const result = stmt.get(...params) as any;

      const hitRate = result.hitRate || 0;
      const avgCacheHitDuration = result.avgCacheHitDuration || 0;
      const avgCacheMissDuration = result.avgCacheMissDuration || 1;
      const speedup =
        avgCacheMissDuration > 0
          ? avgCacheMissDuration / avgCacheHitDuration
          : 1;

      return {
        hitRate,
        avgCacheHitDuration,
        avgCacheMissDuration,
        speedup,
      };
    } catch (error) {
      logger.error("Failed to get cache performance", error as Error);
      return {
        hitRate: 0,
        avgCacheHitDuration: 0,
        avgCacheMissDuration: 0,
        speedup: 1,
      };
    }
  }

  /**
   * Clear analytics data
   */
  clear(projectId?: string): number {
    try {
      if (projectId) {
        const stmt = this.db.prepare(
          "DELETE FROM search_events WHERE project_id = ?",
        );
        const result = stmt.run(projectId);
        logger.info("Cleared analytics for project", {
          projectId,
          deleted: result.changes,
        });
        return result.changes;
      } else {
        this.db.exec("DELETE FROM search_events");
        logger.info("Cleared all analytics");
        return -1;
      }
    } catch (error) {
      logger.error("Failed to clear analytics", error as Error);
      return 0;
    }
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
    logger.info("SearchAnalytics closed");
  }
}

// Singleton instance
export const searchAnalytics = new SearchAnalytics();
