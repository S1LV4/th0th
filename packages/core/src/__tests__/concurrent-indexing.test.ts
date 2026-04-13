/**
 * Tests for the queue-based concurrent indexing mutex in ContextualSearchRLM.
 *
 * Fix validated: The old check-and-set pattern only serialized 2 concurrent
 * callers. A 3rd caller would overwrite the lock and run concurrently with the
 * 2nd. The new queue pattern chains each caller onto the previous tail, so any
 * number of concurrent callers are fully serialized.
 */

import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";

// ── Restore any stale mocks from other test files (shared module registry) ───
// When running alongside other test files in the same Bun process, files like
// search-controller.test.ts may mock contextual-search-rlm.js with a stub that
// has no indexProject method. Restoring first guarantees a clean slate.
mock.restore();

// ── Mock all heavy infrastructure so we can import the class cleanly ─────
// NOTE: vector-store-factory.js is intentionally NOT mocked here.
// indexProject replaces ensureInitialized() with a stub, so getVectorStore()
// is never called. Mocking it would break vector-store-factory.test.ts
// by contaminating Bun's shared module registry.
mock.module("../data/sqlite/keyword-search-factory.js", () => ({
  getKeywordSearch: mock(async () => ({})),
}));
mock.module("../services/search/cache-factory.js", () => ({
  getSearchCache: mock(async () => ({})),
}));
mock.module("../services/search/analytics-factory.js", () => ({
  getSearchAnalytics: mock(async () => ({})),
}));
mock.module("../data/sqlite/symbol-repository-factory.js", () => ({
  getSymbolRepository: mock(async () => ({})),
}));
mock.module("../services/search/index-manager.js", () => ({
  IndexManager: class MockIndexManager {},
}));
mock.module("../services/search/ignore-patterns.js", () => ({
  loadProjectIgnore: mock(() => null),
}));
mock.module("../services/search/file-filter-cache.js", () => ({
  FileFilterCache: class MockFileFilterCache {
    shouldInclude() { return true; }
    clear() {}
  },
}));
// Spread real @th0th-ai/shared so enums (MemoryRelationType, MemoryLevel, etc.)
// remain available to other test files that run in the same process.
mock.module("@th0th-ai/shared", () => {
  const actual = require("@th0th-ai/shared");
  return {
    ...actual,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    config: { get: () => "/tmp/th0th-test-concurrent" },
    estimateTokens: (s: string) => Math.ceil(s.length / 4),
  };
});

import { ContextualSearchRLM } from "../services/search/contextual-search-rlm.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeInstance(): ContextualSearchRLM {
  const inst = new ContextualSearchRLM();
  // Skip real infrastructure init
  (inst as any).ensureInitialized = async () => { (inst as any).initialized = true; };
  return inst;
}

/** Controlled async task — resolves when `release()` is called. */
function makeGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release };
}

/** Delay for N ms (tiny pauses to let microtask queue flush). */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Reset static locks between tests ─────────────────────────────────────────
beforeEach(() => {
  (ContextualSearchRLM as any).indexingLocks = new Map();
});

afterEach(() => {
  (ContextualSearchRLM as any).indexingLocks = new Map();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ContextualSearchRLM — concurrent indexing mutex", () => {
  // ── Basic serial execution ───────────────────────────────────────────────
  describe("serial execution guarantee", () => {
    test("single caller runs immediately, cleans up the lock map", async () => {
      const inst = makeInstance();
      const order: string[] = [];

      (inst as any)._indexProjectInternal = async () => {
        order.push("run");
        return { filesIndexed: 1, chunksIndexed: 1, errors: 0 };
      };

      await inst.indexProject("/tmp/proj", "proj-a");

      expect(order).toEqual(["run"]);
      // Map entry removed after single caller finishes
      expect((ContextualSearchRLM as any).indexingLocks.has("proj-a")).toBe(false);
    });

    test("two concurrent callers execute serially, not in parallel", async () => {
      const inst = makeInstance();
      const { gate, release } = makeGate();
      const order: string[] = [];

      let callCount = 0;
      (inst as any)._indexProjectInternal = async (_path: string, id: string) => {
        callCount++;
        const myCall = callCount;
        order.push(`start:${myCall}`);
        if (myCall === 1) await gate;   // A blocks until released
        order.push(`end:${myCall}`);
        return { filesIndexed: 1, chunksIndexed: 1, errors: 0 };
      };

      const p1 = inst.indexProject("/tmp/proj", "proj-b");
      const p2 = inst.indexProject("/tmp/proj", "proj-b");

      await delay(10);  // let A start, B queue up

      // Only A should have started so far
      expect(order).toEqual(["start:1"]);

      release();          // unblock A
      await Promise.all([p1, p2]);

      expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
    });

    test("three concurrent callers: third waits for second, not first (correct queue)", async () => {
      const inst = makeInstance();
      const gates = [makeGate(), makeGate(), makeGate()];
      const order: string[] = [];

      let callCount = 0;
      (inst as any)._indexProjectInternal = async (_path: string, id: string) => {
        callCount++;
        const n = callCount;
        order.push(`start:${n}`);
        await gates[n - 1].gate;
        order.push(`end:${n}`);
        return { filesIndexed: 1, chunksIndexed: 1, errors: 0 };
      };

      const p1 = inst.indexProject("/tmp/proj", "proj-c");
      const p2 = inst.indexProject("/tmp/proj", "proj-c");
      const p3 = inst.indexProject("/tmp/proj", "proj-c");

      await delay(10);
      // Only caller 1 has started
      expect(order).toEqual(["start:1"]);

      gates[0].release();   // finish A → B starts
      await delay(10);
      expect(order).toEqual(["start:1", "end:1", "start:2"]);

      gates[1].release();   // finish B → C starts
      await delay(10);
      expect(order).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3"]);

      gates[2].release();   // finish C
      await Promise.all([p1, p2, p3]);
      expect(order).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
    });
  });

  // ── Lock map lifecycle ───────────────────────────────────────────────────
  describe("lock map cleanup", () => {
    test("lock map entry is removed when the tail caller finishes", async () => {
      const inst = makeInstance();
      (inst as any)._indexProjectInternal = async () =>
        ({ filesIndexed: 1, chunksIndexed: 1, errors: 0 });

      await inst.indexProject("/tmp/proj", "proj-d");
      expect((ContextualSearchRLM as any).indexingLocks.has("proj-d")).toBe(false);
    });

    test("lock map entry persists while a new waiter is queued (not the tail)", async () => {
      const inst = makeInstance();
      const { gate, release } = makeGate();
      let callCount = 0;

      (inst as any)._indexProjectInternal = async () => {
        callCount++;
        if (callCount === 1) await gate;
        return { filesIndexed: 1, chunksIndexed: 1, errors: 0 };
      };

      const p1 = inst.indexProject("/tmp/proj", "proj-e");
      const p2 = inst.indexProject("/tmp/proj", "proj-e");

      await delay(5);
      // B is the tail; the map should still hold a reference
      expect((ContextualSearchRLM as any).indexingLocks.has("proj-e")).toBe(true);

      release();
      await Promise.all([p1, p2]);

      // After both finish the map entry is gone
      expect((ContextualSearchRLM as any).indexingLocks.has("proj-e")).toBe(false);
    });

    test("different projectIds use independent locks", async () => {
      const inst = makeInstance();
      const aGate = makeGate();
      const order: string[] = [];

      (inst as any)._indexProjectInternal = async (_path: string, id: string) => {
        order.push(`start:${id}`);
        if (id === "proj-x") await aGate.gate;
        order.push(`end:${id}`);
        return { filesIndexed: 1, chunksIndexed: 1, errors: 0 };
      };

      const pX = inst.indexProject("/tmp/proj", "proj-x");
      const pY = inst.indexProject("/tmp/proj", "proj-y");  // different ID — no wait

      await delay(10);
      // proj-y should have already finished (no lock contention)
      expect(order).toContain("start:proj-x");
      expect(order).toContain("start:proj-y");
      expect(order).toContain("end:proj-y");   // Y finishes without waiting for X
      expect(order).not.toContain("end:proj-x"); // X is still blocked

      aGate.release();
      await Promise.all([pX, pY]);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────
  describe("lock release on error", () => {
    test("lock is released even if _indexProjectInternal throws", async () => {
      const inst = makeInstance();
      const order: string[] = [];
      let callCount = 0;

      (inst as any)._indexProjectInternal = async () => {
        callCount++;
        if (callCount === 1) {
          order.push("throw");
          throw new Error("indexing failed");
        }
        order.push("success");
        return { filesIndexed: 1, chunksIndexed: 1, errors: 0 };
      };

      const p1 = inst.indexProject("/tmp/proj", "proj-f").catch(() => "error");
      const p2 = inst.indexProject("/tmp/proj", "proj-f");

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe("error");
      expect(r2).toMatchObject({ filesIndexed: 1 });
      expect(order).toEqual(["throw", "success"]);
      // Lock map cleaned up
      expect((ContextualSearchRLM as any).indexingLocks.has("proj-f")).toBe(false);
    });

    test("subsequent callers still run after a failed predecessor", async () => {
      const inst = makeInstance();
      const results: string[] = [];
      let callIndex = 0; // explicit counter — not based on results length

      (inst as any)._indexProjectInternal = async () => {
        const n = ++callIndex;
        if (n === 1) throw new Error("fail");
        results.push("ok");
        return { filesIndexed: 1, chunksIndexed: 1, errors: 0 };
      };

      const p1 = inst.indexProject("/tmp/proj", "proj-g").catch(() => results.push("caught"));
      const p2 = inst.indexProject("/tmp/proj", "proj-g");

      await Promise.all([p1, p2]);

      expect(results).toContain("caught");
      expect(results).toContain("ok");
    });
  });

  // ── Return values ────────────────────────────────────────────────────────
  describe("return value propagation", () => {
    test("each caller receives its own return value", async () => {
      const inst = makeInstance();
      let n = 0;

      (inst as any)._indexProjectInternal = async () => {
        n++;
        return { filesIndexed: n * 10, chunksIndexed: n * 5, errors: 0 };
      };

      const [r1, r2] = await Promise.all([
        inst.indexProject("/tmp/proj", "proj-h"),
        inst.indexProject("/tmp/proj", "proj-h"),
      ]);

      expect(r1.filesIndexed).toBe(10);
      expect(r2.filesIndexed).toBe(20);
    });
  });
});
