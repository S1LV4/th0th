/**
 * Memory Repository - PostgreSQL Implementation (raw SQL)
 *
 * All queries use $executeRaw / $queryRaw to avoid the Prisma 7.7.0 +
 * @prisma/adapter-pg + Bun incompatibility (isObjectEnumValue bug).
 *
 * ORM filter methods (findMany, updateMany, create, etc.) crash at runtime
 * with: "(0, Ao.isObjectEnumValue) is not a function".
 * Raw-SQL paths work correctly — both in the API server and in bun:test.
 */

import { logger } from "@th0th-ai/shared";
import { Prisma } from "../../generated/prisma/index.js";
import { getPrismaClient } from "../../services/query/prisma-client.js";
import type { PrismaClient } from "../../generated/prisma/index.js";
import type { InsertMemoryInput, MemoryRow, SearchFilters } from "./memory-repository.js";

// ── Raw row shape returned by $queryRaw ──────────────────────────────────────

interface RawMemory {
  id: string;
  content: string;
  type: string;
  level: number;
  user_id: string | null;
  session_id: string | null;
  project_id: string | null;
  agent_id: string | null;
  importance: number;
  tags: string[] | null; // PostgreSQL text[] → pg driver returns JS string[]
  embedding: Buffer | null;
  metadata: unknown | null;
  created_at: Date;
  updated_at: Date;
  access_count: number;
  last_accessed: Date | null;
}

export class MemoryRepositoryPg {
  private static instance: MemoryRepositoryPg | null = null;
  private prisma: PrismaClient;

  private constructor() {
    this.prisma = getPrismaClient();
    logger.info("MemoryRepositoryPg initialized (PostgreSQL, raw SQL)");
  }

  static getInstance(): MemoryRepositoryPg {
    if (!MemoryRepositoryPg.instance) {
      MemoryRepositoryPg.instance = new MemoryRepositoryPg();
    }
    return MemoryRepositoryPg.instance;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Convert a raw DB row to the MemoryRow interface used by the rest of the app. */
  private toMemoryRow(m: RawMemory): MemoryRow {
    const tagsArr = Array.isArray(m.tags) ? m.tags : [];
    return {
      id: m.id,
      content: m.content,
      type: m.type,
      level: m.level,
      user_id: m.user_id,
      session_id: m.session_id,
      project_id: m.project_id,
      agent_id: m.agent_id,
      importance: m.importance,
      tags: JSON.stringify(tagsArr),
      embedding: m.embedding,
      metadata: m.metadata ? JSON.stringify(m.metadata) : null,
      created_at: m.created_at instanceof Date ? m.created_at.getTime() : Number(m.created_at),
      updated_at: m.updated_at instanceof Date ? m.updated_at.getTime() : Number(m.updated_at),
      access_count: m.access_count,
      last_accessed: m.last_accessed instanceof Date ? m.last_accessed.getTime() : (m.last_accessed ? Number(m.last_accessed) : null),
    };
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /**
   * Insert a new memory using raw SQL ($executeRaw).
   * Bypasses Prisma ORM to avoid the isObjectEnumValue Bun incompatibility.
   */
  async insert(input: InsertMemoryInput): Promise<void> {
    const now = new Date();
    const embeddingBuf = input.embedding && input.embedding.length > 0
      ? Buffer.from(new Float32Array(input.embedding).buffer)
      : null;
    const metadataJson = JSON.stringify(input.metadata || { type: input.type, importance: input.importance });
    const tagsArray = input.tags ?? [];

    await this.prisma.$executeRaw`
      INSERT INTO memories (
        id, content, type, level,
        user_id, session_id, project_id, agent_id,
        importance, tags, embedding, metadata,
        created_at, updated_at, access_count
      ) VALUES (
        ${input.id},
        ${input.content},
        ${input.type},
        ${input.level},
        ${input.userId ?? null},
        ${input.sessionId ?? null},
        ${input.projectId ?? null},
        ${input.agentId ?? null},
        ${input.importance},
        ${tagsArray},
        ${embeddingBuf},
        ${metadataJson}::jsonb,
        ${now},
        ${now},
        0
      )
    `;
  }

  /**
   * Get a single memory by ID.
   */
  async getById(id: string): Promise<MemoryRow | null> {
    const rows = await this.prisma.$queryRaw<RawMemory[]>`
      SELECT id, content, type, level,
             user_id, session_id, project_id, agent_id,
             importance, tags, embedding, metadata,
             created_at, updated_at, access_count, last_accessed
      FROM memories
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ? this.toMemoryRow(rows[0]) : null;
  }

  /**
   * Search memories with filters (used by MemoryConsolidationJob, etc.)
   */
  async search(filters: SearchFilters): Promise<MemoryRow[]> {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`importance >= ${filters.minImportance}`,
    ];

    if (filters.userId)    conditions.push(Prisma.sql`user_id = ${filters.userId}`);
    if (filters.sessionId) conditions.push(Prisma.sql`session_id = ${filters.sessionId}`);
    if (filters.projectId) conditions.push(Prisma.sql`project_id = ${filters.projectId}`);
    if (filters.agentId)   conditions.push(Prisma.sql`agent_id = ${filters.agentId}`);

    if (filters.types && filters.types.length > 0) {
      conditions.push(Prisma.sql`type = ANY(${filters.types}::text[])`);
    }

    const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

    const rows = await this.prisma.$queryRaw<RawMemory[]>`
      SELECT id, content, type, level,
             user_id, session_id, project_id, agent_id,
             importance, tags, embedding, metadata,
             created_at, updated_at, access_count, last_accessed
      FROM memories
      ${whereClause}
      ORDER BY importance DESC, created_at DESC
      LIMIT ${filters.limit}
    `;

    return rows.map(r => this.toMemoryRow(r));
  }

  /**
   * Full-text search: word-level ILIKE OR matching, with scope filters.
   * Mirrors the SQLite FTS5 behaviour: each whitespace-separated token is
   * searched independently; results are returned if ANY token matches.
   */
  async fullTextSearch(
    query: string,
    limit: number,
    filters?: {
      userId?: string;
      sessionId?: string;
      projectId?: string;
      agentId?: string;
      minImportance?: number;
    },
  ): Promise<MemoryRow[]> {
    // Split the query into individual tokens and build per-token ILIKE clauses.
    // Each token is escaped for ILIKE special chars (%, _) so stray underscores
    // in random strings don't act as wildcards.
    const tokens = query.trim().split(/\s+/).filter((t) => t.length > 0);
    const escaped = tokens.map((t) => `%${t.replace(/[%_\\]/g, '\\$&')}%`);

    // Build: (content ILIKE 'token1' OR content ILIKE 'token2' …)
    const tokenClauses: Prisma.Sql[] = escaped.map(
      (pat) => Prisma.sql`content ILIKE ${pat}`,
    );
    const contentCondition = Prisma.sql`(${Prisma.join(tokenClauses, ' OR ')})`;

    const conditions: Prisma.Sql[] = [contentCondition];

    if (filters?.userId)        conditions.push(Prisma.sql`user_id = ${filters.userId}`);
    if (filters?.sessionId)     conditions.push(Prisma.sql`session_id = ${filters.sessionId}`);
    if (filters?.projectId)     conditions.push(Prisma.sql`project_id = ${filters.projectId}`);
    if (filters?.agentId)       conditions.push(Prisma.sql`agent_id = ${filters.agentId}`);
    if (filters?.minImportance != null) conditions.push(Prisma.sql`importance >= ${filters.minImportance}`);

    const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

    const rows = await this.prisma.$queryRaw<RawMemory[]>`
      SELECT id, content, type, level,
             user_id, session_id, project_id, agent_id,
             importance, tags, embedding, metadata,
             created_at, updated_at, access_count, last_accessed
      FROM memories
      ${whereClause}
      ORDER BY importance DESC, created_at DESC
      LIMIT ${limit}
    `;

    return rows.map(r => this.toMemoryRow(r));
  }

  /**
   * Update importance score.
   */
  async updateImportance(id: string, importance: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE memories SET importance = ${importance}, updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  /**
   * Increment access count and set last_accessed timestamp.
   */
  async incrementAccessCount(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE memories
      SET access_count = access_count + 1,
          last_accessed = NOW()
      WHERE id = ${id}
    `;
  }

  /**
   * Delete a memory by ID.
   */
  async delete(id: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM memories WHERE id = ${id}`;
  }

  /**
   * List memories with pagination.
   */
  async list(limit: number, offset: number): Promise<MemoryRow[]> {
    const rows = await this.prisma.$queryRaw<RawMemory[]>`
      SELECT id, content, type, level,
             user_id, session_id, project_id, agent_id,
             importance, tags, embedding, metadata,
             created_at, updated_at, access_count, last_accessed
      FROM memories
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(r => this.toMemoryRow(r));
  }

  /**
   * No-op — connection is managed by the singleton PrismaClient.
   */
  async close(): Promise<void> {}
}
