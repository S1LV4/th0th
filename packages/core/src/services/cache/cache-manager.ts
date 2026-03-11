/**
 * Cache Manager
 * 
 * Hierarchical cache implementation (L1: Memory, L2: SQLite, L3: Remote)
 */

import { ICacheManager, CacheStats } from '@th0th-ai/shared';
import { CacheEntry as CacheEntryModel } from '../../models/CacheEntry.js';
import { CacheLevel } from '@th0th-ai/shared';
import { logger } from '@th0th-ai/shared';
import { L1MemoryCache } from './l1-memory-cache.js';
import { L2SQLiteCache } from './l2-sqlite-cache.js';

/**
 * Hierarchical Cache Manager
 */
export class CacheManager implements ICacheManager {
  private l1: L1MemoryCache;
  private l2: L2SQLiteCache;
  private l3Enabled: boolean;

  // Statistics
  private stats = {
    l1Hits: 0,
    l1Misses: 0,
    l2Hits: 0,
    l2Misses: 0,
    l3Hits: 0,
    l3Misses: 0
  };

  constructor() {
    this.l1 = new L1MemoryCache();
    this.l2 = new L2SQLiteCache();
    this.l3Enabled = false; // TODO: Integrate with remote L3 cache
    
    logger.info('Cache Manager initialized', {
      l1: 'Memory',
      l2: 'SQLite',
      l3: this.l3Enabled ? 'Remote' : 'Disabled'
    });
  }

  /**
   * Get value from cache (tries L1 → L2 → L3)
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      // Try L1 (Memory)
      const l1Value = await this.l1.get<T>(key);
      if (l1Value !== null) {
        this.stats.l1Hits++;
        logger.debug('Cache hit: L1', { key });
        return l1Value;
      }
      this.stats.l1Misses++;

      // Try L2 (SQLite)
      const l2Value = await this.l2.get<T>(key);
      if (l2Value !== null) {
        this.stats.l2Hits++;
        logger.debug('Cache hit: L2', { key });
        
        // Promote to L1
        await this.l1.set(key, l2Value);
        return l2Value;
      }
      this.stats.l2Misses++;

      // Try L3 (remote) if enabled
      if (this.l3Enabled) {
        // TODO: Implement L3 lookup
        this.stats.l3Misses++;
      }

      logger.debug('Cache miss: all levels', { key });
      return null;

    } catch (error) {
      logger.error('Cache get failed', error as Error, { key });
      return null;
    }
  }

  /**
   * Set value in cache (writes to all levels)
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      // Write to L1
      await this.l1.set(key, value, ttl);
      
      // Write to L2
      await this.l2.set(key, value, ttl);
      
      // Write to L3 if enabled
      if (this.l3Enabled) {
        // TODO: Implement L3 write
      }

      logger.debug('Cache set: all levels', { key, ttl });

    } catch (error) {
      logger.error('Cache set failed', error as Error, { key });
      throw error;
    }
  }

  /**
   * Delete from all cache levels
   */
  async delete(key: string): Promise<boolean> {
    try {
      const results = await Promise.all([
        this.l1.delete(key),
        this.l2.delete(key)
      ]);

      const deleted = results.some(r => r);
      
      if (deleted) {
        logger.debug('Cache delete', { key });
      }

      return deleted;

    } catch (error) {
      logger.error('Cache delete failed', error as Error, { key });
      return false;
    }
  }

  /**
   * Clear cache (optionally with pattern)
   */
  async clear(pattern?: string): Promise<void> {
    try {
      if (pattern) {
        await this.invalidate(pattern);
      } else {
        await Promise.all([
          this.l1.clear(),
          this.l2.clear()
        ]);
        logger.info('Cache cleared: all levels');
      }
    } catch (error) {
      logger.error('Cache clear failed', error as Error, { pattern });
      throw error;
    }
  }

  /**
   * Check if key exists in cache
   */
  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  /**
   * Invalidate cache entries matching pattern
   */
  async invalidate(pattern: string): Promise<number> {
    try {
      const count = await this.l2.invalidate(pattern);
      
      // Also invalidate L1 (simple prefix match)
      this.l1.invalidatePattern(pattern);
      
      logger.info('Cache invalidated', { pattern, count });
      return count;

    } catch (error) {
      logger.error('Cache invalidation failed', error as Error, { pattern });
      return 0;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    const l1Stats = await this.l1.getStats();
    const l2Stats = await this.l2.getStats();

    const totalHits = this.stats.l1Hits + this.stats.l2Hits + this.stats.l3Hits;
    const totalRequests = totalHits + 
      this.stats.l1Misses + this.stats.l2Misses + this.stats.l3Misses;
    
    const totalHitRate = totalRequests > 0 ? totalHits / totalRequests : 0;

    return {
      l1: {
        hits: this.stats.l1Hits,
        misses: this.stats.l1Misses,
        size: l1Stats.size,
        entries: l1Stats.entries
      },
      l2: {
        hits: this.stats.l2Hits,
        misses: this.stats.l2Misses,
        size: l2Stats.size,
        entries: l2Stats.entries
      },
      l3: {
        hits: this.stats.l3Hits,
        misses: this.stats.l3Misses,
        entries: 0
      },
      totalHitRate
    };
  }

  /**
   * Close all cache connections
   */
  async close(): Promise<void> {
    await this.l2.close();
    logger.info('Cache Manager closed');
  }
}
