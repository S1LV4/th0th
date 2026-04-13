/**
 * Search Analytics - PostgreSQL Implementation
 *
 * Tracks search query analytics using PostgreSQL.
 */

import { logger } from "@th0th-ai/shared";
import { getPgPool } from "../../data/db-connection.js";
import type { Pool } from "pg";

export interface SearchEvent {
  timestamp: number;
  projectId: string;
  query: string;
  resultCount: number;
  duration: number; // milliseconds
  cacheHit: boolean;
  score?: number; // average score
}

export interface QueryAnalytics {
  query: string;
  projectId?: string;
  resultsCount: number;
  duration: number;
  cacheHit: boolean;
  timestamp: Date;
}

export interface ProjectAnalytics {
  totalQueries: number;
  avgDuration: number;
  avgResults: number;
  cacheHitRate: number;
  topQueries: Array<{ query: string; count: number }>;
}

export class SearchAnalyticsPg {
  private pool: Pool | null = null;
  private initialized = false;

  constructor() {}

  private async getPool(): Promise<Pool> {
    if (!this.pool) {
      this.pool = await getPgPool();
      if (!this.initialized) {
        await this.initTable();
        this.initialized = true;
      }
    }
    return this.pool;
  }

  private async initTable(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS search_analytics (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        query TEXT NOT NULL,
        project_id TEXT,
        results_count INT DEFAULT 0,
        duration INT NOT NULL,
        cache_hit BOOLEAN DEFAULT false,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS search_events (
        timestamp BIGINT NOT NULL,
        project_id TEXT NOT NULL,
        query TEXT NOT NULL,
        result_count INT NOT NULL,
        duration INT NOT NULL,
        cache_hit BOOLEAN NOT NULL,
        avg_score REAL
      );
      
      CREATE INDEX IF NOT EXISTS idx_analytics_project ON search_analytics(project_id);
      CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON search_analytics(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_analytics_query ON search_analytics(query);
      CREATE INDEX IF NOT EXISTS idx_events_project ON search_events(project_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON search_events(timestamp DESC);
    `);
    
    logger.info('PostgreSQL search analytics initialized');
  }

  trackSearch(event: SearchEvent): void {
    // Fire and forget async operation
    this.trackSearchAsync(event).catch(err => {
      logger.error('Failed to track search event', err);
    });
  }

  private async trackSearchAsync(event: SearchEvent): Promise<void> {
    try {
      logger.debug("trackSearch called with event", {
        cacheHit: event.cacheHit,
        duration: event.duration,
        durationMs: `${event.duration}ms`,
        query: event.query.substring(0, 40),
        timestamp: event.timestamp,
      });

      const pool = await this.getPool();
      await pool.query(
        `INSERT INTO search_events 
          (timestamp, project_id, query, result_count, duration, cache_hit, avg_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          event.timestamp,
          event.projectId,
          event.query,
          event.resultCount,
          event.duration,
          event.cacheHit,
          event.score || null,
        ]
      );
    } catch (error) {
      logger.error('Failed to track search event in PostgreSQL', error as Error);
    }
  }

  async recordQuery(
    query: string,
    projectId?: string,
    resultsCount: number = 0,
    duration: number = 0,
    cacheHit: boolean = false
  ): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO search_analytics (query, project_id, results_count, duration, cache_hit)
       VALUES ($1, $2, $3, $4, $5)`,
      [query, projectId, resultsCount, duration, cacheHit]
    );
  }

  async getProjectAnalytics(projectId: string): Promise<ProjectAnalytics> {
    const pool = await this.getPool();
    
    const { rows: statsRows } = await pool.query(
      `SELECT 
        COUNT(*) as total_queries,
        AVG(duration) as avg_duration,
        AVG(results_count) as avg_results,
        AVG(CASE WHEN cache_hit THEN 1 ELSE 0 END) as cache_hit_rate
       FROM search_analytics
       WHERE project_id = $1`,
      [projectId]
    );
    
    const { rows: topRows } = await pool.query(
      `SELECT query, COUNT(*) as count
       FROM search_analytics
       WHERE project_id = $1
       GROUP BY query
       ORDER BY count DESC
       LIMIT 10`,
      [projectId]
    );
    
    const stats = statsRows[0] || { total_queries: 0, avg_duration: 0, avg_results: 0, cache_hit_rate: 0 };
    
    return {
      totalQueries: parseInt(stats.total_queries) || 0,
      avgDuration: parseFloat(stats.avg_duration) || 0,
      avgResults: parseFloat(stats.avg_results) || 0,
      cacheHitRate: parseFloat(stats.cache_hit_rate) || 0,
      topQueries: topRows.map(row => ({
        query: row.query,
        count: parseInt(row.count),
      })),
    };
  }

  async getRecentQueries(limit: number = 100): Promise<QueryAnalytics[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query(
      `SELECT query, project_id, results_count, duration, cache_hit, timestamp
       FROM search_analytics
       ORDER BY timestamp DESC
       LIMIT $1`,
      [limit]
    );
    
    return rows.map(row => ({
        query: row.query,
        projectId: row.project_id,
        resultsCount: row.results_count,
        duration: row.duration,
        cacheHit: row.cache_hit,
        timestamp: row.timestamp,
      }));
  }

  async clear(): Promise<void> {
    const pool = await this.getPool();
    await pool.query('DELETE FROM search_analytics');
    logger.info('Search analytics cleared');
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
    }
  }

  // Additional methods for compatibility with SearchAnalytics interface
  
  async getSummary(topN: number = 10): Promise<any> {
    const pool = await this.getPool();
    
    const totalSearches = await pool.query(
      'SELECT COUNT(*) as count FROM search_events'
    );
    
    const topQueries = await pool.query(
      `SELECT query, COUNT(*) as count 
       FROM search_events 
       GROUP BY query 
       ORDER BY count DESC 
       LIMIT $1`,
      [topN]
    );
    
    return {
      totalSearches: parseInt(totalSearches.rows[0]?.count || '0'),
      topQueries: topQueries.rows,
    };
  }

  async getProjectStats(projectId: string, limit: number = 10): Promise<any> {
    const pool = await this.getPool();
    
    const stats = await pool.query(
      `SELECT 
        COUNT(*) as total_searches,
        AVG(duration) as avg_duration,
        AVG(result_count) as avg_results,
        AVG(CASE WHEN cache_hit THEN 1 ELSE 0 END) as cache_hit_rate
       FROM search_events
       WHERE project_id = $1`,
      [projectId]
    );
    
    return stats.rows[0] || null;
  }

  async getQueryStats(query: string, projectId?: string): Promise<any> {
    const pool = await this.getPool();
    
    const whereClause = projectId 
      ? 'WHERE query = $1 AND project_id = $2'
      : 'WHERE query = $1';
    const params = projectId ? [query, projectId] : [query];
    
    const stats = await pool.query(
      `SELECT 
        COUNT(*) as count,
        AVG(duration) as avg_duration,
        AVG(result_count) as avg_results
       FROM search_events
       ${whereClause}`,
      params
    );
    
    return stats.rows[0] || null;
  }

  async getCachePerformance(projectId?: string): Promise<{
    hitRate: number;
    avgCacheHitDuration: number;
    avgCacheMissDuration: number;
    speedup: number;
  }> {
    const pool = await this.getPool();
    
    const whereClause = projectId ? 'WHERE project_id = $1' : '';
    const params = projectId ? [projectId] : [];
    
    const stats = await pool.query(
      `SELECT 
        AVG(CASE WHEN cache_hit THEN 1 ELSE 0 END) as hit_rate,
        AVG(CASE WHEN cache_hit THEN duration ELSE NULL END) as avg_hit_duration,
        AVG(CASE WHEN NOT cache_hit THEN duration ELSE NULL END) as avg_miss_duration
       FROM search_events
       ${whereClause}`,
      params
    );
    
    const row = stats.rows[0];
    const hitRate = parseFloat(row?.hit_rate || '0');
    const avgHitDuration = parseFloat(row?.avg_hit_duration || '0');
    const avgMissDuration = parseFloat(row?.avg_miss_duration || '1');
    
    return {
      hitRate,
      avgCacheHitDuration: avgHitDuration,
      avgCacheMissDuration: avgMissDuration,
      speedup: avgMissDuration > 0 ? avgMissDuration / Math.max(avgHitDuration, 1) : 0,
    };
  }

  async getRecentSearches(limit: number = 50, projectId?: string): Promise<SearchEvent[]> {
    const pool = await this.getPool();
    
    const whereClause = projectId ? 'WHERE project_id = $2' : '';
    const params = projectId ? [limit, projectId] : [limit];
    
    const { rows } = await pool.query(
      `SELECT * FROM search_events
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT $1`,
      params
    );
    
    return rows.map(row => ({
      timestamp: parseInt(row.timestamp),
      projectId: row.project_id,
      query: row.query,
      resultCount: row.result_count,
      duration: row.duration,
      cacheHit: row.cache_hit,
      score: row.avg_score,
    }));
  }
}
