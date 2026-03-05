/**
 * L1 Memory Cache
 * 
 * In-memory LRU cache (fastest tier)
 */

import { CacheEntry } from '../../models/CacheEntry.js';
import { CacheLevel } from '@th0th-ai/shared';
import { config } from '@th0th-ai/shared';
import { logger } from '@th0th-ai/shared';

/**
 * L1 Memory Cache with LRU eviction
 */
export class L1MemoryCache {
  private cache: Map<string, CacheEntry<any>>;
  private maxSize: number;
  private defaultTTL: number;
  private accessPatterns: Map<string, number[]> = new Map(); // Track access times

  constructor() {
    const l1Config = config.get('cache').l1;
    this.cache = new Map();
    this.maxSize = l1Config.maxSize;
    this.defaultTTL = l1Config.defaultTTL;

    // Periodic cleanup of expired entries
    setInterval(() => this.cleanup(), 60000); // Every minute
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (entry.isExpired()) {
      this.cache.delete(key);
      this.accessPatterns.delete(key);
      return null;
    }

    // Record access (for LRU and pattern analysis)
    entry.recordAccess();
    this.recordAccessPattern(key);
    
    // Adaptive TTL: extend if frequently accessed
    if (entry.shouldPromote()) {
      const newTTL = Math.min(entry.ttl * 1.5, this.defaultTTL * 3);
      entry.update(entry.value, newTTL);
      logger.debug('L1 cache entry TTL extended', { key, newTTL });
    }
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value as T;
  }

  /**
   * Set value in cache with intelligent TTL
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    // Calculate adaptive TTL based on access patterns
    const intelligentTTL = ttl ?? this.calculateIntelligentTTL(key);
    const entry = new CacheEntry(key, value, CacheLevel.L1, intelligentTTL);

    // Check size limit
    if (this.getCurrentSize() + entry.size > this.maxSize) {
      await this.evictLRU();
    }

    this.cache.set(key, entry);
  }

  /**
   * Pre-warm cache with commonly accessed entries
   */
  async preWarm(entries: Array<{ key: string; value: any; ttl?: number }>): Promise<void> {
    logger.info('Pre-warming L1 cache', { count: entries.length });
    
    for (const { key, value, ttl } of entries) {
      await this.set(key, value, ttl);
    }
  }

  /**
   * Record access pattern for intelligent TTL
   */
  private recordAccessPattern(key: string): void {
    const pattern = this.accessPatterns.get(key) || [];
    pattern.push(Date.now());
    
    // Keep only last 10 accesses
    if (pattern.length > 10) {
      pattern.shift();
    }
    
    this.accessPatterns.set(key, pattern);
  }

  /**
   * Calculate intelligent TTL based on access patterns
   */
  private calculateIntelligentTTL(key: string): number {
    const pattern = this.accessPatterns.get(key);
    
    if (!pattern || pattern.length < 2) {
      return this.defaultTTL;
    }

    // Calculate average time between accesses
    const intervals: number[] = [];
    for (let i = 1; i < pattern.length; i++) {
      intervals.push(pattern[i] - pattern[i - 1]);
    }

    const avgInterval = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;

    // If accessed frequently (< 5 min between accesses), longer TTL
    if (avgInterval < 300000) { // 5 minutes
      return this.defaultTTL * 2;
    }

    // If accessed rarely (> 1 hour), shorter TTL
    if (avgInterval > 3600000) { // 1 hour
      return Math.max(60, this.defaultTTL / 2);
    }

    return this.defaultTTL;
  }

  /**
   * Delete from cache
   */
  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  /**
   * Clear entire cache
   */
  async clear(): Promise<void> {
    this.cache.clear();
  }

  /**
   * Invalidate entries matching pattern (simple prefix match)
   */
  invalidatePattern(pattern: string): number {
    let count = 0;
    const keysToDelete: string[] = [];

    for (const key of this.cache.keys()) {
      if (key.startsWith(pattern)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      count++;
    }

    return count;
  }

  /**
   * Get current cache size in bytes
   */
  private getCurrentSize(): number {
    let size = 0;
    for (const entry of this.cache.values()) {
      size += entry.size;
    }
    return size;
  }

  /**
   * Evict least recently used entry
   */
  private async evictLRU(): Promise<void> {
    // First key is least recently used (Map maintains insertion order)
    const firstKey = this.cache.keys().next().value;
    
    if (firstKey) {
      this.cache.delete(firstKey);
      logger.debug('L1 cache evicted LRU entry', { key: firstKey });
    }
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    let expired = 0;
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.isExpired()) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      expired++;
    }

    if (expired > 0) {
      logger.debug('L1 cache cleanup', { expired });
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{ size: number; entries: number }> {
    return {
      size: this.getCurrentSize(),
      entries: this.cache.size
    };
  }
}
