/**
 * Embedding Cache - PostgreSQL Implementation
 *
 * Caches embeddings using SHA-256 content hash to avoid redundant API calls.
 * Async implementation using Prisma ORM.
 */

import { createHash } from "crypto";
import { getPrismaClient } from "../query/prisma-client.js";
import { logger } from "@th0th-ai/shared";

const prisma = getPrismaClient();

export interface EmbeddingCacheEntry {
  provider?: string;
  model: string;
  contentHash: string;
  embedding: number[];
  dimensions: number;
  createdAt: number;
}

export interface EmbeddingCacheStats {
  totalEntries: number;
  cacheSize: number; // bytes
  hitRate: number;
  avgDimensions: number;
}

/**
 * Embedding Cache using PostgreSQL
 *
 * Pattern:
 * - Use SHA-256 hash of content as cache key
 * - Store model + hash as composite key
 * - Track dimensions for validation
 * - Automatic cleanup of old entries
 */
export class EmbeddingCachePg {
  private model: string;

  // Stats tracking
  private hits: number = 0;
  private misses: number = 0;

  constructor(provider: string, model: string) {
    this.model = model;
    logger.info("EmbeddingCachePg initialized (PostgreSQL)", { model });
  }

  /**
   * Hash text content using SHA-256
   */
  private hashContent(text: string): string {
    return createHash("sha256").update(text.trim()).digest("hex");
  }

  /**
   * Serialize embedding to bytes (for PostgreSQL BYTEA)
   */
  private serializeEmbedding(embedding: number[]): Uint8Array {
    const buffer = new ArrayBuffer(embedding.length * 4);
    const view = new DataView(buffer);
    embedding.forEach((val, i) => {
      view.setFloat32(i * 4, val, true); // true = little endian
    });
    return new Uint8Array(buffer);
  }

  /**
   * Deserialize embedding from bytes
   */
  private deserializeEmbedding(bytes: Uint8Array): number[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const embedding: number[] = [];
    for (let i = 0; i < bytes.byteLength; i += 4) {
      embedding.push(view.getFloat32(i, true)); // true = little endian
    }
    return embedding;
  }

  /**
   * Get cached embedding for text
   */
  async get(text: string): Promise<number[] | null> {
    const contentHash = this.hashContent(text);

    const entry = await prisma.embeddingCache.findFirst({
      where: { textHash: contentHash, model: this.model },
    });

    if (entry) {
      this.hits++;

      // Update access stats for this (hash, model) pair only
      await prisma.embeddingCache.updateMany({
        where: { textHash: contentHash, model: this.model },
        data: {
          accessedAt: new Date(),
          hitCount: { increment: 1 },
        },
      });

      return this.deserializeEmbedding(entry.embedding);
    }

    this.misses++;
    return null;
  }

  /**
   * Store embedding in cache
   */
  async set(text: string, embedding: number[]): Promise<void> {
    const contentHash = this.hashContent(text);
    const embeddingBytes = this.serializeEmbedding(embedding) as any;

    const existing = await prisma.embeddingCache.findFirst({
      where: { textHash: contentHash, model: this.model },
      select: { textHash: true },
    });

    if (existing) {
      await prisma.embeddingCache.updateMany({
        where: { textHash: contentHash, model: this.model },
        data: { embedding: embeddingBytes, accessedAt: new Date() },
      });
    } else {
      await prisma.embeddingCache.create({
        data: {
          textHash: contentHash,
          embedding: embeddingBytes,
          model: this.model,
          hitCount: 1,
        },
      });
    }
  }

  /**
   * Batch get embeddings
   */
  async getBatch(texts: string[]): Promise<(number[] | null)[]> {
    const hashes = texts.map(text => this.hashContent(text));

    const entries = await prisma.embeddingCache.findMany({
      where: {
        textHash: { in: hashes },
        model: this.model,
      },
    });

    const entryMap = new Map(
      entries.map(entry => [entry.textHash, this.deserializeEmbedding(entry.embedding)])
    );

    return hashes.map(hash => entryMap.get(hash) || null);
  }

  /**
   * Batch store embeddings
   */
  async setBatch(items: Array<{ text: string; embedding: number[] }>): Promise<void> {
    for (const item of items) {
      await this.set(item.text, item.embedding);
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<EmbeddingCacheStats> {
    const [stats] = await prisma.$queryRaw<
      Array<{ total_entries: bigint; total_size: bigint }>
    >`
      SELECT
        COUNT(*)                                    AS total_entries,
        COALESCE(SUM(octet_length(embedding)), 0)   AS total_size
      FROM "EmbeddingCache"
      WHERE model = ${this.model}
    `;

    const totalEntries = Number(stats?.total_entries ?? 0);
    const totalSize = Number(stats?.total_size ?? 0);

    return {
      totalEntries,
      cacheSize: totalSize,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
      avgDimensions: totalEntries > 0 ? totalSize / totalEntries / 4 : 0, // 4 bytes per float32
    };
  }

  /**
   * Clean up old entries
   */
  async cleanup(maxAgeDays: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

    const result = await prisma.embeddingCache.deleteMany({
      where: {
        model: this.model,
        accessedAt: { lt: cutoffDate },
      },
    });

    return result.count;
  }

  /**
   * Clear all cache entries for this model
   */
  async clear(): Promise<number> {
    const result = await prisma.embeddingCache.deleteMany({
      where: { model: this.model },
    });

    this.hits = 0;
    this.misses = 0;

    return result.count;
  }

  /**
   * Get hit rate for monitoring
   */
  getHitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }
}
