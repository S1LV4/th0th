/**
 * Embedding Cache
 *
 * Caches embeddings using SHA-256 content hash to avoid redundant API calls
 * Following OpenClaw pattern from openclaw-memory-analysis.md
 */

import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { logger } from "@th0th-ai/shared";
import { config } from "@th0th-ai/shared";

export interface EmbeddingCacheEntry {
  provider: string;
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
 * Embedding Cache using SQLite
 *
 * Pattern from OpenClaw:
 * - Use SHA-256 hash of content as cache key
 * - Store provider + model + hash as composite key
 * - Track dimensions for validation
 * - Automatic cleanup of old entries
 */
export class EmbeddingCache {
  private db!: Database;
  private dbPath: string;
  private provider: string;
  private model: string;

  // Stats tracking
  private hits: number = 0;
  private misses: number = 0;

  constructor(provider: string, model: string) {
    this.provider = provider;
    this.model = model;

    const cacheConfig = config.get("cache");
    this.dbPath = cacheConfig.embedding.dbPath;

    this.initialize();
  }

  /**
   * Initialize SQLite database with OpenClaw schema
   */
  private initialize(): void {
    try {
      this.db = new Database(this.dbPath);

      // Create cache table (OpenClaw pattern)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_cache (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          embedding BLOB NOT NULL,
          dimensions INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (provider, model, content_hash)
        );

        -- Index for cleanup by date
        CREATE INDEX IF NOT EXISTS idx_embedding_cache_created_at
        ON embedding_cache(created_at);

        -- Index for stats queries
        CREATE INDEX IF NOT EXISTS idx_embedding_cache_provider_model
        ON embedding_cache(provider, model);
      `);

      logger.info("Embedding cache initialized", {
        dbPath: this.dbPath,
        provider: this.provider,
        model: this.model,
      });
    } catch (error) {
      logger.error("Failed to initialize embedding cache", error as Error);
      throw error;
    }
  }

  /**
   * Hash text content using SHA-256 (OpenClaw pattern)
   */
  private hashContent(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  /**
   * Get cached embedding
   */
  async get(text: string): Promise<number[] | null> {
    try {
      const hash = this.hashContent(text);

      const stmt = this.db.prepare(`
        SELECT embedding, dimensions
        FROM embedding_cache
        WHERE provider = ? AND model = ? AND content_hash = ?
      `);

      const row = stmt.get(this.provider, this.model, hash) as
        | { embedding: Buffer; dimensions: number }
        | undefined;

      if (!row) {
        this.misses++;
        return null;
      }

      this.hits++;

      // Deserialize embedding from BLOB
      const embedding = this.deserializeEmbedding(
        row.embedding,
        row.dimensions,
      );

      logger.debug("Embedding cache hit", {
        hash: hash.slice(0, 8),
        dimensions: row.dimensions,
      });

      return embedding;
    } catch (error) {
      logger.error("Embedding cache get failed", error as Error);
      return null;
    }
  }

  /**
   * Cache embedding with content hash
   */
  async set(text: string, embedding: number[]): Promise<void> {
    try {
      const hash = this.hashContent(text);
      const dimensions = embedding.length;
      const now = Date.now();

      // Serialize embedding to BLOB
      const embeddingBlob = this.serializeEmbedding(embedding);

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO embedding_cache
        (provider, model, content_hash, embedding, dimensions, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(this.provider, this.model, hash, embeddingBlob, dimensions, now);

      logger.debug("Embedding cached", {
        hash: hash.slice(0, 8),
        dimensions,
        size: embeddingBlob.length,
      });
    } catch (error) {
      logger.error("Embedding cache set failed", error as Error);
      throw error;
    }
  }

  /**
   * Get embeddings for batch of texts
   *
   * Optimized: single SQL query with IN clause instead of N sequential queries.
   * Falls back to sequential for empty input.
   */
  async getBatch(texts: string[]): Promise<Array<number[] | null>> {
    if (texts.length === 0) return [];

    try {
      // Compute all hashes upfront
      const hashes = texts.map((t) => this.hashContent(t));

      // Single batch query with IN clause
      const placeholders = hashes.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT content_hash, embedding, dimensions
           FROM embedding_cache
           WHERE provider = ? AND model = ? AND content_hash IN (${placeholders})`,
        )
        .all(this.provider, this.model, ...hashes) as Array<{
        content_hash: string;
        embedding: Buffer;
        dimensions: number;
      }>;

      // Build a hash → row lookup for O(1) mapping
      const rowByHash = new Map(rows.map((r) => [r.content_hash, r]));

      // Reconstruct results in original order, tracking hits/misses
      return hashes.map((hash) => {
        const row = rowByHash.get(hash);
        if (row) {
          this.hits++;
          return this.deserializeEmbedding(row.embedding, row.dimensions);
        }
        this.misses++;
        return null;
      });
    } catch (error) {
      logger.error("Embedding cache getBatch failed", error as Error);
      // Graceful fallback: sequential get
      const results: Array<number[] | null> = [];
      for (const text of texts) {
        results.push(await this.get(text));
      }
      return results;
    }
  }

  /**
   * Cache batch of embeddings
   */
  async setBatch(texts: string[], embeddings: number[][]): Promise<void> {
    if (texts.length !== embeddings.length) {
      throw new Error("Texts and embeddings arrays must have same length");
    }

    // Prepare statement ONCE outside the loop to avoid repeated SQL compilation
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache
      (provider, model, content_hash, embedding, dimensions, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Use transaction for batch insert
    const transaction = this.db.transaction(
      (items: Array<{ text: string; embedding: number[] }>) => {
        const now = Date.now();
        for (const item of items) {
          const hash = this.hashContent(item.text);
          const dimensions = item.embedding.length;
          const embeddingBlob = this.serializeEmbedding(item.embedding);

          stmt.run(
            this.provider,
            this.model,
            hash,
            embeddingBlob,
            dimensions,
            now,
          );
        }
      },
    );

    const items = texts.map((text, i) => ({ text, embedding: embeddings[i] }));
    transaction(items);

    logger.info("Batch cached", { count: texts.length });
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<EmbeddingCacheStats> {
    try {
      const result = this.db
        .prepare(
          `
        SELECT
          COUNT(*) as totalEntries,
          SUM(LENGTH(embedding)) as cacheSize,
          AVG(dimensions) as avgDimensions
        FROM embedding_cache
        WHERE provider = ? AND model = ?
      `,
        )
        .get(this.provider, this.model) as {
        totalEntries: number;
        cacheSize: number | null;
        avgDimensions: number | null;
      };

      const total = this.hits + this.misses;
      const hitRate = total > 0 ? this.hits / total : 0;

      return {
        totalEntries: result.totalEntries,
        cacheSize: result.cacheSize || 0,
        hitRate,
        avgDimensions: result.avgDimensions || 0,
      };
    } catch (error) {
      logger.error("Failed to get cache stats", error as Error);
      return { totalEntries: 0, cacheSize: 0, hitRate: 0, avgDimensions: 0 };
    }
  }

  /**
   * Clean up old cache entries
   */
  async cleanup(maxAgeMs: number): Promise<number> {
    try {
      const cutoff = Date.now() - maxAgeMs;

      const result = this.db
        .prepare(
          `
        DELETE FROM embedding_cache
        WHERE created_at < ?
      `,
        )
        .run(cutoff);

      if (result.changes > 0) {
        logger.info("Embedding cache cleaned up", {
          removed: result.changes,
          maxAge: `${maxAgeMs / 1000 / 60 / 60}h`,
        });
      }

      return result.changes;
    } catch (error) {
      logger.error("Embedding cache cleanup failed", error as Error);
      return 0;
    }
  }

  /**
   * Serialize embedding to binary format (Float32Array)
   */
  private serializeEmbedding(embedding: number[]): Buffer {
    const float32 = new Float32Array(embedding);
    return Buffer.from(float32.buffer);
  }

  /**
   * Deserialize embedding from binary format
   */
  private deserializeEmbedding(blob: Buffer, dimensions: number): number[] {
    const float32 = new Float32Array(blob.buffer, blob.byteOffset, dimensions);
    return Array.from(float32);
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    try {
      this.db?.close();

      logger.info("Embedding cache closed", {
        hitRate:
          ((this.hits / (this.hits + this.misses)) * 100).toFixed(1) + "%",
        hits: this.hits,
        misses: this.misses,
      });
    } catch (error) {
      logger.error("Failed to close embedding cache", error as Error);
    }
  }
}
