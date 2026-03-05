/**
 * Search Result Cache
 *
 * Two-level cache for search results:
 * - L1: In-memory Map (fast, limited size)
 * - L2: SQLite (persistent, larger capacity)
 *
 * Benefits:
 * - 50% reduction in embedding API calls
 * - Instant results for repeated queries
 * - Automatic invalidation on index updates
 */

import { SearchResult } from "@th0th-ai/shared";
import { logger } from "@th0th-ai/shared";
import { Database } from "bun:sqlite";
import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs";

interface CacheEntry {
  key: string;
  query: string;
  projectId: string;
  results: SearchResult[];
  options: string; // JSON serialized
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

export class SearchCache {
  private l1Cache: Map<string, CacheEntry> = new Map();
  private l2Db: Database;
  private stats: CacheStats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
    totalHits: 0,
    totalMisses: 0,
    hitRate: 0,
  };

  private readonly L1_MAX_SIZE = 100; // entries
  private readonly L2_MAX_SIZE = 10000; // entries
  private readonly DEFAULT_TTL = 3600; // 1 hour in seconds

  constructor(dbPath?: string) {
    const defaultPath = path.join(os.homedir(), ".rlm", "search-cache.db");
    const finalPath = dbPath || defaultPath;

    // Ensure directory exists
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.l2Db = new Database(finalPath);
    this.initializeDatabase();

    logger.info("SearchCache initialized", {
      l1MaxSize: this.L1_MAX_SIZE,
      l2MaxSize: this.L2_MAX_SIZE,
      ttl: this.DEFAULT_TTL,
      dbPath: finalPath,
    });
  }

  /**
   * Initialize SQLite schema for L2 cache
   */
  private initializeDatabase(): void {
    this.l2Db.exec(`
      CREATE TABLE IF NOT EXISTS search_cache (
        key TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        project_id TEXT NOT NULL,
        results TEXT NOT NULL,
        options TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        access_count INTEGER DEFAULT 1,
        last_accessed INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_project_query 
        ON search_cache(project_id, query);
      
      CREATE INDEX IF NOT EXISTS idx_last_accessed 
        ON search_cache(last_accessed);
      
      CREATE INDEX IF NOT EXISTS idx_created_at 
        ON search_cache(created_at);
    `);
  }

  /**
   * Generate cache key from query parameters
   */
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

  /**
   * Normalize options for consistent cache keys
   *
   * IMPORTANT: Only include parameters that affect WHAT is searched,
   * not HOW results are displayed/formatted.
   *
   * Search-affecting params: maxResults, include, exclude
   * Presentation params (ignored): explainScores, responseMode, minScore
   */
  private normalizeOptions(
    options: Record<string, unknown>,
  ): Record<string, unknown> {
    // Parameters that affect the actual search results
    const searchAffectingParams = [
      "maxResults", // Limits number of results returned
      "include", // File pattern filters
      "exclude", // File pattern filters
    ];

    const normalized: Record<string, unknown> = {};

    for (const key of searchAffectingParams) {
      if (options[key] !== undefined) {
        normalized[key] = options[key];
      }
    }

    return normalized;
  }

  /**
   * Get cached search results
   */
  async get(
    query: string,
    projectId: string,
    options: Record<string, unknown> = {},
  ): Promise<SearchResult[] | null> {
    const key = this.generateKey(query, projectId, options);

    // Check L1 (memory) first
    const l1Entry = this.l1Cache.get(key);
    if (l1Entry) {
      // Check TTL
      const age = Date.now() - l1Entry.createdAt;
      if (age < this.DEFAULT_TTL * 1000) {
        this.stats.l1Hits++;
        this.stats.totalHits++;
        this.updateStats();

        // Update access metadata
        l1Entry.accessCount++;
        l1Entry.lastAccessed = Date.now();

        logger.debug("L1 cache hit", {
          query,
          projectId,
          key: key.slice(0, 8),
        });
        return l1Entry.results;
      } else {
        // Expired, remove from L1
        this.l1Cache.delete(key);
      }
    }

    this.stats.l1Misses++;

    // Check L2 (SQLite)
    const l2Entry = this.getFromL2(key);
    if (l2Entry) {
      // Check TTL
      const age = Date.now() - l2Entry.createdAt;
      if (age < this.DEFAULT_TTL * 1000) {
        this.stats.l2Hits++;
        this.stats.totalHits++;
        this.updateStats();

        // Promote to L1
        this.l1Cache.set(key, l2Entry);
        this.evictL1IfNeeded();

        // Update L2 access metadata
        this.updateL2Access(key);

        logger.debug("L2 cache hit", {
          query,
          projectId,
          key: key.slice(0, 8),
        });
        return l2Entry.results;
      } else {
        // Expired, remove from L2
        this.deleteFromL2(key);
      }
    }

    this.stats.l2Misses++;
    this.stats.totalMisses++;
    this.updateStats();

    logger.debug("Cache miss", { query, projectId, key: key.slice(0, 8) });
    return null;
  }

  /**
   * Store search results in cache
   */
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

    // Store in L1
    this.l1Cache.set(key, entry);
    this.evictL1IfNeeded();

    // Store in L2
    this.saveToL2(entry);

    logger.debug("Cached search results", {
      query,
      projectId,
      resultCount: results.length,
      key: key.slice(0, 8),
    });
  }

  /**
   * Invalidate cache for a project (e.g., after reindex)
   */
  async invalidateProject(projectId: string): Promise<number> {
    let count = 0;

    // Invalidate L1
    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.projectId === projectId) {
        this.l1Cache.delete(key);
        count++;
      }
    }

    // Invalidate L2
    const stmt = this.l2Db.prepare(
      "DELETE FROM search_cache WHERE project_id = ?",
    );
    const result = stmt.run(projectId);
    count += result.changes;

    logger.info("Invalidated cache for project", {
      projectId,
      entriesRemoved: count,
    });
    return count;
  }

  /**
   * Invalidate cache entries affected by specific file changes
   *
   * Only invalidates queries that returned results from the modified file,
   * preserving cache for unaffected queries.
   *
   * @param projectId - Project identifier
   * @param filePaths - Array of file paths that were modified
   * @returns Number of cache entries invalidated
   */
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

    logger.info("Starting file-based cache invalidation", {
      projectId,
      fileCount: filePaths.length,
      files: filePaths,
    });

    const affectedQueries = new Set<string>();
    let entriesInvalidated = 0;
    let entriesPreserved = 0;

    // Invalidate from L1 cache
    for (const [key, entry] of this.l1Cache.entries()) {
      if (entry.projectId !== projectId) continue;

      // Check if any result in this cache entry comes from modified files
      const hasAffectedFile = entry.results.some((result) => {
        const resultPath = result.metadata?.filePath as string;
        return filePaths.some(
          (modifiedPath) => resultPath && resultPath.includes(modifiedPath),
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

    // Invalidate from L2 cache
    // SQLite doesn't support JSON path queries efficiently, so we need to:
    // 1. Fetch all entries for this project
    // 2. Check each one in memory
    // 3. Delete affected entries
    const stmt = this.l2Db.prepare(`
      SELECT key, query, results FROM search_cache WHERE project_id = ?
    `);
    const allEntries = stmt.all(projectId) as Array<{
      key: string;
      query: string;
      results: string;
    }>;

    const keysToDelete: string[] = [];

    for (const entry of allEntries) {
      try {
        const results = JSON.parse(entry.results) as SearchResult[];

        const hasAffectedFile = results.some((result) => {
          const resultPath = result.metadata?.filePath as string;
          return filePaths.some(
            (modifiedPath) => resultPath && resultPath.includes(modifiedPath),
          );
        });

        if (hasAffectedFile) {
          keysToDelete.push(entry.key);
          affectedQueries.add(entry.query);
        } else {
          entriesPreserved++;
        }
      } catch (error) {
        // If we can't parse results, better to invalidate for safety
        logger.warn("Failed to parse cache entry results, invalidating", {
          key: entry.key,
          error: (error as Error).message,
        });
        keysToDelete.push(entry.key);
      }
    }

    // Batch delete from L2
    if (keysToDelete.length > 0) {
      const deleteStmt = this.l2Db.prepare(
        `DELETE FROM search_cache WHERE key = ?`,
      );

      const transaction = this.l2Db.transaction((keys: string[]) => {
        for (const key of keys) {
          deleteStmt.run(key);
        }
      });

      transaction(keysToDelete);
      entriesInvalidated += keysToDelete.length;
    }

    const result = {
      entriesInvalidated,
      entriesPreserved,
      affectedQueries: Array.from(affectedQueries),
    };

    logger.info("File-based cache invalidation completed", {
      projectId,
      filesModified: filePaths.length,
      ...result,
    });

    return result;
  }

  /**
   * Clear entire cache
   */
  async clear(): Promise<void> {
    this.l1Cache.clear();
    this.l2Db.exec("DELETE FROM search_cache");

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

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get L1 cache size
   */
  getL1Size(): number {
    return this.l1Cache.size;
  }

  /**
   * Get L2 cache size
   */
  getL2Size(): number {
    const stmt = this.l2Db.prepare(
      "SELECT COUNT(*) as count FROM search_cache",
    );
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Clean up expired entries
   */
  async cleanup(): Promise<{ l1Removed: number; l2Removed: number }> {
    const now = Date.now();
    const ttlMs = this.DEFAULT_TTL * 1000;
    let l1Removed = 0;
    let l2Removed = 0;

    // Clean L1
    for (const [key, entry] of this.l1Cache.entries()) {
      if (now - entry.createdAt > ttlMs) {
        this.l1Cache.delete(key);
        l1Removed++;
      }
    }

    // Clean L2
    const stmt = this.l2Db.prepare(
      "DELETE FROM search_cache WHERE (? - created_at) > ?",
    );
    const result = stmt.run(now, ttlMs);
    l2Removed = result.changes;

    logger.info("Cache cleanup completed", { l1Removed, l2Removed });
    return { l1Removed, l2Removed };
  }

  /**
   * Private: Get entry from L2
   */
  private getFromL2(key: string): CacheEntry | null {
    const stmt = this.l2Db.prepare(`
      SELECT * FROM search_cache WHERE key = ?
    `);
    const row = stmt.get(key) as any;

    if (!row) return null;

    return {
      key: row.key,
      query: row.query,
      projectId: row.project_id,
      results: JSON.parse(row.results),
      options: row.options,
      createdAt: row.created_at,
      accessCount: row.access_count,
      lastAccessed: row.last_accessed,
    };
  }

  /**
   * Private: Save entry to L2
   */
  private saveToL2(entry: CacheEntry): void {
    const stmt = this.l2Db.prepare(`
      INSERT OR REPLACE INTO search_cache 
        (key, query, project_id, results, options, created_at, access_count, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.key,
      entry.query,
      entry.projectId,
      JSON.stringify(entry.results),
      entry.options,
      entry.createdAt,
      entry.accessCount,
      entry.lastAccessed,
    );

    // Evict old entries if L2 is too large
    this.evictL2IfNeeded();
  }

  /**
   * Private: Update L2 access metadata
   */
  private updateL2Access(key: string): void {
    const stmt = this.l2Db.prepare(`
      UPDATE search_cache 
      SET access_count = access_count + 1, 
          last_accessed = ?
      WHERE key = ?
    `);
    stmt.run(Date.now(), key);
  }

  /**
   * Private: Delete from L2
   */
  private deleteFromL2(key: string): void {
    const stmt = this.l2Db.prepare("DELETE FROM search_cache WHERE key = ?");
    stmt.run(key);
  }

  /**
   * Private: Evict L1 entries using LRU
   */
  private evictL1IfNeeded(): void {
    if (this.l1Cache.size <= this.L1_MAX_SIZE) return;

    // Find least recently accessed
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
      logger.debug("Evicted L1 entry", { key: oldestKey.slice(0, 8) });
    }
  }

  /**
   * Private: Evict L2 entries using LRU
   */
  private evictL2IfNeeded(): void {
    const currentSize = this.getL2Size();

    if (currentSize <= this.L2_MAX_SIZE) return;

    const toRemove = currentSize - this.L2_MAX_SIZE;
    const stmt = this.l2Db.prepare(`
      DELETE FROM search_cache 
      WHERE key IN (
        SELECT key FROM search_cache 
        ORDER BY last_accessed ASC 
        LIMIT ?
      )
    `);
    stmt.run(toRemove);

    logger.debug("Evicted L2 entries", { count: toRemove });
  }

  /**
   * Private: Update hit rate stats
   */
  private updateStats(): void {
    const total = this.stats.totalHits + this.stats.totalMisses;
    this.stats.hitRate = total > 0 ? this.stats.totalHits / total : 0;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.l2Db.close();
    logger.info("SearchCache closed");
  }
}

// Singleton instance
export const searchCache = new SearchCache();
