/**
 * Search Result Cache - PostgreSQL Implementation
 *
 * Two-level cache for search results using PostgreSQL.
 */

import { SearchResult } from "@th0th-ai/shared";
import { logger } from "@th0th-ai/shared";
import crypto from "crypto";
import { getPgPool, getSqliteDb, DbConfig } from "../../data/db-connection.js";
import type { Pool } from "pg";
import type { Database } from "bun:sqlite";

interface CacheEntry {
  key: string;
  query: string;
  projectId: string;
  results: SearchResult[];
  options: string;
  createdAt: number;
  accessCount: number;
  lastAccessed: number;
}

interface CacheStats {
  l1Hits: number;
  l1Misses: number;
  l2Hits: number;
  l2Misses: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
}

export class SearchCachePg {
  private pool: Pool | null = null;
  private l1Cache: Map<string, CacheEntry> = new Map();
  private stats: CacheStats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
    totalHits: 0,
    totalMisses: 0,
    hitRate: 0,
  };

  private readonly L1_MAX_SIZE = 100;
  private readonly L2_MAX_SIZE = 10000;
  private readonly DEFAULT_TTL = 3600;

  constructor() {}

  private async getPool(): Promise<Pool> {
    if (!this.pool) {
      this.pool = await getPgPool();
      await this.initTable();
    }
    return this.pool;
  }

  private async initTable(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS search_cache (
        key TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        project_id TEXT NOT NULL,
        results JSONB NOT NULL,
        options JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour',
        access_count INT DEFAULT 1,
        last_accessed TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_search_cache_project ON search_cache(project_id);
      CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);
    `);
  }

  private generateKey(
    query: string,
    projectId: string,
    options: Record<string, unknown>,
  ): string {
    const payload = JSON.stringify({
      query: query.toLowerCase().trim(),
      projectId,
      options: this.normalizeOptions(options),
    });
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  private normalizeOptions(
    options: Record<string, unknown>,
  ): Record<string, unknown> {
    const searchAffectingParams = [
      "maxResults",
      "include",
      "exclude",
    ];

    const normalized: Record<string, unknown> = {};
    for (const key of searchAffectingParams) {
      if (options[key] !== undefined) {
        normalized[key] = options[key];
      }
    }
    return normalized;
  }

  async get(
    query: string,
    projectId: string,
    options: Record<string, unknown> = {},
  ): Promise<SearchResult[] | null> {
    const key = this.generateKey(query, projectId, options);

    const l1Entry = this.l1Cache.get(key);
    if (l1Entry) {
      const age = Date.now() - l1Entry.createdAt;
      if (age < this.DEFAULT_TTL * 1000) {
        this.stats.l1Hits++;
        this.stats.totalHits++;
        l1Entry.accessCount++;
        l1Entry.lastAccessed = Date.now();
        return l1Entry.results;
      } else {
        this.l1Cache.delete(key);
      }
    }

    this.stats.l1Misses++;

    const pool = await this.getPool();
    const { rows } = await pool.query(
      `SELECT * FROM search_cache 
       WHERE key = $1 AND expires_at > NOW()`,
      [key]
    );

    if (rows.length > 0) {
      const row = rows[0];
      const entry: CacheEntry = {
        key: row.key,
        query: row.query,
        projectId: row.project_id,
        results: row.results,
        options: row.options,
        createdAt: new Date(row.created_at).getTime(),
        accessCount: row.access_count,
        lastAccessed: new Date(row.last_accessed).getTime(),
      };

      this.stats.l2Hits++;
      this.stats.totalHits++;
      this.l1Cache.set(key, entry);
      this.evictL1IfNeeded();

      await pool.query(
        `UPDATE search_cache 
         SET access_count = access_count + 1, last_accessed = NOW()
         WHERE key = $1`,
        [key]
      );

      return entry.results;
    }

    this.stats.l2Misses++;
    this.stats.totalMisses++;
    return null;
  }

  async set(
    query: string,
    projectId: string,
    results: SearchResult[],
    options: Record<string, unknown> = {},
  ): Promise<void> {
    const key = this.generateKey(query, projectId, options);
    const now = Date.now();

    const entry: CacheEntry = {
      key,
      query,
      projectId,
      results,
      options: JSON.stringify(options),
      createdAt: now,
      accessCount: 1,
      lastAccessed: now,
    };

    this.l1Cache.set(key, entry);
    this.evictL1IfNeeded();

    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO search_cache (key, query, project_id, results, options)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET
         results = EXCLUDED.results,
         options = EXCLUDED.options,
         expires_at = NOW() + INTERVAL '1 hour'`,
      [key, query, projectId, JSON.stringify(results), JSON.stringify(options)]
    );

    this.evictL2IfNeeded();
  }

  async invalidateProject(projectId: string): Promise<number> {
    let count = 0;

    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.projectId === projectId) {
        this.l1Cache.delete(key);
        count++;
      }
    }

    const pool = await this.getPool();
    const result = await pool.query(
      `DELETE FROM search_cache WHERE project_id = $1`,
      [projectId]
    );
    count += result.rowCount || 0;

    logger.info("Invalidated cache for project", { projectId, entriesRemoved: count });
    return count;
  }

  async invalidateByFiles(
    projectId: string,
    filePaths: string[],
  ): Promise<{
    entriesInvalidated: number;
    entriesPreserved: number;
    affectedQueries: string[];
  }> {
    if (!filePaths || filePaths.length === 0) {
      return {
        entriesInvalidated: 0,
        entriesPreserved: 0,
        affectedQueries: [],
      };
    }

    const affectedQueries = new Set<string>();
    let entriesInvalidated = 0;
    let entriesPreserved = 0;

    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.projectId !== projectId) continue;

      const hasAffectedFile = entry.results.some((result) => {
        const resultPath = result.metadata?.filePath as string;
        return filePaths.some(
          (modifiedPath) => resultPath && resultPath.includes(modifiedPath)
        );
      });

      if (hasAffectedFile) {
        this.l1Cache.delete(key);
        affectedQueries.add(entry.query);
        entriesInvalidated++;
      } else {
        entriesPreserved++;
      }
    }

    const pool = await this.getPool();
    const { rows } = await pool.query(
      `SELECT key, query, results FROM search_cache WHERE project_id = $1`,
      [projectId]
    );

    const keysToDelete: string[] = [];

    for (const row of rows) {
      try {
        const results = row.results as SearchResult[];
        const hasAffectedFile = results.some((result) => {
          const resultPath = result.metadata?.filePath as string;
          return filePaths.some(
            (modifiedPath) => resultPath && resultPath.includes(modifiedPath)
          );
        });

        if (hasAffectedFile) {
          keysToDelete.push(row.key);
          affectedQueries.add(row.query);
        } else {
          entriesPreserved++;
        }
      } catch {
        keysToDelete.push(row.key);
      }
    }

    if (keysToDelete.length > 0) {
      await pool.query(
        `DELETE FROM search_cache WHERE key = ANY($1)`,
        [keysToDelete]
      );
      entriesInvalidated += keysToDelete.length;
    }

    logger.info("File-based cache invalidation completed", {
      projectId,
      filesModified: filePaths.length,
      entriesInvalidated,
      entriesPreserved,
    });

    return {
      entriesInvalidated,
      entriesPreserved,
      affectedQueries: Array.from(affectedQueries),
    };
  }

  async clear(): Promise<void> {
    this.l1Cache.clear();
    
    const pool = await this.getPool();
    await pool.query("DELETE FROM search_cache");

    this.stats = {
      l1Hits: 0,
      l1Misses: 0,
      l2Hits: 0,
      l2Misses: 0,
      totalHits: 0,
      totalMisses: 0,
      hitRate: 0,
    };

    logger.info("Cache cleared");
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  getL1Size(): number {
    return this.l1Cache.size;
  }

  async getL2Size(): Promise<number> {
    const pool = await this.getPool();
    const { rows } = await pool.query("SELECT COUNT(*) as count FROM search_cache");
    return parseInt(rows[0]?.count || '0');
  }

  async cleanup(): Promise<{ l1Removed: number; l2Removed: number }> {
    const now = Date.now();
    const ttlMs = this.DEFAULT_TTL * 1000;
    let l1Removed = 0;
    let l2Removed = 0;

    for (const [key, entry] of this.l1Cache.entries()) {
      if (now - entry.createdAt > ttlMs) {
        this.l1Cache.delete(key);
        l1Removed++;
      }
    }

    const pool = await this.getPool();
    const result = await pool.query(
      `DELETE FROM search_cache WHERE expires_at < NOW()`
    );
    l2Removed = result.rowCount || 0;

    logger.info("Cache cleanup completed", { l1Removed, l2Removed });
    return { l1Removed, l2Removed };
  }

  private evictL1IfNeeded(): void {
    if (this.l1Cache.size <= this.L1_MAX_SIZE) return;

    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.l1Cache.delete(oldestKey);
    }
  }

  private async evictL2IfNeeded(): Promise<void> {
    const currentSize = await this.getL2Size();
    if (currentSize <= this.L2_MAX_SIZE) return;

    const toRemove = currentSize - this.L2_MAX_SIZE;
    const pool = await this.getPool();
    await pool.query(
      `DELETE FROM search_cache
       WHERE key IN (
         SELECT key FROM search_cache 
         ORDER BY last_accessed ASC 
         LIMIT $1
       )`,
      [toRemove]
    );
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    logger.info("SearchCachePg closed");
  }
}
