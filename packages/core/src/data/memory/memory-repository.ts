/**
 * Memory Repository
 *
 * Data-access layer for the memories SQLite database.
 * Owns DB initialization, schema creation, migrations, and all raw SQL.
 * No business logic — that lives in MemoryService and MemoryController.
 */

import { config, logger, MemoryLevel, MemoryType } from "@th0th-ai/shared";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";

// ── Row types ────────────────────────────────────────────────

export interface MemoryRow {
  id: string;
  content: string;
  type: string;
  level: number;
  user_id: string | null;
  session_id: string | null;
  project_id: string | null;
  agent_id: string | null;
  importance: number;
  tags: string; // JSON array
  embedding: Buffer | null;
  metadata: string | null; // JSON
  created_at: number;
  updated_at: number;
  access_count: number;
  last_accessed: number | null;
}

export interface InsertMemoryInput {
  id: string;
  content: string;
  type: MemoryType;
  level: MemoryLevel;
  userId?: string;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  importance: number;
  tags: string[];
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface SearchFilters {
  userId?: string;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  types?: MemoryType[];
  minImportance: number;
  includePersistent: boolean;
  limit: number;
}

// ── Repository ───────────────────────────────────────────────

export class MemoryRepository {
  private static instance: MemoryRepository | null = null;
  private db!: Database;

  private constructor() {
    this.initialize();
  }

  static getInstance(): MemoryRepository {
    if (!MemoryRepository.instance) {
      MemoryRepository.instance = new MemoryRepository();
    }
    return MemoryRepository.instance;
  }

  /** Expose the raw database for transactional use (e.g. consolidation job). */
  getDb(): Database {
    return this.db;
  }

  // ── Initialization & Migrations ────────────────────────────

  private initialize(): void {
    const dataDir = config.get("dataDir");
    const dbPath = path.join(dataDir, "memories.db");

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Check if table exists and needs migration BEFORE creating it
    let needsMigration = false;
    try {
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'",
        )
        .all() as any[];

      if (tables.length > 0) {
        const columns = this.db
          .prepare("PRAGMA table_info(memories)")
          .all() as any[];
        const hasAgentId = columns.some((col: any) => col.name === "agent_id");
        needsMigration = !hasAgentId;
      }
    } catch {
      // Ignore errors, will create table below
    }

    // Create memories table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        level INTEGER NOT NULL,
        user_id TEXT,
        session_id TEXT,
        project_id TEXT,
        agent_id TEXT,
        importance REAL DEFAULT 0.5,
        tags TEXT,
        embedding BLOB,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        access_count INTEGER DEFAULT 0,
        last_accessed INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_session_id ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_level ON memories(level);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        tags,
        content='memories',
        content_rowid='rowid'
      );
    `);

    // Run migration if needed
    if (needsMigration) {
      logger.info("Migrating database: adding agent_id column");
      this.db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT");
    }

    // Always ensure agent_id index exists
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id)",
    );

    logger.info("MemoryRepository initialized", { dbPath });
  }

  // ── CRUD ───────────────────────────────────────────────────

  /**
   * Insert a new memory and index it for FTS.
   */
  insert(input: InsertMemoryInput): void {
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, content, type, level,
        user_id, session_id, project_id, agent_id,
        importance, tags, embedding, metadata,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.id,
      input.content,
      input.type,
      input.level,
      input.userId || null,
      input.sessionId || null,
      input.projectId || null,
      input.agentId || null,
      input.importance,
      JSON.stringify(input.tags),
      Buffer.from(new Float32Array(input.embedding).buffer),
      JSON.stringify(
        input.metadata || {
          type: input.type,
          importance: input.importance,
          agentId: input.agentId,
        },
      ),
      now,
      now,
    );

    // Index in FTS5
    this.db
      .prepare(
        `INSERT INTO memories_fts (rowid, content, tags)
         SELECT rowid, content, tags FROM memories WHERE id = ?`,
      )
      .run(input.id);
  }

  /**
   * Full-text search with dynamic filtering.
   * Returns raw rows (no scoring applied).
   */
  fullTextSearch(
    query: string,
    limitOrFilters: number | SearchFilters,
    maybeFilters?: Omit<SearchFilters, "limit" | "includePersistent">,
  ): MemoryRow[] {
    const filters: SearchFilters =
      typeof limitOrFilters === "number"
        ? {
            userId: maybeFilters?.userId,
            sessionId: maybeFilters?.sessionId,
            projectId: maybeFilters?.projectId,
            agentId: maybeFilters?.agentId,
            types: maybeFilters?.types,
            minImportance: maybeFilters?.minImportance ?? 0,
            includePersistent: true,
            limit: limitOrFilters,
          }
        : limitOrFilters;

    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.userId) {
      conditions.push("m.user_id = ?");
      params.push(filters.userId);
    }

    if (filters.projectId) {
      conditions.push("m.project_id = ?");
      params.push(filters.projectId);
    }

    if (filters.agentId) {
      conditions.push("(m.agent_id = ? OR m.agent_id IS NULL)");
      params.push(filters.agentId);
    }

    if (filters.types && filters.types.length > 0) {
      conditions.push(`m.type IN (${filters.types.map(() => "?").join(",")})`);
      params.push(...filters.types);
    }

    conditions.push("m.importance >= ?");
    params.push(filters.minImportance);

    if (!filters.includePersistent && filters.sessionId) {
      conditions.push("m.session_id = ?");
      params.push(filters.sessionId);
    } else if (filters.includePersistent) {
      conditions.push("(m.level <= ? OR (m.level = ? AND m.session_id = ?))");
      params.push(
        MemoryLevel.USER,
        MemoryLevel.SESSION,
        filters.sessionId || "",
      );
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Convert query to OR-based FTS5 syntax for better recall.
    // Each term is wrapped in double quotes to prevent FTS5 from
    // interpreting special characters (e.g. "-" as NOT operator).
    // Without quoting, "Agente-GT" would be parsed as "Agente NOT column:GT"
    // causing "no such column: GT" errors.
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" OR ");

    const sql = `
      SELECT
        m.id, m.content, m.type, m.level,
        m.user_id, m.session_id, m.project_id, m.agent_id,
        m.importance, m.tags, m.embedding,
        m.created_at, m.access_count, m.last_accessed
      FROM memories m
      JOIN memories_fts fts ON m.rowid = fts.rowid
      ${whereClause}
      AND fts.content MATCH ?
      ORDER BY m.importance DESC, m.created_at DESC
      LIMIT ?
    `;

    params.push(ftsQuery);
    params.push(filters.limit);

    return this.db.prepare(sql).all(...params) as MemoryRow[];
  }

  /**
   * Delete all memories belonging to a project.
   * Returns the number of rows deleted.
   */
  deleteByProject(projectId: string): number {
    // Remove from FTS index first (content table trigger would do this, but
    // the FTS table is an external-content table so we must do it manually).
    this.db
      .prepare(
        `INSERT INTO memories_fts(memories_fts, rowid, content, tags)
         SELECT 'delete', m.rowid, m.content, m.tags
         FROM memories m WHERE m.project_id = ?`,
      )
      .run(projectId);

    const result = this.db
      .prepare(`DELETE FROM memories WHERE project_id = ?`)
      .run(projectId);

    return result.changes;
  }

  /**
   * Batch-update access counts for retrieved memories.
   */
  updateAccessCounts(memoryIds: string[]): void {
    if (memoryIds.length === 0) return;

    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1,
          last_accessed = ?
      WHERE id = ?
    `);

    const transaction = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        stmt.run(now, id);
      }
    });

    transaction(memoryIds);
  }

  incrementAccessCount(memoryId: string): void {
    this.updateAccessCounts([memoryId]);
  }
}
