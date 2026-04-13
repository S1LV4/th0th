/**
 * PostgreSQL + pgvector Vector Store
 *
 * High-performance vector store using PostgreSQL with pgvector extension.
 *
 * Index strategy (per embedding dimension):
 *   ≤ 2000 dims  →  HNSW on vector column (vector_cosine_ops)   O(log n)
 *   > 2000 dims  →  Two-phase binary quantization search:
 *                     Phase 1: ANN on bit column (bit_hamming_ops, HNSW)  → candidates
 *                     Phase 2: exact cosine re-rank on vector column       → top-k
 *
 * All write/delete/list operations use raw SQL to avoid the Prisma 7.7.0 + Bun ORM bug
 * (isObjectEnumValue is not a function).
 */

import { BaseVectorStore } from './base-vector-store.js';
import {
  IVectorCollection,
  VectorDocument,
  VectorStoreStats,
  ProjectInfo,
  SearchResult,
  SearchSource,
} from '@th0th-ai/shared';
import { logger } from '@th0th-ai/shared';
import type { Pool, PoolConfig } from 'pg';

export interface PostgresConfig {
  connectionString: string;
  poolSize?: number;
  indexType?: 'hnsw' | 'ivfflat';
  indexParams?: {
    m?: number;
    efConstruction?: number;
    lists?: number;
  };
}

export class PostgresVectorStore extends BaseVectorStore {
  private pool: Pool | null = null;
  private config: PostgresConfig;
  private initialized = false;
  private schemaDimensions: number | null = null;
  private tableName: string = 'vector_documents';
  /** True when the table has embedding_bq column + HNSW index. Set during init. */
  private bqEnabled = false;

  constructor(config: PostgresConfig) {
    super();
    this.config = {
      poolSize: 10,
      indexType: 'hnsw',
      indexParams: { m: 16, efConstruction: 64, lists: 100 },
      ...config,
    };
  }

  // ── Table / dimension helpers ──────────────────────────────────────────────

  private getTableName(dimensions: number): string {
    return `vector_documents_${dimensions}d`;
  }

  // ── Binary quantization ────────────────────────────────────────────────────

  /**
   * Convert float32 embedding to a bit-string for binary quantization.
   * Positive (≥ 0) → '1', Negative (< 0) → '0'.
   * The result is passed to PostgreSQL as `$1::bit(N)`.
   */
  private floatsToBit(v: number[]): string {
    return v.map((x) => (x >= 0 ? '1' : '0')).join('');
  }

  // ── Initialization ─────────────────────────────────────────────────────────

  async ensureInitialized(): Promise<Pool> {
    if (this.pool && this.initialized) return this.pool;

    const pg = await import('pg');
    const PgPool = (pg.default as any)?.Pool ?? (pg as any).Pool;

    const poolConfig: PoolConfig = {
      connectionString: this.config.connectionString,
      max: this.config.poolSize,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    const pool = new PgPool(poolConfig) as Pool;
    this.pool = pool;

    const client = await pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');

      const providerDimensions = await this.getEmbeddingDimensions();
      this.tableName = this.getTableName(providerDimensions);
      this.schemaDimensions = providerDimensions;

      // Ensure table exists (migration is the preferred path)
      const { rows } = await client.query(
        `SELECT tablename FROM pg_tables WHERE tablename = $1`,
        [this.tableName],
      );

      if (rows.length === 0) {
        logger.warn(`Table ${this.tableName} not found. Creating fallback table.`, {
          note: 'Run "prisma migrate deploy" to create tables via migrations',
        });
        await this.createFallbackTable(client, providerDimensions);
      }
    } finally {
      client.release();
    }

    await this.createVectorIndex();

    this.initialized = true;
    logger.info('PostgresVectorStore initialized', {
      poolSize: this.config.poolSize,
      indexType: this.config.indexType,
      dimensions: this.schemaDimensions,
      tableName: this.tableName,
      bqEnabled: this.bqEnabled,
    });

    return pool;
  }

  private async createFallbackTable(client: any, dimensions: number): Promise<void> {
    const hasBq = dimensions > 2000;
    const bqCol = hasBq ? `, embedding_bq bit(${dimensions})` : '';

    await client.query(`
      CREATE TABLE ${this.tableName} (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        embedding vector(${dimensions})${bqCol},
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX idx_${this.tableName}_project_id ON ${this.tableName}(project_id)
    `);
  }

  // ── Index creation ─────────────────────────────────────────────────────────

  private async createVectorIndex(): Promise<void> {
    if (this.schemaDimensions && this.schemaDimensions > 2000) {
      await this.createBqIndex();
      return;
    }

    const pool = this.pool!;
    const indexName = `idx_${this.tableName}_embedding`;

    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = $1`,
      [indexName],
    );

    if (rows.length > 0) {
      logger.debug('HNSW index already exists', { indexName });
      return;
    }

    logger.info('Creating HNSW index (this may take a while for large tables)...');

    if (this.config.indexType === 'hnsw') {
      const m = this.config.indexParams?.m ?? 16;
      const efConstruction = this.config.indexParams?.efConstruction ?? 64;

      await pool.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName}
        ON ${this.tableName}
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = ${m}, ef_construction = ${efConstruction})
      `);

      logger.info('HNSW index created', { m, efConstruction });
    } else {
      const lists = this.config.indexParams?.lists ?? 100;

      await pool.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName}
        ON ${this.tableName}
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = ${lists})
      `);

      logger.info('IVFFlat index created', { lists });
    }
  }

  /**
   * Create HNSW index on the binary-quantized bit column.
   * bit_hamming_ops supports any dimension (no pgvector limit).
   */
  private async createBqIndex(): Promise<void> {
    const pool = this.pool!;
    const bqIndexName = `idx_${this.tableName}_embedding_bq`;

    // Check if index already exists
    const { rows: idxRows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = $1`,
      [bqIndexName],
    );

    if (idxRows.length > 0) {
      logger.debug('BQ HNSW index already exists', { bqIndexName });
      this.bqEnabled = true;
      return;
    }

    // Verify the embedding_bq column actually exists
    const { rows: colRows } = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = $1 AND column_name = 'embedding_bq'`,
      [this.tableName],
    );

    if (colRows.length === 0) {
      logger.warn('embedding_bq column not found — BQ disabled. Run prisma migrate deploy.', {
        tableName: this.tableName,
      });
      return;
    }

    logger.info('Creating HNSW index on binary-quantized column...', {
      tableName: this.tableName,
      dimensions: this.schemaDimensions,
    });

    const m = this.config.indexParams?.m ?? 16;
    const efConstruction = this.config.indexParams?.efConstruction ?? 64;

    await pool.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${bqIndexName}
      ON ${this.tableName}
      USING hnsw (embedding_bq bit_hamming_ops)
      WITH (m = ${m}, ef_construction = ${efConstruction})
    `);

    this.bqEnabled = true;
    logger.info('BQ HNSW index created', { bqIndexName, m, efConstruction });
  }

  // ── Write operations (raw SQL — avoids Prisma+Bun ORM bug) ────────────────

  async addDocument(id: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const pool = await this.ensureInitialized();
    const projectId = (metadata?.projectId as string) || 'default';
    const embedding = await this.embedContent(content);

    if (this.schemaDimensions && embedding.length !== this.schemaDimensions) {
      throw new Error(
        `Embedding dimension mismatch: got ${embedding.length}, expected ${this.schemaDimensions}`,
      );
    }

    const vectorString = `[${embedding.join(',')}]`;

    if (this.bqEnabled) {
      const bqString = this.floatsToBit(embedding);
      await pool.query(
        `INSERT INTO ${this.tableName} (id, project_id, content, metadata, embedding, embedding_bq)
         VALUES ($1, $2, $3, $4, $5::vector, $6::bit(${this.schemaDimensions}))
         ON CONFLICT (id) DO UPDATE SET
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding,
           embedding_bq = EXCLUDED.embedding_bq,
           updated_at = NOW()`,
        [id, projectId, content, JSON.stringify(metadata ?? {}), vectorString, bqString],
      );
    } else {
      await pool.query(
        `INSERT INTO ${this.tableName} (id, project_id, content, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)
         ON CONFLICT (id) DO UPDATE SET
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding,
           updated_at = NOW()`,
        [id, projectId, content, JSON.stringify(metadata ?? {}), vectorString],
      );
    }
  }

  async addDocuments(documents: VectorDocument[]): Promise<void> {
    const pool = await this.ensureInitialized();

    const contents = documents.map((d) => d.content);
    const embeddings = await this.embedBatch(contents);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        const embedding = embeddings[i];
        const projectId = (doc.metadata?.projectId as string) || 'default';

        if (this.schemaDimensions && embedding.length !== this.schemaDimensions) {
          throw new Error(
            `Embedding dimension mismatch: got ${embedding.length}, expected ${this.schemaDimensions}`,
          );
        }

        const vectorString = `[${embedding.join(',')}]`;

        if (this.bqEnabled) {
          const bqString = this.floatsToBit(embedding);
          await client.query(
            `INSERT INTO ${this.tableName} (id, project_id, content, metadata, embedding, embedding_bq)
             VALUES ($1, $2, $3, $4, $5::vector, $6::bit(${this.schemaDimensions}))
             ON CONFLICT (id) DO UPDATE SET
               content = EXCLUDED.content,
               metadata = EXCLUDED.metadata,
               embedding = EXCLUDED.embedding,
               embedding_bq = EXCLUDED.embedding_bq,
               updated_at = NOW()`,
            [doc.id, projectId, doc.content, JSON.stringify(doc.metadata ?? {}), vectorString, bqString],
          );
        } else {
          await client.query(
            `INSERT INTO ${this.tableName} (id, project_id, content, metadata, embedding)
             VALUES ($1, $2, $3, $4, $5::vector)
             ON CONFLICT (id) DO UPDATE SET
               content = EXCLUDED.content,
               metadata = EXCLUDED.metadata,
               embedding = EXCLUDED.embedding,
               updated_at = NOW()`,
            [doc.id, projectId, doc.content, JSON.stringify(doc.metadata ?? {}), vectorString],
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async search(query: string, limit: number = 10, projectId?: string): Promise<SearchResult[]> {
    const embedding = await this.embedContent(query);
    return this.searchByEmbedding(embedding, limit, projectId);
  }

  async searchByEmbedding(
    embedding: number[],
    limit: number = 10,
    projectId?: string,
  ): Promise<SearchResult[]> {
    const pool = await this.ensureInitialized();

    if (this.schemaDimensions && embedding.length !== this.schemaDimensions) {
      throw new Error(
        `Embedding dimension mismatch: got ${embedding.length}, expected ${this.schemaDimensions}`,
      );
    }

    if (this.bqEnabled) {
      return this.searchTwoPhase(pool, embedding, limit, projectId);
    }

    return this.searchDirect(pool, embedding, limit, projectId);
  }

  /**
   * Direct cosine similarity search (for dims ≤ 2000 with HNSW index).
   */
  private async searchDirect(
    pool: Pool,
    embedding: number[],
    limit: number,
    projectId?: string,
  ): Promise<SearchResult[]> {
    const vectorString = `[${embedding.join(',')}]`;

    const queryText = projectId
      ? `SELECT id, content, metadata, 1 - (embedding <=> $1::vector) as similarity
         FROM ${this.tableName} WHERE project_id = $2
         ORDER BY embedding <=> $1::vector LIMIT $3`
      : `SELECT id, content, metadata, 1 - (embedding <=> $1::vector) as similarity
         FROM ${this.tableName}
         ORDER BY embedding <=> $1::vector LIMIT $2`;

    const params = projectId ? [vectorString, projectId, limit] : [vectorString, limit];

    const { rows } = await pool.query(queryText, params);

    return rows.map((row: any) => ({
      id: row.id,
      content: row.content,
      score: parseFloat(row.similarity),
      source: SearchSource.VECTOR,
      metadata: row.metadata,
    }));
  }

  /**
   * Two-phase binary-quantization search (for dims > 2000).
   *
   * Phase 1: ANN using Hamming distance on bit column → `candidates` rows
   * Phase 2: exact cosine re-rank on float vector → top `limit` rows
   */
  private async searchTwoPhase(
    pool: Pool,
    embedding: number[],
    limit: number,
    projectId?: string,
  ): Promise<SearchResult[]> {
    const dims = this.schemaDimensions!;
    const bqQuery = this.floatsToBit(embedding);
    const vectorString = `[${embedding.join(',')}]`;
    // Fetch enough candidates so re-ranking is meaningful
    const candidates = Math.min(limit * 20, 200);

    // Phase 1: ANN on binary column
    const phase1Text = projectId
      ? `SELECT id FROM ${this.tableName}
         WHERE project_id = $2 AND embedding_bq IS NOT NULL
         ORDER BY embedding_bq <~> $1::bit(${dims})
         LIMIT $3`
      : `SELECT id FROM ${this.tableName}
         WHERE embedding_bq IS NOT NULL
         ORDER BY embedding_bq <~> $1::bit(${dims})
         LIMIT $2`;

    const phase1Params = projectId ? [bqQuery, projectId, candidates] : [bqQuery, candidates];

    const { rows: candidateRows } = await pool.query(phase1Text, phase1Params);
    if (candidateRows.length === 0) return [];

    const candidateIds: string[] = candidateRows.map((r: any) => r.id);
    const placeholders = candidateIds.map((_: string, i: number) => `$${i + 2}`).join(', ');

    // Phase 2: exact re-rank among candidates
    const { rows } = await pool.query(
      `SELECT id, content, metadata,
              1 - (embedding <=> $1::vector) AS similarity
       FROM ${this.tableName}
       WHERE id IN (${placeholders})
       ORDER BY embedding <=> $1::vector
       LIMIT ${limit}`,
      [vectorString, ...candidateIds],
    );

    return rows.map((row: any) => ({
      id: row.id,
      content: row.content,
      score: parseFloat(row.similarity),
      source: SearchSource.VECTOR,
      metadata: row.metadata,
    }));
  }

  // ── Delete / update ────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    const pool = await this.ensureInitialized();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.tableName} WHERE id = $1`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async deleteByProject(projectId: string): Promise<number> {
    const pool = await this.ensureInitialized();
    const { rowCount } = await pool.query(
      `DELETE FROM ${this.tableName} WHERE project_id = $1`,
      [projectId],
    );
    return rowCount ?? 0;
  }

  async update(id: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.delete(id);
    await this.addDocument(id, content, metadata);
  }

  // ── Stats / metadata ───────────────────────────────────────────────────────

  async getStats(projectId?: string): Promise<VectorStoreStats> {
    const pool = await this.ensureInitialized();

    const queryText = projectId
      ? `SELECT COUNT(*) as count,
                SUM(LENGTH(content) + LENGTH(metadata::text) + COALESCE(LENGTH(embedding::text), 0)) as size
         FROM ${this.tableName} WHERE project_id = $1`
      : `SELECT COUNT(*) as count,
                SUM(LENGTH(content) + LENGTH(metadata::text) + COALESCE(LENGTH(embedding::text), 0)) as size
         FROM ${this.tableName}`;

    const params = projectId ? [projectId] : [];
    const { rows } = await pool.query(queryText, params);

    const bqIndexName = `idx_${this.tableName}_embedding_bq`;
    const floatIndexName = `idx_${this.tableName}_embedding`;
    const activeIndex = this.bqEnabled ? bqIndexName : floatIndexName;

    const { rows: idxRows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = $1`,
      [activeIndex],
    );

    return {
      totalDocuments: parseInt(rows[0]?.count ?? '0'),
      totalSize: parseInt(rows[0]?.size ?? '0'),
      embeddingDimensions: this.schemaDimensions ?? undefined,
      indexType: this.config.indexType,
      indexStatus: idxRows.length > 0 ? 'ready' : 'none',
    };
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const pool = await this.ensureInitialized();

    const { rows } = await pool.query(`
      SELECT project_id,
             COUNT(*) AS doc_count,
             MAX(updated_at) AS last_updated,
             SUM(LENGTH(content)) AS total_size
      FROM ${this.tableName}
      WHERE id NOT LIKE '_metadata:%'
      GROUP BY project_id
      ORDER BY last_updated DESC
    `);

    return rows.map((row: any) => ({
      projectId: row.project_id,
      projectPath: null,
      documentCount: parseInt(row.doc_count),
      totalSize: parseInt(row.total_size ?? '0'),
      lastIndexed: row.last_updated?.toISOString() ?? null,
    }));
  }

  // ── Misc ───────────────────────────────────────────────────────────────────

  async getCollection(name: string): Promise<IVectorCollection> {
    throw new Error('getCollection not implemented for PostgresVectorStore');
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.pool) return false;
      const { rows } = await this.pool.query('SELECT 1');
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
      logger.info('PostgresVectorStore closed');
    }
  }
}
