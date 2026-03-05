/**
 * Redundancy Filter
 *
 * Detects and merges semantically duplicate memories.
 * A memory pair is considered redundant when cosine similarity > threshold
 * (default 0.95). The merge keeps the higher-importance memory and
 * transfers edges / access counts from the duplicate.
 *
 * Integrates with the consolidation job: runs every N consolidation cycles
 * to keep the memory store clean without blocking hot paths.
 */

import { Database } from "bun:sqlite";
import path from "path";
import { config, logger, MemoryRelationType } from "@th0th-ai/shared";
import type { MemoryRowWithEmbedding } from "../graph/types.js";

// ── Public types ─────────────────────────────────────────────

export interface DuplicatePair {
  keepId: string;
  removeId: string;
  similarity: number;
  /** Why we chose to keep one over the other */
  reason: string;
}

export interface MergeResult {
  merged: number;
  edgesTransferred: number;
  accessCountsBoosted: number;
}

export interface CleanupStats {
  duplicatesFound: number;
  merged: number;
  edgesTransferred: number;
  durationMs: number;
}

// ── Implementation ───────────────────────────────────────────

export class RedundancyFilter {
  private db!: Database;
  private static instance: RedundancyFilter | null = null;

  static getInstance(): RedundancyFilter {
    if (!RedundancyFilter.instance) {
      RedundancyFilter.instance = new RedundancyFilter();
    }
    return RedundancyFilter.instance;
  }

  constructor() {
    this.initDb();
  }

  private initDb(): void {
    const dataDir = config.get("dataDir") as string;
    const dbPath = path.join(dataDir, "memories.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 3000");
  }

  // ── Core API ─────────────────────────────────────────────

  /**
   * Scan recent memories for near-duplicates.
   *
   * We limit the scan window to `scanLimit` most-recent memories to
   * keep the O(n^2) comparison tractable. For each pair with similarity
   * above the threshold we pick the "keeper" (higher importance, then
   * more access, then newer).
   */
  findDuplicates(
    threshold: number = 0.95,
    scanLimit: number = 300,
  ): DuplicatePair[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, content, type, level, importance, tags,
               embedding, created_at, updated_at, access_count,
               user_id, session_id, project_id, agent_id
        FROM memories
        WHERE embedding IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(scanLimit) as MemoryRowWithEmbedding[];

    if (rows.length < 2) return [];

    // Parse embeddings once
    const parsed: { row: MemoryRowWithEmbedding; vec: Float32Array }[] = [];

    for (const row of rows) {
      if (!row.embedding) continue;
      const buf =
        row.embedding instanceof Buffer
          ? row.embedding
          : Buffer.from(row.embedding);
      const vec = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength / 4,
      );
      if (vec.every((v) => v === 0)) continue;
      parsed.push({ row, vec });
    }

    // Pairwise cosine similarity (only upper triangle)
    const pairs: DuplicatePair[] = [];
    const alreadyRemoved = new Set<string>();

    for (let i = 0; i < parsed.length; i++) {
      if (alreadyRemoved.has(parsed[i].row.id)) continue;

      for (let j = i + 1; j < parsed.length; j++) {
        if (alreadyRemoved.has(parsed[j].row.id)) continue;
        if (parsed[i].vec.length !== parsed[j].vec.length) continue;

        const sim = this.cosineSimilarity(parsed[i].vec, parsed[j].vec);
        if (sim < threshold) continue;

        // Must be same type to be considered truly redundant
        if (parsed[i].row.type !== parsed[j].row.type) continue;

        const { keepId, removeId, reason } = this.pickKeeper(
          parsed[i].row,
          parsed[j].row,
          sim,
        );

        alreadyRemoved.add(removeId);
        pairs.push({ keepId, removeId, similarity: sim, reason });
      }
    }

    return pairs;
  }

  /**
   * Merge a set of duplicate pairs.
   *
   * For each pair:
   * 1. Transfer graph edges from removeId → keepId
   * 2. Boost keepId's access_count with removeId's count
   * 3. Create a SUPERSEDES edge from keepId → removeId
   * 4. Delete removeId (memory + FTS)
   */
  mergeDuplicates(pairs: DuplicatePair[]): MergeResult {
    if (pairs.length === 0) return { merged: 0, edgesTransferred: 0, accessCountsBoosted: 0 };

    let merged = 0;
    let edgesTransferred = 0;
    let accessCountsBoosted = 0;

    const hasEdgesTable = this.tableExists("memory_edges");

    const txn = this.db.transaction(() => {
      for (const pair of pairs) {
        // 1. Transfer edges
        if (hasEdgesTable) {
          edgesTransferred += this.transferEdges(pair.keepId, pair.removeId);
        }

        // 2. Boost access count
        const removed = this.db
          .prepare("SELECT access_count FROM memories WHERE id = ?")
          .get(pair.removeId) as { access_count: number } | null;

        if (removed && removed.access_count > 0) {
          this.db
            .prepare(
              `
              UPDATE memories
              SET access_count = access_count + ?,
                  updated_at = ?
              WHERE id = ?
            `,
            )
            .run(removed.access_count, Date.now(), pair.keepId);
          accessCountsBoosted++;
        }

        // 3. Delete FTS entry
        this.db
          .prepare(
            `
            DELETE FROM memories_fts
            WHERE rowid IN (
              SELECT rowid FROM memories WHERE id = ?
            )
          `,
          )
          .run(pair.removeId);

        // 4. Delete edges for removed memory
        if (hasEdgesTable) {
          this.db
            .prepare(
              "DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?",
            )
            .run(pair.removeId, pair.removeId);
        }

        // 5. Delete the memory itself
        this.db.prepare("DELETE FROM memories WHERE id = ?").run(pair.removeId);
        merged++;
      }
    });

    txn();

    logger.info("RedundancyFilter: merge complete", {
      merged,
      edgesTransferred,
      accessCountsBoosted,
    });

    return { merged, edgesTransferred, accessCountsBoosted };
  }

  /**
   * Full cleanup cycle: find duplicates then merge them.
   */
  runCleanup(threshold: number = 0.95): CleanupStats {
    const start = Date.now();

    const pairs = this.findDuplicates(threshold);
    const { merged, edgesTransferred } = this.mergeDuplicates(pairs);

    return {
      duplicatesFound: pairs.length,
      merged,
      edgesTransferred,
      durationMs: Date.now() - start,
    };
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Decide which memory to keep in a duplicate pair.
   * Priority: higher importance > more accesses > newer.
   */
  private pickKeeper(
    a: MemoryRowWithEmbedding,
    b: MemoryRowWithEmbedding,
    similarity: number,
  ): { keepId: string; removeId: string; reason: string } {
    // Higher importance wins
    if (a.importance !== b.importance) {
      const keep = a.importance > b.importance ? a : b;
      const remove = keep === a ? b : a;
      return {
        keepId: keep.id,
        removeId: remove.id,
        reason: `Higher importance (${keep.importance.toFixed(2)} vs ${remove.importance.toFixed(2)})`,
      };
    }

    // More access count wins
    if (a.access_count !== b.access_count) {
      const keep = a.access_count > b.access_count ? a : b;
      const remove = keep === a ? b : a;
      return {
        keepId: keep.id,
        removeId: remove.id,
        reason: `More accesses (${keep.access_count} vs ${remove.access_count})`,
      };
    }

    // Newer wins (tie-breaker)
    const keep = a.created_at > b.created_at ? a : b;
    const remove = keep === a ? b : a;
    return {
      keepId: keep.id,
      removeId: remove.id,
      reason: "Newer memory kept (tie-breaker)",
    };
  }

  /**
   * Transfer edges from one memory to another.
   * Edges where removeId is source become keepId → target.
   * Edges where removeId is target become source → keepId.
   * Skips self-edges and conflicts with existing unique constraints.
   */
  private transferEdges(keepId: string, removeId: string): number {
    let transferred = 0;

    // Outgoing edges: removeId → X  becomes  keepId → X
    const outgoing = this.db
      .prepare(
        "SELECT id, target_id, relation_type, weight, evidence FROM memory_edges WHERE source_id = ?",
      )
      .all(removeId) as Array<{
      id: string;
      target_id: string;
      relation_type: string;
      weight: number;
      evidence: string | null;
    }>;

    for (const edge of outgoing) {
      if (edge.target_id === keepId) continue; // Would become self-edge
      try {
        this.db
          .prepare(
            `
            INSERT OR IGNORE INTO memory_edges (id, source_id, target_id, relation_type, weight, evidence, auto_extracted, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
          `,
          )
          .run(
            `edge_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            keepId,
            edge.target_id,
            edge.relation_type,
            edge.weight,
            edge.evidence,
            Date.now(),
          );
        transferred++;
      } catch {
        // Ignore unique constraint violations
      }
    }

    // Incoming edges: X → removeId  becomes  X → keepId
    const incoming = this.db
      .prepare(
        "SELECT id, source_id, relation_type, weight, evidence FROM memory_edges WHERE target_id = ?",
      )
      .all(removeId) as Array<{
      id: string;
      source_id: string;
      relation_type: string;
      weight: number;
      evidence: string | null;
    }>;

    for (const edge of incoming) {
      if (edge.source_id === keepId) continue; // Would become self-edge
      try {
        this.db
          .prepare(
            `
            INSERT OR IGNORE INTO memory_edges (id, source_id, target_id, relation_type, weight, evidence, auto_extracted, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)
          `,
          )
          .run(
            `edge_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            edge.source_id,
            keepId,
            edge.relation_type,
            edge.weight,
            edge.evidence,
            Date.now(),
          );
        transferred++;
      } catch {
        // Ignore unique constraint violations
      }
    }

    return transferred;
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private tableExists(name: string): boolean {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .all(name) as any[];
    return rows.length > 0;
  }

  close(): void {
    this.db?.close();
    RedundancyFilter.instance = null;
  }
}
