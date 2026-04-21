import { logger, MemoryLevel } from "@th0th-ai/shared";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { Prisma } from "../../generated/prisma/index.js";
import { getPrismaClient } from "../query/prisma-client.js";

interface ConsolidationStats {
  promoted: number;
  decayed: number;
  pruned: number;
  edgesCleaned: number;
}

/**
 * Per-type decay rates (applied every 7 days without access).
 */
const DECAY_RATES: Record<string, number> = {
  critical: 0.97,
  decision: 0.95,
  pattern: 0.94,
  code: 0.93,
  conversation: 0.88,
};

const DEFAULT_DECAY_RATE = 0.92;

/**
 * Background consolidation for long-running memory quality.
 * Uses Prisma/PostgreSQL for all database operations.
 */
export class MemoryConsolidationJob {
  private running = false;
  private lastRunAt = 0;
  private runCount = 0;
  private readonly minIntervalMs = 5 * 60 * 1000;

  private isPostgresEnabled(): boolean {
    const databaseUrl = process.env.DATABASE_URL;
    return (
      databaseUrl?.startsWith("postgresql://") === true ||
      databaseUrl?.startsWith("postgres://") === true
    );
  }

  maybeRun(trigger: "store" | "search" = "store"): void {
    if (!this.isPostgresEnabled()) {
      return;
    }

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

    try {
      const prisma = getPrismaClient();
      const stats = await this.consolidate(prisma);

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
    }
  }

  private async consolidate(prisma: PrismaClient): Promise<ConsolidationStats> {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;

    const promoted = await this.promoteSessionMemories(prisma, now, day);
    const decayed = await this.decayStaleMemories(prisma, now, day);
    const pruned = await this.pruneOldLowSignalMemories(prisma, now, day);

    return { promoted, decayed, pruned, edgesCleaned: 0 };
  }

  private async promoteSessionMemories(
    prisma: PrismaClient,
    now: Date,
    day: number,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - day);

    // Uses $executeRaw to avoid the Prisma 7.7.0 + @prisma/adapter-pg + Bun
    // isObjectEnumValue bug that crashes all ORM filter methods at runtime.
    //
    // Promotes SESSION memories (level=3) → USER (level=2) when they:
    //   - are > 24h old
    //   - have type in conversation/decision/pattern
    //   - have importance >= 0.7
    //   - have been accessed at least 3 times
    // Capped at 120 rows per cycle to keep the job fast.
    const result = await prisma.$executeRaw`
      UPDATE memories
      SET   level      = ${MemoryLevel.USER},
            importance = LEAST(1.0, importance + 0.08),
            updated_at = NOW()
      WHERE id IN (
        SELECT id FROM memories
        WHERE level        = ${MemoryLevel.SESSION}
          AND type         IN ('conversation', 'decision', 'pattern')
          AND created_at   < ${cutoff}
          AND importance  >= 0.7
          AND access_count >= 3
        LIMIT 120
      )
    `;

    return result;
  }

  private async decayStaleMemories(
    prisma: PrismaClient,
    now: Date,
    day: number,
  ): Promise<number> {
    const staleThreshold = new Date(now.getTime() - 7 * day);
    let totalDecayed = 0;

    // One UPDATE per type — no N+1. Uses raw SQL because Prisma's updateMany
    // does not support multiplying the current column value in a single query.
    // PostgreSQL does not support LIMIT in UPDATE, so we use a CTE to cap rows.
    for (const [memType, rate] of Object.entries(DECAY_RATES)) {
      const result = await prisma.$executeRaw`
        UPDATE memories
        SET   importance = GREATEST(0.1, importance * ${rate}),
              updated_at = NOW()
        WHERE id IN (
          SELECT id FROM memories
          WHERE type        = ${memType}
            AND importance  < 0.8
            AND created_at  < ${staleThreshold}
            AND (last_accessed IS NULL OR last_accessed < ${staleThreshold})
          LIMIT 500
        )
      `;
      totalDecayed += result;
    }

    // Catch-all for types not in DECAY_RATES
    const knownTypes = Object.keys(DECAY_RATES);
    const othersResult = await prisma.$executeRaw`
      UPDATE memories
      SET   importance = GREATEST(0.1, importance * ${DEFAULT_DECAY_RATE}),
            updated_at = NOW()
      WHERE id IN (
        SELECT id FROM memories
        WHERE type        NOT IN (${Prisma.join(knownTypes)})
          AND importance  < 0.8
          AND created_at  < ${staleThreshold}
          AND (last_accessed IS NULL OR last_accessed < ${staleThreshold})
        LIMIT 500
      )
    `;
    totalDecayed += othersResult;

    return totalDecayed;
  }

  private async pruneOldLowSignalMemories(
    prisma: PrismaClient,
    now: Date,
    day: number,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - 45 * day);

    // Uses $executeRaw to avoid the Prisma 7.7.0 + @prisma/adapter-pg + Bun
    // isObjectEnumValue bug. PostgreSQL does not support LIMIT in DELETE, so we
    // use a subquery with LIMIT to cap the affected rows per cycle.
    const result = await prisma.$executeRaw`
      DELETE FROM memories
      WHERE id IN (
        SELECT id FROM memories
        WHERE created_at   < ${cutoff}
          AND importance   < 0.25
          AND access_count < 2
        LIMIT 200
      )
    `;

    return result;
  }
}

export const memoryConsolidationJob = new MemoryConsolidationJob();
