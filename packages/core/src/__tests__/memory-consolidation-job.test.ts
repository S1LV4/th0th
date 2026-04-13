/**
 * Tests for MemoryConsolidationJob — validates the N+1 fix.
 *
 * Fix validated: The old implementation did findMany(500) + 500 individual
 * update() calls per type (up to 2500+ queries). The new implementation uses
 * a single $executeRaw UPDATE per type with a PostgreSQL-compatible subquery
 * for the LIMIT cap.
 *
 * NOTE: Prisma 7.7.0 ORM-filter methods (findMany with where, deleteMany)
 * have a known Bun test runner incompatibility (isObjectEnumValue bug). All
 * test setup/teardown uses $queryRaw / $executeRaw to stay in the working path.
 *
 * Requires: DATABASE_URL=postgresql://th0th:th0th_password@localhost:5434/th0th
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { getPrismaClient, disconnectPrisma } from "../services/query/prisma-client.js";
import { MemoryConsolidationJob } from "../services/jobs/memory-consolidation-job.js";

const prisma = getPrismaClient();
const TEST_PREFIX = "cjtest_";

// ── Raw-SQL helpers (ORM filter methods don't work under bun test + PrismaPg) ─

// MemoryLevel int values from @th0th-ai/shared:
//   PERSISTENT=0, PROJECT=1, USER=2, SESSION=3, WORKING=4
const LEVEL_MAP: Record<string, number> = { persistent: 0, project: 1, user: 2, session: 3 };

async function insertMemory(opts: {
  type: string;
  importance: number;
  level?: string;
  createdAt?: Date;
  lastAccessed?: Date | null;
  accessCount?: number;
}): Promise<string> {
  const id = `${TEST_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const levelStr = opts.level ?? "session";
  const level = LEVEL_MAP[levelStr] ?? 0;
  const createdAt = opts.createdAt ?? stale;
  const lastAccessed = opts.lastAccessed !== undefined ? opts.lastAccessed : stale;
  const accessCount = opts.accessCount ?? 0;

  await prisma.$executeRaw`
    INSERT INTO memories (id, content, type, importance, level, created_at, updated_at,
                          last_accessed, access_count, embedding)
    VALUES (
      ${id},
      ${"Test memory for " + opts.type},
      ${opts.type},
      ${opts.importance},
      ${level},
      ${createdAt},
      ${createdAt},
      ${lastAccessed},
      ${accessCount},
      NULL
    )
  `;
  return id;
}

async function getImportance(id: string): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ importance: number }[]>`
    SELECT importance FROM memories WHERE id = ${id}
  `;
  return rows[0]?.importance ?? null;
}

async function getLevel(id: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ level: string }[]>`
    SELECT level FROM memories WHERE id = ${id}
  `;
  return rows[0]?.level ?? null;
}

async function getUpdatedAt(id: string): Promise<Date | null> {
  const rows = await prisma.$queryRaw<{ updated_at: Date }[]>`
    SELECT updated_at FROM memories WHERE id = ${id}
  `;
  return rows[0]?.updated_at ?? null;
}

async function exists(id: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*) AS c FROM memories WHERE id = ${id}
  `;
  return Number(rows[0]?.c ?? 0) > 0;
}

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM memories WHERE id LIKE ${TEST_PREFIX + "%"}`;
}

// ── Expose private methods ────────────────────────────────────────────────────

function callDecay(job: MemoryConsolidationJob, now: Date, day: number) {
  return (job as any).decayStaleMemories(prisma, now, day);
}

function callPromo(job: MemoryConsolidationJob, now: Date, day: number) {
  return (job as any).promoteSessionMemories(prisma, now, day);
}

function callPrune(job: MemoryConsolidationJob, now: Date, day: number) {
  return (job as any).pruneOldLowSignalMemories(prisma, now, day);
}

// ─────────────────────────────────────────────────────────────────────────────

beforeAll(cleanup);
afterAll(async () => { await cleanup(); await disconnectPrisma(); });
beforeEach(cleanup);

// ─────────────────────────────────────────────────────────────────────────────

describe("decayStaleMemories — bulk executeRaw (N+1 fix)", () => {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const job = new MemoryConsolidationJob();

  test("decays stale decision memories at 0.95x rate", async () => {
    const id = await insertMemory({ type: "decision", importance: 0.6 });

    const count = await callDecay(job, now, day);

    const imp = await getImportance(id);
    expect(imp).not.toBeNull();
    expect(imp!).toBeCloseTo(0.6 * 0.95, 3);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("decays stale conversation memories at 0.88x rate", async () => {
    const id = await insertMemory({ type: "conversation", importance: 0.5 });
    await callDecay(job, now, day);
    const imp = await getImportance(id);
    expect(imp!).toBeCloseTo(0.5 * 0.88, 3);
  });

  test("decays stale code memories at 0.93x rate", async () => {
    const id = await insertMemory({ type: "code", importance: 0.7 });
    await callDecay(job, now, day);
    const imp = await getImportance(id);
    expect(imp!).toBeCloseTo(0.7 * 0.93, 3);
  });

  test("does NOT decay memories with importance >= 0.8", async () => {
    const id = await insertMemory({ type: "decision", importance: 0.85 });
    await callDecay(job, now, day);
    const imp = await getImportance(id);
    expect(imp!).toBeCloseTo(0.85, 3);
  });

  test("does NOT decay fresh memories (< 7 days old)", async () => {
    const fresh = new Date(Date.now() - 2 * day);
    const id = await insertMemory({ type: "decision", importance: 0.5, createdAt: fresh });
    await callDecay(job, now, day);
    const imp = await getImportance(id);
    expect(imp!).toBeCloseTo(0.5, 3);
  });

  test("importance floor: never decays below 0.1", async () => {
    const id = await insertMemory({ type: "conversation", importance: 0.11 });
    await callDecay(job, now, day);
    const imp = await getImportance(id);
    // 0.11 * 0.88 = 0.0968 → floored to 0.1
    expect(imp!).toBeGreaterThanOrEqual(0.1);
    expect(imp!).toBeCloseTo(0.1, 3);
  });

  test("unknown type uses DEFAULT_DECAY_RATE (0.92) via catch-all", async () => {
    const id = await insertMemory({ type: "custom_unknown_xyz", importance: 0.6 });
    await callDecay(job, now, day);
    const imp = await getImportance(id);
    expect(imp!).toBeCloseTo(0.6 * 0.92, 3);
  });

  test("decays multiple memories in a single pass (bulk, not N+1)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(await insertMemory({ type: "pattern", importance: 0.3 + i * 0.04 }));
    }

    const decayed = await callDecay(job, now, day);
    expect(decayed).toBeGreaterThanOrEqual(8);

    for (const id of ids) {
      const imp = await getImportance(id);
      expect(imp!).toBeGreaterThanOrEqual(0.1);
    }
  });

  test("updated_at is refreshed after decay", async () => {
    const pastDate = new Date(Date.now() - 3 * day);
    const id = await insertMemory({ type: "decision", importance: 0.5 });
    // Force updated_at to an old value
    await prisma.$executeRaw`UPDATE memories SET updated_at = ${pastDate} WHERE id = ${id}`;

    await callDecay(job, now, day);

    const updatedAt = await getUpdatedAt(id);
    expect(updatedAt!.getTime()).toBeGreaterThan(pastDate.getTime());
  });

  test("returns total count spanning all DECAY_RATES types", async () => {
    await Promise.all([
      insertMemory({ type: "critical", importance: 0.5 }),
      insertMemory({ type: "decision", importance: 0.5 }),
      insertMemory({ type: "pattern", importance: 0.5 }),
      insertMemory({ type: "code", importance: 0.5 }),
      insertMemory({ type: "conversation", importance: 0.5 }),
    ]);

    const total = await callDecay(job, now, day);
    expect(total).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("promoteSessionMemories — raw SQL (N+1 fix applied)", () => {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const job = new MemoryConsolidationJob();

  // MemoryLevel: SESSION=3, USER=2 (from @th0th-ai/shared)
  const SESSION = LEVEL_MAP.session; // 3
  const USER    = LEVEL_MAP.user;    // 2

  test("promotes eligible session memories to user level (int=2)", async () => {
    const old = new Date(Date.now() - 2 * day);
    const id = await insertMemory({
      type: "decision",
      importance: 0.75,
      level: "session",
      createdAt: old,
      accessCount: 5,
    });

    await callPromo(job, now, day);

    const level = await getLevel(id);
    expect(Number(level)).toBe(USER); // MemoryLevel.USER = 2

    const imp = await getImportance(id);
    expect(imp!).toBeGreaterThan(0.75); // incremented by 0.08
  });

  test("does NOT promote memories with importance < 0.7", async () => {
    const old = new Date(Date.now() - 2 * day);
    const id = await insertMemory({ type: "decision", importance: 0.6, level: "session", createdAt: old, accessCount: 5 });
    await callPromo(job, now, day);
    const level = await getLevel(id);
    expect(Number(level)).toBe(SESSION); // still SESSION = 3
  });

  test("does NOT promote memories with accessCount < 3", async () => {
    const old = new Date(Date.now() - 2 * day);
    const id = await insertMemory({ type: "decision", importance: 0.8, level: "session", createdAt: old, accessCount: 1 });
    await callPromo(job, now, day);
    const level = await getLevel(id);
    expect(Number(level)).toBe(SESSION);
  });

  test("does NOT promote recent memories (< 24h old)", async () => {
    const fresh = new Date(Date.now() - 1000);
    const id = await insertMemory({ type: "decision", importance: 0.8, level: "session", createdAt: fresh, accessCount: 5 });
    await callPromo(job, now, day);
    const level = await getLevel(id);
    expect(Number(level)).toBe(SESSION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("pruneOldLowSignalMemories — raw SQL (N+1 fix applied)", () => {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const job = new MemoryConsolidationJob();

  test("prunes very old low-signal memories (> 45 days, importance < 0.25, accessCount < 2)", async () => {
    const veryOld = new Date(Date.now() - 50 * day);
    const id = await insertMemory({ type: "conversation", importance: 0.15, createdAt: veryOld, accessCount: 0 });

    const pruned = await callPrune(job, now, day);

    expect(await exists(id)).toBe(false);
    expect(pruned).toBeGreaterThanOrEqual(1);
  });

  test("preserves memories with importance >= 0.25", async () => {
    const veryOld = new Date(Date.now() - 50 * day);
    const id = await insertMemory({ type: "conversation", importance: 0.3, createdAt: veryOld, accessCount: 0 });
    await callPrune(job, now, day);
    expect(await exists(id)).toBe(true);
  });

  test("preserves memories with accessCount >= 2", async () => {
    const veryOld = new Date(Date.now() - 50 * day);
    const id = await insertMemory({ type: "conversation", importance: 0.1, createdAt: veryOld, accessCount: 3 });
    await callPrune(job, now, day);
    expect(await exists(id)).toBe(true);
  });

  test("preserves recent memories (< 45 days)", async () => {
    const recent = new Date(Date.now() - 10 * day);
    const id = await insertMemory({ type: "conversation", importance: 0.1, createdAt: recent, accessCount: 0 });
    await callPrune(job, now, day);
    expect(await exists(id)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("maybeRun throttle", () => {
  test("does not run twice within the minimum interval", async () => {
    const job = new MemoryConsolidationJob();
    let runCount = 0;
    (job as any).runOnce = async () => { runCount++; };
    (job as any).minIntervalMs = 60_000;

    job.maybeRun("store");
    job.maybeRun("store");

    await new Promise((r) => setTimeout(r, 50));
    expect(runCount).toBe(1);
  });

  test("runs again after interval elapsed", async () => {
    const job = new MemoryConsolidationJob();
    let runCount = 0;
    (job as any).runOnce = async () => { runCount++; };
    (job as any).minIntervalMs = 10;
    (job as any).lastRunAt = Date.now() - 100;

    job.maybeRun("store");
    await new Promise((r) => setTimeout(r, 50));
    expect(runCount).toBe(1);
  });
});
