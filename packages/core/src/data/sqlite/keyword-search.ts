/**
 * SQLite FTS5 Keyword Search
 * 
 * Full-text search using SQLite FTS5 for fast keyword matching
 */

import { Database } from 'bun:sqlite';
import { IKeywordSearch } from '@th0th-ai/shared';
import { SearchResult, SearchSource } from '@th0th-ai/shared';
import { config } from '@th0th-ai/shared';
import { logger } from '@th0th-ai/shared';
import { sanitizeFTS5Query } from '@th0th-ai/shared';

/**
 * SQLite FTS5 Keyword Search implementation
 */
export class KeywordSearch implements IKeywordSearch {
  private db!: Database;
  private dbPath: string;
  private tableName: string = 'memories_fts';

  constructor() {
    const keywordConfig = config.get('keywordSearch');
    this.dbPath = keywordConfig.dbPath;
    
    this.initialize();
  }

  /**
   * Initialize SQLite database with FTS5
   */
  private initialize(): void {
    try {
      this.db = new Database(this.dbPath);

      // Improve lock tolerance for concurrent read/write workloads
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA busy_timeout = 5000");

      // Create FTS5 virtual table
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING fts5(
          id UNINDEXED,
          content,
          metadata UNINDEXED,
          tokenize = 'porter unicode61'
        );
      `);

      // Create metadata index for filtering
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memories_metadata (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          project_id TEXT,
          session_id TEXT,
          type TEXT,
          created_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_user_id ON memories_metadata(user_id);
        CREATE INDEX IF NOT EXISTS idx_project_id ON memories_metadata(project_id);
      `);

      logger.info('SQLite FTS5 keyword search initialized', {
        dbPath: this.dbPath,
        table: this.tableName,
        busyTimeoutMs: 5000,
        journalMode: 'WAL'
      });

    } catch (error) {
      logger.error('Failed to initialize FTS5 search', error as Error);
      throw error;
    }
  }

  /**
   * Index content for search
   */
  async index(
    id: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO ${this.tableName} (id, content, metadata)
        VALUES (?, ?, ?)
      `);
      stmt.run(id, content, JSON.stringify(metadata || {}));

      // Store metadata separately for filtering
      if (metadata) {
        const metaStmt = this.db.prepare(`
          INSERT OR REPLACE INTO memories_metadata 
          (id, user_id, project_id, session_id, type, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        metaStmt.run(
          id,
          (metadata.userId ?? null) as string | null,
          (metadata.projectId ?? null) as string | null,
          (metadata.sessionId ?? null) as string | null,
          (metadata.type ?? null) as string | null,
          Date.now()
        );
      }

      logger.debug('Content indexed for FTS5 search', { id });

    } catch (error) {
      logger.error('Failed to index content', error as Error, { id });
      throw error;
    }
  }

  /**
   * Search using FTS5
   */
  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    try {
      const sanitizedQuery = sanitizeFTS5Query(query);

      const stmt = this.db.prepare(`
        SELECT 
          id,
          content,
          metadata,
          bm25(${this.tableName}) as score
        FROM ${this.tableName}
        WHERE ${this.tableName} MATCH ?
        ORDER BY score
        LIMIT ?
      `);

      const rows = stmt.all(sanitizedQuery, limit) as Array<{
        id: string;
        content: string;
        metadata: string;
        score: number;
      }>;

      return rows.map(row => ({
        id: row.id,
        content: row.content,
        score: this.normalizeScore(row.score),
        source: SearchSource.KEYWORD,
        metadata: JSON.parse(row.metadata)
      }));

    } catch (error) {
      logger.error('FTS5 search failed', error as Error, { query });
      return [];
    }
  }

  /**
   * Search with metadata filtering
   */
  async searchWithFilter(
    query: string,
    filters: {
      userId?: string;
      projectId?: string;
      sessionId?: string;
      type?: string;
    },
    limit: number = 10
  ): Promise<SearchResult[]> {
    try {
      const sanitizedQuery = sanitizeFTS5Query(query);

      logger.debug("FTS5 searchWithFilter called", {
        originalQuery: query,
        sanitizedQuery,
        filters,
        limit,
      });

      // Build WHERE clause
      const whereClauses: string[] = [`${this.tableName} MATCH ?`];
      const params: any[] = [sanitizedQuery];

      if (filters.userId) {
        whereClauses.push('meta.user_id = ?');
        params.push(filters.userId);
      }
      if (filters.projectId) {
        whereClauses.push('meta.project_id = ?');
        params.push(filters.projectId);
      }
      if (filters.sessionId) {
        whereClauses.push('meta.session_id = ?');
        params.push(filters.sessionId);
      }
      if (filters.type) {
        whereClauses.push('meta.type = ?');
        params.push(filters.type);
      }

      params.push(limit);

      const stmt = this.db.prepare(`
        SELECT 
          fts.id,
          fts.content,
          fts.metadata,
          bm25(${this.tableName}) as score
        FROM ${this.tableName} fts
        INNER JOIN memories_metadata meta ON fts.id = meta.id
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY score
        LIMIT ?
      `);

      const rows = stmt.all(...params) as Array<{
        id: string;
        content: string;
        metadata: string;
        score: number;
      }>;

      return rows.map(row => ({
        id: row.id,
        content: row.content,
        score: this.normalizeScore(row.score),
        source: SearchSource.KEYWORD,
        metadata: JSON.parse(row.metadata)
      }));

    } catch (error) {
      logger.error('FTS5 filtered search failed', error as Error, { filters });
      return [];
    }
  }

  /**
   * Delete from index
   */
  async delete(id: string): Promise<boolean> {
    try {
      const stmt = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
      const metaStmt = this.db.prepare(`DELETE FROM memories_metadata WHERE id = ?`);
      
      stmt.run(id);
      metaStmt.run(id);

      logger.debug('Content deleted from FTS5 index', { id });
      return true;

    } catch (error) {
      logger.error('Failed to delete from FTS5 index', error as Error, { id });
      return false;
    }
  }

  /**
   * Update indexed content
   */
  async update(id: string, content: string): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        UPDATE ${this.tableName} SET content = ? WHERE id = ?
      `);
      stmt.run(content, id);

      logger.debug('Content updated in FTS5 index', { id });

    } catch (error) {
      logger.error('Failed to update FTS5 index', error as Error, { id });
      throw error;
    }
  }

  /**
   * Normalize BM25 score to 0-1 range
   */
  private normalizeScore(bm25Score: number): number {
    // BM25 scores are negative (higher is better)
    // Normalize to 0-1 range approximately
    return 1 / (1 + Math.exp(bm25Score / 10));
  }

  /**
   * Optimize FTS5 index
   */
  async optimize(): Promise<void> {
    try {
      this.db.exec(`INSERT INTO ${this.tableName}(${this.tableName}) VALUES('optimize')`);

      logger.info('FTS5 index optimized');

    } catch (error) {
      logger.error('Failed to optimize FTS5 index', error as Error);
    }
  }

  /**
   * Get index statistics
   */
  async getStats(): Promise<{ totalDocuments: number; indexSize: number }> {
    try {
      const result = this.db.prepare(`
        SELECT COUNT(*) as count FROM ${this.tableName}
      `).get() as { count: number };

      const sizeResult = this.db.prepare(`
        SELECT page_count * page_size as size 
        FROM pragma_page_count(), pragma_page_size()
      `).get() as { size: number };

      return {
        totalDocuments: result.count,
        indexSize: sizeResult.size
      };

    } catch (error) {
      logger.error('Failed to get FTS5 stats', error as Error);
      return { totalDocuments: 0, indexSize: 0 };
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    try {
      this.db?.close();
      
      logger.info('FTS5 search database closed');

    } catch (error) {
      logger.error('Failed to close FTS5 database', error as Error);
    }
  }
}
