/**
 * Cache Entry Model
 * 
 * Represents a cached item in the hierarchical cache system
 */

import { CacheEntry as ICacheEntry, CacheLevel } from '@th0th-ai/shared';

export class CacheEntry<T = unknown> implements ICacheEntry<T> {
  key: string;
  value: T;
  level: CacheLevel;
  ttl: number;
  createdAt: Date;
  accessCount: number;
  lastAccessed: Date;
  size: number;

  constructor(key: string, value: T, level: CacheLevel, ttl: number) {
    this.key = key;
    this.value = value;
    this.level = level;
    this.ttl = ttl;
    this.createdAt = new Date();
    this.accessCount = 0;
    this.lastAccessed = new Date();
    this.size = this.calculateSize(value);
  }

  /**
   * Check if entry is expired
   */
  isExpired(): boolean {
    const now = Date.now();
    const expiresAt = this.createdAt.getTime() + (this.ttl * 1000);
    return now > expiresAt;
  }

  /**
   * Get remaining TTL in seconds
   */
  getRemainingTTL(): number {
    const now = Date.now();
    const expiresAt = this.createdAt.getTime() + (this.ttl * 1000);
    const remaining = Math.max(0, expiresAt - now);
    return Math.floor(remaining / 1000);
  }

  /**
   * Record access to this entry
   */
  recordAccess(): void {
    this.accessCount++;
    this.lastAccessed = new Date();
  }

  /**
   * Calculate cache entry size in bytes (approximate)
   */
  private calculateSize(value: T): number {
    try {
      return new Blob([JSON.stringify(value)]).size;
    } catch {
      // Fallback: rough estimate
      return JSON.stringify(value).length * 2;
    }
  }

  /**
   * Get age in seconds
   */
  getAge(): number {
    const now = Date.now();
    const age = now - this.createdAt.getTime();
    return Math.floor(age / 1000);
  }

  /**
   * Calculate access frequency (accesses per second)
   */
  getAccessFrequency(): number {
    const age = this.getAge();
    return age > 0 ? this.accessCount / age : this.accessCount;
  }

  /**
   * Determine if entry should be promoted to higher cache level
   */
  shouldPromote(threshold: number = 0.1): boolean {
    // Promote if accessed frequently and still has significant TTL
    const frequency = this.getAccessFrequency();
    const remainingRatio = this.getRemainingTTL() / this.ttl;
    return frequency > threshold && remainingRatio > 0.3;
  }

  /**
   * Determine if entry should be evicted
   */
  shouldEvict(): boolean {
    // Evict if expired or not accessed in a while
    if (this.isExpired()) return true;
    
    const secondsSinceLastAccess = 
      (Date.now() - this.lastAccessed.getTime()) / 1000;
    
    // Evict if not accessed in more than half its TTL
    return secondsSinceLastAccess > (this.ttl / 2);
  }

  /**
   * Update value and reset metadata
   */
  update(value: T, ttl?: number): void {
    this.value = value;
    if (ttl !== undefined) {
      this.ttl = ttl;
    }
    this.createdAt = new Date();
    this.size = this.calculateSize(value);
  }

  /**
   * Convert to plain object
   */
  toJSON(): ICacheEntry<T> {
    return {
      key: this.key,
      value: this.value,
      level: this.level,
      ttl: this.ttl,
      createdAt: this.createdAt,
      accessCount: this.accessCount,
      lastAccessed: this.lastAccessed,
      size: this.size
    };
  }

  /**
   * Create from plain object
   */
  static fromJSON<T>(data: ICacheEntry<T>): CacheEntry<T> {
    const entry = new CacheEntry<T>(
      data.key,
      data.value,
      data.level,
      data.ttl
    );
    entry.createdAt = new Date(data.createdAt);
    entry.accessCount = data.accessCount;
    entry.lastAccessed = new Date(data.lastAccessed);
    entry.size = data.size;
    return entry;
  }

  /**
   * Get default TTL for cache level
   */
  static getDefaultTTL(level: CacheLevel): number {
    switch (level) {
      case CacheLevel.L1:
        return 300;      // 5 minutes
      case CacheLevel.L2:
        return 3600;     // 1 hour
      default:
        return 1800;     // 30 minutes
    }
  }
}
