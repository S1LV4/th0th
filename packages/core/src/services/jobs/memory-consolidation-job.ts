import { Database } from "bun:sqlite";
import path from "path";
import { config, logger, MemoryLevel } from "@th0th/shared";
import { RedundancyFilter } from "../memory/redundancy-filter.js";

interface ConsolidationStats {
  promoted: number;
  decayed: number;
  pruned: number;
  edgesCleaned: number;
  redundancyCleanup?: {
    duplicatesFound: number;
    merged: number;
    edgesTransferred: number;
    durationMs: number;
  };
}

/**
 * Per-type decay rates (applied every 7 days without access).
 *
 * Decisions decay very slowly because they represent long-lived
 * architectural choices. Conversations decay quickly because
 * they lose relevance fast.
 */
const DECAY_RATES: Record<string, number> = {
  decision: 0.97,
  pattern: 0.94,
  code: 0.90,
  preference: 0.88,
  conversation: 0.78,
};

const DEFAULT_DECAY_RATE = 0.92;

/**
 * Background consolidation for long-running memory quality.
 * - Promotes high-value session memories to user level
 * - Decays stale low-value memories (adaptive per type)
 * - Prunes very old low-signal memories + orphan graph edges
 */
export class MemoryConsolidationJob {
  private running = false;
  private lastRunAt = 0;
  private runCount = 0;
  private readonly minIntervalMs = 5 * 60 * 1000;
  /** Run redundancy cleanup every N consolidation cycles */
  private readonly redundancyCycleInterval = 5;

  maybeRun(trigger: "store" | "search" = "store"): void {
    const now = Date.now();
    if (this.running || now - this.lastRunAt < this.minIntervalMs) {
      return;
    }

    this.lastRunAt = now;
    void this.runOnce(trigger);
  }

  private async runOnce(trigger: "store" | "search"): Promise<void> {
    this.running = true;
    this.runCount++;
    const startedAt = Date.now();
    const dbPath = path.join(config.get("dataDir"), "memories.db");

    let db: Database | null = null;
    try {
      db = new Database(dbPath);
      db.exec("PRAGMA busy_timeout = 3000");

      const stats = db.transaction(() => this.consolidate(db!))();

      // Run redundancy cleanup periodically (every N cycles)
      if (this.runCount % this.redundancyCycleInterval === 0) {
        try {
          const filter = RedundancyFilter.getInstance();
          stats.redundancyCleanup = filter.runCleanup();
        } catch (err) {
          logger.warn("Redundancy cleanup failed", {
            error: (err as Error).message,
          });
        }
      }

      logger.info("Memory consolidation completed", {
        trigger,
        cycle: this.runCount,
        ...stats,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn("Memory consolidation skipped", {
        trigger,
        error: (error as Error).message,
      });
    } finally {
      this.running = false;
      db?.close();
    }
  }

  private consolidate(db: Database): ConsolidationStats {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    const promoted = this.promoteSessionMemories(db, now, day);
    const decayed = this.decayStaleMemories(db, now, day);
    const { pruned, edgesCleaned } = this.pruneOldLowSignalMemories(db, now, day);

    return { promoted, decayed, pruned, edgesCleaned };
  }

  private promoteSessionMemories(db: Database, now: number, day: number): number {
    db.prepare(
      `
        UPDATE memories
        SET level = ?,
            importance = MIN(1.0, importance + 0.08),
            updated_at = ?
        WHERE id IN (
          SELECT id
          FROM memories
          WHERE level = ?
            AND type IN ('conversation', 'decision', 'pattern')
            AND created_at < ?
            AND (importance + MIN(access_count, 12) * 0.04) >= 0.85
          LIMIT 120
        )
      `,
    ).run(MemoryLevel.USER, now, MemoryLevel.SESSION, now - day);

    return this.changes(db);
  }

  /**
   * Adaptive decay: each memory type has its own decay rate.
   * Decay is applied to memories not accessed in the last 7 days.
   */
  private decayStaleMemories(db: Database, now: number, day: number): number {
    let totalDecayed = 0;

    for (const [memType, rate] of Object.entries(DECAY_RATES)) {
      db.prepare(
        `
          UPDATE memories
          SET importance = MAX(0.1, importance * ?),
              updated_at = ?
          WHERE type = ?
            AND importance < 0.8
            AND created_at < ?
            AND (last_accessed IS NULL OR last_accessed < ?)
        `,
      ).run(rate, now, memType, now - 7 * day, now - 7 * day);

      totalDecayed += this.changes(db);
    }

    // Catch-all for any types not in the map
    db.prepare(
      `
        UPDATE memories
        SET importance = MAX(0.1, importance * ?),
            updated_at = ?
        WHERE type NOT IN (${Object.keys(DECAY_RATES).map(() => "?").join(",")})
          AND importance < 0.8
          AND created_at < ?
          AND (last_accessed IS NULL OR last_accessed < ?)
      `,
    ).run(
      DEFAULT_DECAY_RATE,
      now,
      ...Object.keys(DECAY_RATES),
      now - 7 * day,
      now - 7 * day,
    );

    totalDecayed += this.changes(db);
    return totalDecayed;
  }

  private pruneOldLowSignalMemories(
    db: Database,
    now: number,
    day: number,
  ): { pruned: number; edgesCleaned: number } {
    const staleIds = (
      db
        .prepare(
          `
            SELECT id
            FROM memories
            WHERE created_at < ?
              AND importance < 0.25
              AND access_count < 2
            LIMIT 200
          `,
        )
        .all(now - 45 * day) as Array<{ id: string }>
    ).map((row) => row.id);

    if (staleIds.length === 0) {
      return { pruned: 0, edgesCleaned: 0 };
    }

    const placeholders = staleIds.map(() => "?").join(",");

    // Clean FTS index
    db.prepare(
      `
        DELETE FROM memories_fts
        WHERE rowid IN (
          SELECT rowid
          FROM memories
          WHERE id IN (${placeholders})
        )
      `,
    ).run(...staleIds);

    // Clean graph edges connected to pruned memories
    let edgesCleaned = 0;
    const hasEdgesTable =
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_edges'",
          )
          .all() as any[]
      ).length > 0;

    if (hasEdgesTable) {
      db.prepare(
        `
          DELETE FROM memory_edges
          WHERE source_id IN (${placeholders})
             OR target_id IN (${placeholders})
        `,
      ).run(...staleIds, ...staleIds);
      edgesCleaned = this.changes(db);
    }

    // Delete the memories themselves
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(
      ...staleIds,
    );

    return { pruned: this.changes(db), edgesCleaned };
  }

  private changes(db: Database): number {
    const row = db.prepare("SELECT changes() as count").get() as {
      count: number;
    };
    return row.count;
  }
}

export const memoryConsolidationJob = new MemoryConsolidationJob();
