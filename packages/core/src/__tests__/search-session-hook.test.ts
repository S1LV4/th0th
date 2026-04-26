/**
 * Unit tests for SearchSessionHook
 *
 * Covers: registration, memory storage, dedup, empty-result skip,
 * store-failure resilience, and unregister.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Mock shared (logger + MemoryType/Level) ──────────────────
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  metric: mock(() => {}),
};

mock.module("@th0th-ai/shared", () => {
  const actual = require("@th0th-ai/shared");
  return {
    ...actual,
    logger: mockLogger,
  };
});

// ── Mock MemoryController ────────────────────────────────────
const mockStore = mock(async (_input: unknown) => ({
  memoryId: "mem_test_123",
  stored: "local" as const,
  level: "SESSION" as any,
  type: "conversation" as any,
}));

mock.module("../controllers/memory-controller.js", () => ({
  MemoryController: {
    getInstance: () => ({ store: mockStore }),
  },
}));

// ── Import after mocks ────────────────────────────────────────
import { SearchSessionHook } from "../services/hooks/search-session-hook.js";
import { eventBus } from "../services/events/event-bus.js";

// ── Helpers ──────────────────────────────────────────────────

function makePayload(overrides: Partial<Parameters<typeof eventBus.publish>[1] & {}> = {}) {
  return {
    query: "damping constant pagerank",
    projectId: "th0th",
    sessionId: "sess-abc",
    results: [
      { filePath: "packages/core/src/services/symbol/centrality.ts", score: 0.9 },
      { filePath: "packages/core/src/services/search/contextual-search-rlm.ts", score: 0.75 },
    ],
    durationMs: 120,
    resultCount: 2,
    ...overrides,
  } as Parameters<(typeof eventBus)["publish"]>[1] & { resultCount: number };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ─────────────────────────────────────────────────────

describe("SearchSessionHook", () => {
  let hook: SearchSessionHook;

  beforeEach(() => {
    SearchSessionHook.reset();
    mockStore.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.debug.mockClear();
    hook = SearchSessionHook.getInstance();
  });

  afterEach(() => {
    hook.unregisterHook();
    SearchSessionHook.reset();
  });

  // ── Registration ──────────────────────────────────────────

  describe("register()", () => {
    test("subscribes to search:completed on EventBus", async () => {
      hook.register();
      eventBus.publish("search:completed", makePayload());
      await sleep(10);
      expect(mockStore).toHaveBeenCalledTimes(1);
    });

    test("calling register() twice only subscribes once", async () => {
      hook.register();
      hook.register();
      eventBus.publish("search:completed", makePayload());
      await sleep(10);
      expect(mockStore).toHaveBeenCalledTimes(1);
    });
  });

  // ── Memory storage ────────────────────────────────────────

  describe("handleSearchCompleted", () => {
    test("stores memory with correct shape", async () => {
      hook.register();
      const payload = makePayload();
      eventBus.publish("search:completed", payload);
      await sleep(10);

      expect(mockStore).toHaveBeenCalledTimes(1);
      const call = mockStore.mock.calls[0][0] as any;
      expect(call.type).toBe("conversation");
      expect(call.projectId).toBe("th0th");
      expect(call.sessionId).toBe("sess-abc");
      expect(call.importance).toBe(0.3);
      expect(call.tags).toContain("auto:search-session");
      expect(call.tags).toContain("auto:search");
    });

    test("content includes projectId, query, and top-3 file paths", async () => {
      hook.register();
      const payload = makePayload({
        results: [
          { filePath: "a.ts", score: 0.9 },
          { filePath: "b.ts", score: 0.8 },
          { filePath: "c.ts", score: 0.7 },
          { filePath: "d.ts", score: 0.6 }, // 4th should be excluded
        ],
        resultCount: 4,
      });
      eventBus.publish("search:completed", payload);
      await sleep(10);

      const content: string = (mockStore.mock.calls[0][0] as any).content;
      expect(content).toContain("th0th");
      expect(content).toContain("damping constant pagerank");
      expect(content).toContain("a.ts");
      expect(content).toContain("b.ts");
      expect(content).toContain("c.ts");
      expect(content).not.toContain("d.ts");
    });

    test("skips storing when resultCount is 0", async () => {
      hook.register();
      eventBus.publish("search:completed", makePayload({ resultCount: 0, results: [] }));
      await sleep(10);
      expect(mockStore).not.toHaveBeenCalled();
    });

    test("works without sessionId (anonymous session)", async () => {
      hook.register();
      const payload = makePayload({ sessionId: undefined });
      eventBus.publish("search:completed", payload);
      await sleep(10);

      expect(mockStore).toHaveBeenCalledTimes(1);
      const call = mockStore.mock.calls[0][0] as any;
      expect(call.sessionId).toBeUndefined();
    });
  });

  // ── Dedup ─────────────────────────────────────────────────

  describe("dedup", () => {
    test("does not store same (session, project, query) twice within TTL", async () => {
      hook.register();
      const payload = makePayload();
      eventBus.publish("search:completed", payload);
      eventBus.publish("search:completed", payload);
      await sleep(20);
      expect(mockStore).toHaveBeenCalledTimes(1);
    });

    test("stores again for different query", async () => {
      hook.register();
      eventBus.publish("search:completed", makePayload({ query: "query A" }));
      eventBus.publish("search:completed", makePayload({ query: "query B" }));
      await sleep(20);
      expect(mockStore).toHaveBeenCalledTimes(2);
    });

    test("stores again for different projectId", async () => {
      hook.register();
      eventBus.publish("search:completed", makePayload({ projectId: "project-A" }));
      eventBus.publish("search:completed", makePayload({ projectId: "project-B" }));
      await sleep(20);
      expect(mockStore).toHaveBeenCalledTimes(2);
    });

    test("stores again for different sessionId", async () => {
      hook.register();
      eventBus.publish("search:completed", makePayload({ sessionId: "sess-1" }));
      eventBus.publish("search:completed", makePayload({ sessionId: "sess-2" }));
      await sleep(20);
      expect(mockStore).toHaveBeenCalledTimes(2);
    });
  });

  // ── Resilience ────────────────────────────────────────────

  describe("resilience", () => {
    test("does not throw when MemoryController.store rejects", async () => {
      mockStore.mockRejectedValueOnce(new Error("DB unavailable"));
      hook.register();
      // Fire event — if it throws, the test would fail
      expect(() =>
        eventBus.publish("search:completed", makePayload()),
      ).not.toThrow();
      await sleep(20);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });

    test("subsequent events still processed after a store failure", async () => {
      mockStore.mockRejectedValueOnce(new Error("transient error"));
      hook.register();

      eventBus.publish("search:completed", makePayload({ query: "query A" }));
      await sleep(10);

      // Reset mockStore so next call succeeds
      mockStore.mockResolvedValueOnce({
        memoryId: "mem_ok",
        stored: "local",
        level: "SESSION" as any,
        type: "conversation" as any,
      });

      eventBus.publish("search:completed", makePayload({ query: "query B" }));
      await sleep(10);

      // Both calls attempted — first failed, second succeeded
      expect(mockStore).toHaveBeenCalledTimes(2);
    });
  });

  // ── Unregister ────────────────────────────────────────────

  describe("unregisterHook()", () => {
    test("stops receiving events after unregister", async () => {
      hook.register();
      hook.unregisterHook();
      eventBus.publish("search:completed", makePayload());
      await sleep(10);
      expect(mockStore).not.toHaveBeenCalled();
    });

    test("can re-register after unregister", async () => {
      hook.register();
      hook.unregisterHook();
      hook.register();
      eventBus.publish("search:completed", makePayload());
      await sleep(10);
      expect(mockStore).toHaveBeenCalledTimes(1);
    });
  });
});
