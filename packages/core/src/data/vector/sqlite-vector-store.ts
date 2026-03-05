/**
 * SQLite Vector Store
 * 
 * Implementation of vector store using SQLite with projectId namespace support.
 * Replaces ChromaDB dependency with a simpler, multi-tenant SQLite solution.
 * 
 * Features:
 * - Project-based namespace isolation
 * - Embedding storage and similarity search
 * - Integration with existing embedding service
 * - No external dependencies (uses SQLite FTS5 + custom vector similarity)
 */

import { Database } from 'bun:sqlite';
import { IVectorStore, IVectorCollection, VectorDocument } from '@th0th-ai/shared';
import { SearchResult, SearchSource } from '@th0th-ai/shared';
import { config } from '@th0th-ai/shared';
import { logger } from '@th0th-ai/shared';
import { EmbeddingService as ChromaEmbeddingService } from '../chromadb/vector-store.js';
import fs from 'fs';
import path from 'path';

/**
 * Vector Store implementation using SQLite
 */
export class SQLiteVectorStore implements IVectorStore {
  private db!: Database;
  private dbPath: string;
  private embeddingService: ChromaEmbeddingService;

  constructor() {
    const vectorConfig = config.get('vectorStore');
    this.dbPath = vectorConfig.dbPath;
    this.embeddingService = new ChromaEmbeddingService();
    
    this.initialize();
  }

  /**
   * Initialize SQLite database with vector storage
   */
  private initialize(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath);

      // Create vector documents table with projectId namespace
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS vector_documents (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT,
          embedding BLOB,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Index for project-based queries
        CREATE INDEX IF NOT EXISTS idx_vector_project_id ON vector_documents(project_id);
        
        -- Composite index for incremental metadata lookups (critical for staleness checks)
        CREATE INDEX IF NOT EXISTS idx_vector_project_file ON vector_documents(project_id, json_extract(metadata, '$.filePath'));
        
        -- Index for content search
        CREATE INDEX IF NOT EXISTS idx_vector_content ON vector_documents(content);
        
        -- Index for recency
        CREATE INDEX IF NOT EXISTS idx_vector_created_at ON vector_documents(created_at);
      `);

      logger.info('SQLite Vector Store initialized', {
        dbPath: this.dbPath
      });

    } catch (error) {
      logger.error('Failed to initialize SQLite Vector Store', error as Error);
      throw error;
    }
  }

  /**
   * Add document to vector store with projectId namespace
   */
  async addDocument(
    id: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      const projectId = metadata?.projectId as string || 'default';
      
      // Generate embedding
      const embedding = await this.embeddingService.embed(content);
      
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO vector_documents 
        (id, project_id, content, metadata, embedding, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        id,
        projectId,
        content,
        JSON.stringify(metadata || {}),
        Buffer.from(new Float32Array(embedding).buffer),
        Date.now(),
        Date.now()
      );

      logger.debug('Document added to vector store', { id, projectId });

    } catch (error) {
      logger.error('Failed to add document to vector store', error as Error, { id });
      throw error;
    }
  }

  /**
   * Add multiple documents in batch
   *
   * Uses sub-batching to prevent overwhelming Ollama:
   * - Splits documents into small sub-batches (EMBED_SUB_BATCH_SIZE)
   * - Each sub-batch gets its own embedBatch() call
   * - If a sub-batch fails, falls back to per-document embedding for that sub-batch only
   *
   * This avoids the previous problem where 50+ chunks from a large .md file
   * would be sent as a single Ollama API call, causing 500 errors.
   */
  async addDocuments(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;

    // Sub-batch size: max texts per single embedBatch() call to Ollama
    // Ollama bge-m3 crashes on large batches (50+), 8 is safe and fast
    const EMBED_SUB_BATCH_SIZE = 8;

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO vector_documents 
      (id, project_id, content, metadata, embedding, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((docs: VectorDocument[], embeds: number[][]) => {
      const now = Date.now();
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const projectId = doc.metadata?.projectId as string || 'default';
        
        insertStmt.run(
          doc.id,
          projectId,
          doc.content,
          JSON.stringify(doc.metadata || {}),
          Buffer.from(new Float32Array(embeds[i]).buffer),
          now,
          now
        );
      }
    });

    let totalInserted = 0;
    let totalFailed = 0;

    // Process in sub-batches
    for (let i = 0; i < documents.length; i += EMBED_SUB_BATCH_SIZE) {
      const subBatch = documents.slice(i, i + EMBED_SUB_BATCH_SIZE);

      try {
        const embeddings = await this.embeddingService.embedBatch(
          subBatch.map(d => d.content)
        );

        insertMany(subBatch, embeddings);
        totalInserted += subBatch.length;

        logger.debug('Sub-batch embedded and inserted', {
          subBatchIndex: Math.floor(i / EMBED_SUB_BATCH_SIZE),
          count: subBatch.length,
          totalProgress: `${Math.min(i + EMBED_SUB_BATCH_SIZE, documents.length)}/${documents.length}`,
        });

      } catch (error) {
        logger.warn('Sub-batch embedding failed, falling back to per-document', {
          subBatchIndex: Math.floor(i / EMBED_SUB_BATCH_SIZE),
          count: subBatch.length,
          error: (error as Error).message,
        });

        // Per-document fallback for this sub-batch only
        for (const doc of subBatch) {
          try {
            const embedding = await this.embeddingService.embed(doc.content);
            const projectId = doc.metadata?.projectId as string || 'default';
            const now = Date.now();

            insertStmt.run(
              doc.id,
              projectId,
              doc.content,
              JSON.stringify(doc.metadata || {}),
              Buffer.from(new Float32Array(embedding).buffer),
              now,
              now
            );

            totalInserted++;
          } catch (singleError) {
            totalFailed++;
            logger.warn('Skipping document due to embedding error', {
              id: doc.id,
              error: (singleError as Error).message,
            });
          }
        }
      }
    }

    logger.debug('Batch documents added to vector store', {
      inserted: totalInserted,
      failed: totalFailed,
      total: documents.length,
    });

    if (totalInserted === 0 && documents.length > 0) {
      throw new Error('Failed to embed all documents in batch and fallback modes');
    }
  }

  /**
   * Search for similar documents with projectId filter
   */
  async search(
    query: string, 
    limit: number = 10,
    projectId?: string
  ): Promise<SearchResult[]> {
    try {
      // Generate query embedding
      const queryEmbedding = await this.embeddingService.embed(query);
      
      // Get all documents for the project (or all if no project specified)
      let docs: Array<{
        id: string;
        content: string;
        metadata: string;
        embedding: Buffer;
      }>;

      if (projectId) {
        const stmt = this.db.prepare(`
          SELECT id, content, metadata, embedding 
          FROM vector_documents 
          WHERE project_id = ?
        `);
        docs = stmt.all(projectId) as any;
      } else {
        const stmt = this.db.prepare(`
          SELECT id, content, metadata, embedding 
          FROM vector_documents
        `);
        docs = stmt.all() as any;
      }

      // Calculate cosine similarity for each document
      const results = docs.map(doc => {
        const embedding = new Float32Array(doc.embedding.buffer, doc.embedding.byteOffset, doc.embedding.length / 4);
        const similarity = this.cosineSimilarity(queryEmbedding, Array.from(embedding));
        
        return {
          id: doc.id,
          content: doc.content,
          score: similarity,
          source: SearchSource.VECTOR,
          metadata: JSON.parse(doc.metadata)
        };
      });

      // Sort by similarity and limit
      return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    } catch (error) {
      logger.error('Vector search failed', error as Error, { query, projectId });
      return [];
    }
  }

  /**
   * Delete document from vector store
   */
  async delete(id: string): Promise<boolean> {
    try {
      const stmt = this.db.prepare('DELETE FROM vector_documents WHERE id = ?');
      const result = stmt.run(id);
      
      logger.debug('Document deleted from vector store', { id });
      return result.changes > 0;

    } catch (error) {
      logger.error('Failed to delete document from vector store', error as Error, { id });
      return false;
    }
  }

  /**
   * Delete all documents for a project
   */
  async deleteByProject(projectId: string): Promise<number> {
    try {
      const stmt = this.db.prepare('DELETE FROM vector_documents WHERE project_id = ?');
      const result = stmt.run(projectId);
      
      logger.info('Project documents deleted from vector store', { 
        projectId, 
        count: result.changes 
      });
      return result.changes;

    } catch (error) {
      logger.error('Failed to delete project documents', error as Error, { projectId });
      return 0;
    }
  }

  /**
   * Update document in vector store
   */
  async update(
    id: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      // Delete and re-add to update embedding
      await this.delete(id);
      await this.addDocument(id, content, metadata);

      logger.debug('Document updated in vector store', { id });

    } catch (error) {
      logger.error('Failed to update document in vector store', error as Error, { id });
      throw error;
    }
  }

  /**
   * List all indexed projects with stats
   */
  async listProjects(): Promise<Array<{
    projectId: string;
    projectPath: string | null;
    documentCount: number;
    totalSize: number;
    lastIndexed: string | null;
  }>> {
    try {
      const rows = this.db.prepare(`
        SELECT 
          project_id,
          COUNT(*) as document_count,
          SUM(LENGTH(content)) as total_size,
          MAX(updated_at) as last_updated
        FROM vector_documents
        WHERE id NOT LIKE '_metadata:%'
        GROUP BY project_id
        ORDER BY last_updated DESC
      `).all() as Array<{
        project_id: string;
        document_count: number;
        total_size: number;
        last_updated: number;
      }>;

      // Enrich with metadata from _metadata: documents
      const metadataStmt = this.db.prepare(`
        SELECT content FROM vector_documents 
        WHERE id = ? AND project_id = ?
      `);

      return rows.map((row) => {
        let projectPath: string | null = null;
        try {
          const meta = metadataStmt.get(`_metadata:${row.project_id}`, row.project_id) as { content: string } | undefined;
          if (meta) {
            const parsed = JSON.parse(meta.content);
            projectPath = parsed.projectPath || null;
          }
        } catch {
          // ignore parse errors
        }

        return {
          projectId: row.project_id,
          projectPath,
          documentCount: row.document_count,
          totalSize: row.total_size || 0,
          lastIndexed: row.last_updated ? new Date(row.last_updated).toISOString() : null,
        };
      });
    } catch (error) {
      logger.error('Failed to list projects', error as Error);
      return [];
    }
  }

  /**
   * Get collection statistics
   */
  async getStats(projectId?: string): Promise<{
    totalDocuments: number;
    totalSize: number;
  }> {
    try {
      let result: { count: number; size: number };

      if (projectId) {
        const stmt = this.db.prepare(`
          SELECT 
            COUNT(*) as count,
            SUM(LENGTH(content) + LENGTH(COALESCE(metadata, '')) + LENGTH(COALESCE(embedding, ''))) as size
          FROM vector_documents 
          WHERE project_id = ?
        `);
        result = stmt.get(projectId) as any;
      } else {
        const stmt = this.db.prepare(`
          SELECT 
            COUNT(*) as count,
            SUM(LENGTH(content) + LENGTH(COALESCE(metadata, '')) + LENGTH(COALESCE(embedding, ''))) as size
          FROM vector_documents
        `);
        result = stmt.get() as any;
      }

      return {
        totalDocuments: result?.count || 0,
        totalSize: result?.size || 0
      };

    } catch (error) {
      logger.error('Failed to get vector store stats', error as Error);
      return { totalDocuments: 0, totalSize: 0 };
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Get or create a collection (for IVectorStore interface compatibility)
   */
  async getCollection(name: string): Promise<IVectorCollection> {
    // SQLite implementation uses projectId as collection name
    return new SQLiteVectorCollection(this.db, name, this.embeddingService);
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    try {
      this.db?.close();
      logger.info('SQLite Vector Store closed');
    } catch (error) {
      logger.error('Failed to close SQLite Vector Store', error as Error);
    }
  }
}

/**
 * SQLite Vector Collection implementation
 */
class SQLiteVectorCollection implements IVectorCollection {
  constructor(
    private db: Database,
    public name: string,
    private embeddingService: ChromaEmbeddingService
  ) {}

  async count(): Promise<number> {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM vector_documents 
      WHERE project_id = ?
    `);
    const result = stmt.get(this.name) as any;
    return result?.count || 0;
  }

  async query(params: any): Promise<SearchResult[]> {
    const nResults = params?.nResults || 10;
    const whereId = params?.where?.id as string | undefined;

    // Fast path used by IndexManager for metadata lookup
    if (whereId) {
      const stmt = this.db.prepare(`
        SELECT id, content, metadata
        FROM vector_documents
        WHERE project_id = ? AND id = ?
        LIMIT ?
      `);

      const rows = stmt.all(this.name, whereId, nResults) as Array<{
        id: string;
        content: string;
        metadata: string;
      }>;

      return rows.map((row) => ({
        id: row.id,
        content: row.content,
        score: 1,
        source: SearchSource.VECTOR,
        metadata: JSON.parse(row.metadata || '{}'),
      }));
    }

    // Fallback: simple project-scoped fetch
    const stmt = this.db.prepare(`
      SELECT id, content, metadata
      FROM vector_documents
      WHERE project_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.name, nResults) as Array<{
      id: string;
      content: string;
      metadata: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      score: 1,
      source: SearchSource.VECTOR,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  async add(documents: VectorDocument[]): Promise<void> {
    if (!documents.length) return;

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO vector_documents
      (id, project_id, content, metadata, embedding, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();

    for (const doc of documents) {
      const embedding = doc.embedding || (await this.embeddingService.embed(doc.content));

      insertStmt.run(
        doc.id,
        this.name,
        doc.content,
        JSON.stringify(doc.metadata || {}),
        Buffer.from(new Float32Array(embedding).buffer),
        now,
        now,
      );
    }
  }

  async delete(ids: string[]): Promise<void> {
    const stmt = this.db.prepare(`
      DELETE FROM vector_documents 
      WHERE id = ? AND project_id = ?
    `);
    
    for (const id of ids) {
      stmt.run(id, this.name);
    }
  }
}

/**
 * Simple embedding service wrapper
 * Uses the existing embedding infrastructure
 */
class EmbeddingService {
  private vectorStoreEmbeddingService: ChromaEmbeddingService;

  constructor() {
    this.vectorStoreEmbeddingService = new ChromaEmbeddingService();
  }

  async embed(text: string): Promise<number[]> {
    return this.vectorStoreEmbeddingService.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.vectorStoreEmbeddingService.embedBatch(texts);
  }
}

// Export singleton instance
export const sqliteVectorStore = new SQLiteVectorStore();
