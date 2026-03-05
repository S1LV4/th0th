/**
 * Graph Store
 *
 * CRUD operations for memory edges in the knowledge graph.
 * Uses SQLite for storage, maintaining consistency with the
 * existing memory architecture.
 */

import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";
import {
  MemoryEdge,
  MemoryRelationType,
  config,
  logger,
} from "@th0th-ai/shared";

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  weight: number;
  evidence: string | null;
  auto_extracted: number;
  created_at: number;
}

interface EdgeFilter {
  sourceId?: string;
  targetId?: string;
  relationTypes?: MemoryRelationType[];
  minWeight?: number;
  autoExtractedOnly?: boolean;
  limit?: number;
}

export class GraphStore {
  private db!: Database;
  private static instance: GraphStore | null = null;

  static getInstance(): GraphStore {
    if (!GraphStore.instance) {
      GraphStore.instance = new GraphStore();
    }
    return GraphStore.instance;
  }

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    const dataDir = config.get("dataDir") as string;
    const dbPath = path.join(dataDir, "memories.db");

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec("PRAGMA journal_mode = WAL");

    this.createSchema();
    logger.info("GraphStore initialized", { dbPath });
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        evidence TEXT,
        auto_extracted INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,

        UNIQUE(source_id, target_id, relation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON memory_edges(relation_type);
      CREATE INDEX IF NOT EXISTS idx_edges_weight ON memory_edges(weight DESC);
    `);
  }

  // ── CRUD ──────────────────────────────────────────────────────

  /**
   * Create a new edge between two memories.
   * Returns the edge if created, null if it already exists.
   */
  createEdge(
    sourceId: string,
    targetId: string,
    relationType: MemoryRelationType,
    options: {
      weight?: number;
      evidence?: string;
      autoExtracted?: boolean;
    } = {},
  ): MemoryEdge | null {
    const { weight = 1.0, evidence, autoExtracted = false } = options;

    if (sourceId === targetId) {
      logger.warn("Cannot create self-referencing edge", { sourceId });
      return null;
    }

    const id = this.generateId();
    const now = Date.now();

    try {
      this.db
        .prepare(
          `
        INSERT INTO memory_edges (id, source_id, target_id, relation_type, weight, evidence, auto_extracted, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          sourceId,
          targetId,
          relationType,
          weight,
          evidence ?? null,
          autoExtracted ? 1 : 0,
          now,
        );

      logger.info("Edge created", {
        id,
        source: sourceId,
        target: targetId,
        relation: relationType,
      });

      return {
        id,
        sourceId,
        targetId,
        relationType,
        weight,
        evidence,
        autoExtracted,
        createdAt: new Date(now),
      };
    } catch (error: any) {
      if (error.message?.includes("UNIQUE constraint")) {
        // Edge already exists, update weight if higher
        this.db
          .prepare(
            `
          UPDATE memory_edges
          SET weight = MAX(weight, ?),
              evidence = COALESCE(?, evidence)
          WHERE source_id = ? AND target_id = ? AND relation_type = ?
        `,
          )
          .run(weight, evidence ?? null, sourceId, targetId, relationType);

        logger.info("Edge updated (already existed)", {
          source: sourceId,
          target: targetId,
          relation: relationType,
        });
        return this.getEdge(sourceId, targetId, relationType);
      }

      logger.error("Failed to create edge", error as Error);
      return null;
    }
  }

  /**
   * Get a specific edge by source, target, and relation type.
   */
  getEdge(
    sourceId: string,
    targetId: string,
    relationType: MemoryRelationType,
  ): MemoryEdge | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM memory_edges
      WHERE source_id = ? AND target_id = ? AND relation_type = ?
    `,
      )
      .get(sourceId, targetId, relationType) as EdgeRow | null;

    return row ? this.rowToEdge(row) : null;
  }

  /**
   * Get all edges from a source memory.
   */
  getOutgoingEdges(memoryId: string, filter?: EdgeFilter): MemoryEdge[] {
    return this.queryEdges({ ...filter, sourceId: memoryId });
  }

  /**
   * Get all edges pointing to a target memory.
   */
  getIncomingEdges(memoryId: string, filter?: EdgeFilter): MemoryEdge[] {
    return this.queryEdges({ ...filter, targetId: memoryId });
  }

  /**
   * Get all edges connected to a memory (both directions).
   */
  getAllEdges(memoryId: string, filter?: EdgeFilter): MemoryEdge[] {
    const conditions: string[] = [
      "(source_id = ? OR target_id = ?)",
    ];
    const params: any[] = [memoryId, memoryId];

    if (filter?.relationTypes && filter.relationTypes.length > 0) {
      const placeholders = filter.relationTypes.map(() => "?").join(",");
      conditions.push(`relation_type IN (${placeholders})`);
      params.push(...filter.relationTypes);
    }

    if (filter?.minWeight !== undefined) {
      conditions.push("weight >= ?");
      params.push(filter.minWeight);
    }

    const limit = filter?.limit ?? 50;
    params.push(limit);

    const rows = this.db
      .prepare(
        `
      SELECT * FROM memory_edges
      WHERE ${conditions.join(" AND ")}
      ORDER BY weight DESC, created_at DESC
      LIMIT ?
    `,
      )
      .all(...params) as EdgeRow[];

    return rows.map(this.rowToEdge);
  }

  /**
   * Delete an edge by ID.
   */
  deleteEdge(edgeId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM memory_edges WHERE id = ?")
      .run(edgeId);
    return (result as any).changes > 0;
  }

  /**
   * Delete all edges connected to a memory (called when memory is deleted).
   */
  deleteEdgesForMemory(memoryId: string): number {
    const result = this.db
      .prepare(
        "DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?",
      )
      .run(memoryId, memoryId);
    return (result as any).changes ?? 0;
  }

  /**
   * Update edge weight.
   */
  updateWeight(edgeId: string, weight: number): boolean {
    const clamped = Math.max(0, Math.min(1, weight));
    const result = this.db
      .prepare("UPDATE memory_edges SET weight = ? WHERE id = ?")
      .run(clamped, edgeId);
    return (result as any).changes > 0;
  }

  // ── Analytics ──────────────────────────────────────────────────

  /**
   * Count edges for a given memory (degree centrality).
   */
  getDegree(memoryId: string): { in: number; out: number; total: number } {
    const outRow = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM memory_edges WHERE source_id = ?",
      )
      .get(memoryId) as { count: number };

    const inRow = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM memory_edges WHERE target_id = ?",
      )
      .get(memoryId) as { count: number };

    return {
      in: inRow.count,
      out: outRow.count,
      total: inRow.count + outRow.count,
    };
  }

  /**
   * Find memories with the most connections (hub nodes).
   */
  getHubMemories(limit: number = 10): { memoryId: string; degree: number }[] {
    const rows = this.db
      .prepare(
        `
      SELECT memory_id, COUNT(*) as degree
      FROM (
        SELECT source_id AS memory_id FROM memory_edges
        UNION ALL
        SELECT target_id AS memory_id FROM memory_edges
      )
      GROUP BY memory_id
      ORDER BY degree DESC
      LIMIT ?
    `,
      )
      .all(limit) as { memory_id: string; degree: number }[];

    return rows.map((r) => ({ memoryId: r.memory_id, degree: r.degree }));
  }

  /**
   * Get graph stats.
   */
  getStats(): {
    totalEdges: number;
    byRelation: Record<string, number>;
    autoExtracted: number;
    avgWeight: number;
  } {
    const total = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM memory_edges")
        .get() as { count: number }
    ).count;

    const byRelation = this.db
      .prepare(
        `
      SELECT relation_type, COUNT(*) as count
      FROM memory_edges
      GROUP BY relation_type
    `,
      )
      .all() as { relation_type: string; count: number }[];

    const auto = (
      this.db
        .prepare(
          "SELECT COUNT(*) as count FROM memory_edges WHERE auto_extracted = 1",
        )
        .get() as { count: number }
    ).count;

    const avgWeight = (
      this.db
        .prepare("SELECT AVG(weight) as avg FROM memory_edges")
        .get() as { avg: number | null }
    ).avg ?? 0;

    const relationMap: Record<string, number> = {};
    for (const row of byRelation) {
      relationMap[row.relation_type] = row.count;
    }

    return {
      totalEdges: total,
      byRelation: relationMap,
      autoExtracted: auto,
      avgWeight: Math.round(avgWeight * 100) / 100,
    };
  }

  // ── Private helpers ────────────────────────────────────────────

  private queryEdges(filter: EdgeFilter): MemoryEdge[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.sourceId) {
      conditions.push("source_id = ?");
      params.push(filter.sourceId);
    }

    if (filter.targetId) {
      conditions.push("target_id = ?");
      params.push(filter.targetId);
    }

    if (filter.relationTypes && filter.relationTypes.length > 0) {
      const placeholders = filter.relationTypes.map(() => "?").join(",");
      conditions.push(`relation_type IN (${placeholders})`);
      params.push(...filter.relationTypes);
    }

    if (filter.minWeight !== undefined) {
      conditions.push("weight >= ?");
      params.push(filter.minWeight);
    }

    if (filter.autoExtractedOnly) {
      conditions.push("auto_extracted = 1");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 50;
    params.push(limit);

    const rows = this.db
      .prepare(
        `
      SELECT * FROM memory_edges
      ${where}
      ORDER BY weight DESC, created_at DESC
      LIMIT ?
    `,
      )
      .all(...params) as EdgeRow[];

    return rows.map(this.rowToEdge);
  }

  private rowToEdge(row: EdgeRow): MemoryEdge {
    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      relationType: row.relation_type as MemoryRelationType,
      weight: row.weight,
      evidence: row.evidence ?? undefined,
      autoExtracted: row.auto_extracted === 1,
      createdAt: new Date(row.created_at),
    };
  }

  private generateId(): string {
    return `edge_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db?.close();
    GraphStore.instance = null;
  }
}
