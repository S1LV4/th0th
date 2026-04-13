/**
 * Keyword Search - PostgreSQL Implementation
 *
 * Uses PostgreSQL full-text search with to_tsvector for FTS capabilities.
 */

import { SearchResult, SearchSource } from "@th0th-ai/shared";
import { logger } from "@th0th-ai/shared";
import { getPgPool } from "../db-connection.js";
import type { Pool } from "pg";

export class KeywordSearchPg {
  private pool: Pool | null = null;
  private initialized = false;

  constructor() {}

  private async getPool(): Promise<Pool> {
    if (!this.pool) {
      this.pool = await getPgPool();
      if (!this.initialized) {
        await this.initTable();
        this.initialized = true;
      }
    }
    return this.pool;
  }

  private async initTable(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS keyword_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        content_tsvector TSVECTOR,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_keyword_project ON keyword_documents(project_id);
      CREATE INDEX IF NOT EXISTS idx_keyword_content_tsvector ON keyword_documents USING GIN(content_tsvector);
      
      CREATE OR REPLACE FUNCTION update_content_tsvector()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.content_tsvector := to_tsvector('english', COALESCE(NEW.content, ''));
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql;
      
      DROP TRIGGER IF EXISTS trigger_update_content_tsvector ON keyword_documents;
      CREATE TRIGGER trigger_update_content_tsvector
        BEFORE INSERT OR UPDATE ON keyword_documents
        FOR EACH ROW
        EXECUTE FUNCTION update_content_tsvector();
    `);
    
    logger.info('PostgreSQL keyword search initialized');
  }

  async add(id: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const pool = await this.getPool();
    const projectId = metadata?.projectId as string || 'default';
    
    await pool.query(
      `INSERT INTO keyword_documents (id, project_id, content, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [id, projectId, content, JSON.stringify(metadata || {})]
    );
  }

  // Alias for compatibility
  async index(id: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.add(id, content, metadata);
  }

  async addBatch(documents: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const doc of documents) {
        const projectId = doc.metadata?.projectId as string || 'default';
        await client.query(
          `INSERT INTO keyword_documents (id, project_id, content, metadata)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             metadata = EXCLUDED.metadata,
             updated_at = NOW()`,
          [doc.id, projectId, doc.content, JSON.stringify(doc.metadata || {})]
        );
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async search(
    query: string,
    projectId?: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const pool = await this.getPool();
    
    const searchTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 2)
      .map(t => `${t}:*`)
      .join(' | ');

    if (!searchTerms) return [];

    const queryText = projectId
      ? `SELECT id, content, metadata,
           ts_rank_cd(content_tsvector, to_tsquery('english', $1)) as rank
         FROM keyword_documents
         WHERE project_id = $2
           AND content_tsvector @@ to_tsquery('english', $1)
         ORDER BY rank DESC
         LIMIT $3`
      : `SELECT id, content, metadata,
           ts_rank_cd(content_tsvector, to_tsquery('english', $1)) as rank
         FROM keyword_documents
         WHERE content_tsvector @@ to_tsquery('english', $1)
         ORDER BY rank DESC
         LIMIT $2`;
    
    const params = projectId ? [searchTerms, projectId, limit] : [searchTerms, limit];
    
    const { rows } = await pool.query(queryText, params);
    
    return rows.map(row => ({
      id: row.id,
      content: row.content,
      score: Math.min(1, parseFloat(row.rank) * 2),
      source: SearchSource.KEYWORD,
      metadata: row.metadata,
    }));
  }

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
    const pool = await this.getPool();
    
    const searchTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 2)
      .map(t => `${t}:*`)
      .join(' | ');

    if (!searchTerms) return [];

    const whereClauses: string[] = ["content_tsvector @@ to_tsquery('english', $1)"];
    const params: any[] = [searchTerms];
    let paramIndex = 2;
    
    if (filters.projectId) {
      whereClauses.push(`project_id = $${paramIndex}`);
      params.push(filters.projectId);
      paramIndex++;
    }
    
    if (filters.userId) {
      whereClauses.push(`metadata->>'userId' = $${paramIndex}`);
      params.push(filters.userId);
      paramIndex++;
    }
    
    if (filters.sessionId) {
      whereClauses.push(`metadata->>'sessionId' = $${paramIndex}`);
      params.push(filters.sessionId);
      paramIndex++;
    }
    
    if (filters.type) {
      whereClauses.push(`metadata->>'type' = $${paramIndex}`);
      params.push(filters.type);
      paramIndex++;
    }
    
    params.push(limit);
    
    const queryText = `
      SELECT id, content, metadata,
        ts_rank_cd(content_tsvector, to_tsquery('english', $1)) as rank
      FROM keyword_documents
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY rank DESC
      LIMIT $${paramIndex}
    `;
    
    const { rows } = await pool.query(queryText, params);
    
    return rows.map(row => ({
      id: row.id,
      content: row.content,
      score: Math.min(1, parseFloat(row.rank) * 2),
      source: SearchSource.KEYWORD,
      metadata: row.metadata,
    }));
  }

  async delete(id: string): Promise<boolean> {
    const pool = await this.getPool();
    const result = await pool.query('DELETE FROM keyword_documents WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteByProject(projectId: string): Promise<number> {
    const pool = await this.getPool();
    const result = await pool.query('DELETE FROM keyword_documents WHERE project_id = $1', [projectId]);
    return result.rowCount ?? 0;
  }

  async clear(): Promise<void> {
    const pool = await this.getPool();
    await pool.query('DELETE FROM keyword_documents');
    logger.info('Keyword search cleared');
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.initialized = false;
    }
  }
}
