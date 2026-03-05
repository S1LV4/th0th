/**
 * L2 SQLite Cache
 * 
 * Persistent cache using SQLite (medium speed, persistent)
 */

import { Database } from 'bun:sqlite';
import { CacheLevel } from '@th0th-ai/shared';
import { config } from '@th0th-ai/shared';
import { logger } from '@th0th-ai/shared';

/**
 * L2 SQLite Cache
 */
export class L2SQLiteCache {
  private dbPath: string;
  private defaultTTL: number;
  private db!: Database;

  constructor() {
    const l2Config = config.get('cache').l2;
    this.dbPath = l2Config.dbPath;
    this.defaultTTL = l2Config.defaultTTL;

    this.initialize();
  }

  /**
   * Initialize SQLite database
   */
  private initialize(): void {
    try {
      this.db = new Database(this.dbPath);
      
      // Create cache table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          access_count INTEGER DEFAULT 0,
          size INTEGER NOT NULL
        );
        
        -- Index for expiration cleanup
        CREATE INDEX IF NOT EXISTS idx_expires_at ON cache(expires_at);
        
        -- Index for LRU eviction
        CREATE INDEX IF NOT EXISTS idx_access_count ON cache(access_count);
      `);

      logger.info('L2 SQLite cache initialized', { dbPath: this.dbPath });

    } catch (error) {
      logger.error('Failed to initialize L2 cache', error as Error);
      throw error;
    }
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const row = this.db.prepare(
        'SELECT value, expires_at FROM cache WHERE key = ?'
      ).get(key) as { value: string; expires_at: number } | undefined;
      
      if (!row) return null;
      
      if (Date.now() > row.expires_at) {
        await this.delete(key);
        return null;
      }
      
      // Update access count
      this.db.prepare(
        'UPDATE cache SET access_count = access_count + 1 WHERE key = ?'
      ).run(key);
      
      return JSON.parse(row.value) as T;

    } catch (error) {
      logger.error('L2 cache get failed', error as Error, { key });
      return null;
    }
  }

  /**
   * Set value in cache
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const finalTTL = ttl ?? this.defaultTTL;
      const valueStr = JSON.stringify(value);
      const now = Date.now();
      const expiresAt = now + (finalTTL * 1000);
      const size = Buffer.byteLength(valueStr, 'utf8');

      this.db.prepare(`
        INSERT OR REPLACE INTO cache (key, value, created_at, expires_at, size, access_count)
        VALUES (?, ?, ?, ?, ?, COALESCE((SELECT access_count FROM cache WHERE key = ?), 0))
      `).run(key, valueStr, now, expiresAt, size, key);

      logger.debug('L2 cache set', { key, size, ttl: finalTTL });

    } catch (error) {
      logger.error('L2 cache set failed', error as Error, { key });
      throw error;
    }
  }

  /**
   * Delete from cache
   */
  async delete(key: string): Promise<boolean> {
    try {
      const result = this.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      return result.changes > 0;

    } catch (error) {
      logger.error('L2 cache delete failed', error as Error, { key });
      return false;
    }
  }

  /**
   * Clear entire cache
   */
  async clear(): Promise<void> {
    try {
      this.db.prepare('DELETE FROM cache').run();
      logger.info('L2 cache cleared');

    } catch (error) {
      logger.error('L2 cache clear failed', error as Error);
      throw error;
    }
  }

  /**
   * Invalidate entries matching pattern
   */
  async invalidate(pattern: string): Promise<number> {
    try {
      const result = this.db.prepare(
        'DELETE FROM cache WHERE key LIKE ?'
      ).run(`${pattern}%`);
      
      logger.debug('L2 cache invalidated', { pattern, count: result.changes });
      return result.changes;

    } catch (error) {
      logger.error('L2 cache invalidate failed', error as Error, { pattern });
      return 0;
    }
  }

  /**
   * Clean expired entries
   */
  async cleanExpired(): Promise<number> {
    try {
      const now = Date.now();
      const result = this.db.prepare(
        'DELETE FROM cache WHERE expires_at < ?'
      ).run(now);

      if (result.changes > 0) {
        logger.info('L2 cache expired entries cleaned', { count: result.changes });
      }

      return result.changes;

    } catch (error) {
      logger.error('L2 cache clean failed', error as Error);
      return 0;
    }
  }

  /**
   * Evict least recently used entries if cache exceeds size limit
   */
  async evictLRU(maxEntries: number): Promise<number> {
    try {
      const result = this.db.prepare(`
        DELETE FROM cache 
        WHERE key IN (
          SELECT key FROM cache 
          ORDER BY access_count ASC, created_at ASC 
          LIMIT MAX(0, (SELECT COUNT(*) FROM cache) - ?)
        )
      `).run(maxEntries);

      if (result.changes > 0) {
        logger.info('L2 cache LRU eviction', { evicted: result.changes });
      }

      return result.changes;

    } catch (error) {
      logger.error('L2 cache eviction failed', error as Error);
      return 0;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{ 
    entries: number; 
    size: number; 
    expired: number;
    avgAccessCount: number;
  }> {
    try {
      const result = this.db.prepare(`
        SELECT 
          COUNT(*) as entries, 
          SUM(size) as size,
          AVG(access_count) as avgAccessCount,
          SUM(CASE WHEN expires_at < ? THEN 1 ELSE 0 END) as expired
        FROM cache
      `).get(Date.now()) as {
        entries: number;
        size: number | null;
        avgAccessCount: number | null;
        expired: number;
      };

      return {
        entries: result.entries,
        size: result.size || 0,
        avgAccessCount: result.avgAccessCount || 0,
        expired: result.expired
      };

    } catch (error) {
      logger.error('L2 cache stats failed', error as Error);
      return { entries: 0, size: 0, expired: 0, avgAccessCount: 0 };
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    try {
      this.db?.close();
      logger.info('L2 cache database closed');

    } catch (error) {
      logger.error('L2 cache close failed', error as Error);
    }
  }
}
