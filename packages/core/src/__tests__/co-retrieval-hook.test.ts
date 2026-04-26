/**
 * Unit tests for CoRetrievalHook
 *
 * Uses dependency injection (createForTest) instead of mock.module so that
 * graph-store.test.ts is not contaminated via Bun's shared module registry.
 *
 * Covers: registration, edge creation, edge reinforcement, feature flag gating,
 * peer-not-found skip, resilience to repo/graph failures, unregister.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Mock logger only (shared, no dedicated test file) ────────
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  metric: mock(() => {}),
};

mock.module("@th0th-ai/shared", () => {
  const actual = require("@th0th-ai/shared");
  return { ...actual, logger: mockLogger };
});

// ── Import after mocks ────────────────────────────────────────
import { CoRetrievalHook } from "../services/hooks/co-retrieval-hook.js";
import { eventBus } from "../services/events/event-bus.js";

// ── Mock graph store (injected, no module contamination) ──────

function makeMockGraphStore() {
  return {
    getEdge: mock((_from: string, _to: string, _type: string) => null as any),
    createEdge: mock((_from: string, _to: string, _type: string, _opts?: any) => ({
      id: "edge_test",
      sourceId: _from,
      targetId: _to,
      relationType: _type,
      weight: 0.15,
    })),
    incrementEdgeWeight: mock((..._args: any[]) => true),
  };
}

function makeMockRepo(peers: Array<{ id: string }> = []) {
  return {
    findRecentByTag: mock(async (_tag: string, _opts: any) => peers),
  };
}

// ── Helpers ──────────────────────────────────────────────────

function makePayload(overrides: Partial<{
  memoryId: string;
  projectId: string;
  sessionId: string;
  query: string;
}> = {}) {
  return {
    memoryId: "mem_new_abc",
    projectId: "th0th",
    sessionId: "sess-xyz",
    query: "pagerank damping",
    ...overrides,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ─────────────────────────────────────────────────────

describe("CoRetrievalHook", () => {
  let mockGraph: ReturnType<typeof makeMockGraphStore>;
  let mockRepo: ReturnType<typeof makeMockRepo>;
  let hook: CoRetrievalHook;
  const OLD_ENV = process.env.TH0TH_CO_RETRIEVAL_HOOK;

  beforeEach(() => {
    CoRetrievalHook.reset();
    mockLogger.warn.mockClear();
    mockLogger.debug.mockClear();

    process.env.TH0TH_CO_RETRIEVAL_HOOK = "true";
    mockGraph = makeMockGraphStore();
    mockRepo = makeMockRepo();
    hook = CoRetrievalHook.createForTest(mockGraph, mockRepo);
  });

  afterEach(() => {
    hook.unregisterHook();
    CoRetrievalHook.reset();
    if (OLD_ENV === undefined) {
      delete process.env.TH0TH_CO_RETRIEVAL_HOOK;
    } else {
      process.env.TH0TH_CO_RETRIEVAL_HOOK = OLD_ENV;
    }
  });

  // ── Feature flag ─────────────────────────────────────────

  describe("feature flag", () => {
    test("does nothing when TH0TH_CO_RETRIEVAL_HOOK is not set", async () => {
      delete process.env.TH0TH_CO_RETRIEVAL_HOOK;
      hook.register();
      eventBus.publish("memory:session-stored", makePayload());
      await sleep(20);
      expect(mockRepo.findRecentByTag).not.toHaveBeenCalled();
      expect(mockGraph.createEdge).not.toHaveBeenCalled();
    });

    test("runs when TH0TH_CO_RETRIEVAL_HOOK=true", async () => {
      hook.register();
      eventBus.publish("memory:session-stored", makePayload());
      await sleep(20);
      expect(mockRepo.findRecentByTag).toHaveBeenCalledTimes(1);
    });
  });

  // ── Registration ──────────────────────────────────────────

  describe("register()", () => {
    test("subscribes to memory:session-stored events", async () => {
      hook.register();
      eventBus.publish("memory:session-stored", makePayload());
      await sleep(20);
      expect(mockRepo.findRecentByTag).toHaveBeenCalledTimes(1);
    });

    test("calling register() twice only subscribes once", async () => {
      hook.register();
      hook.register();
      eventBus.publish("memory:session-stored", makePayload());
      await sleep(20);
      expect(mockRepo.findRecentByTag).toHaveBeenCalledTimes(1);
    });
  });

  // ── Edge creation ─────────────────────────────────────────

  describe("edge creation", () => {
    test("creates edge when no existing edge and peer found", async () => {
      mockRepo = makeMockRepo([{ id: "peer_1" }]);
      hook = CoRetrievalHook.createForTest(mockGraph, mockRepo);
      hook.register();

      eventBus.publish("memory:session-stored", makePayload({ memoryId: "mem_new" }));
      await sleep(20);

      expect(mockGraph.createEdge).toHaveBeenCalledTimes(1);
      const call = mockGraph.createEdge.mock.calls[0];
      const [from, to] = ["mem_new", "peer_1"].sort();
      expect(call[0]).toBe(from);
      expect(call[1]).toBe(to);
      expect(call[3].weight).toBe(0.15);
      expect(call[3].autoExtracted).toBe(true);
    });

    test("IDs are ordered deterministically (lexicographic min → max)", async () => {
      mockRepo = makeMockRepo([{ id: "zzz_peer" }]);
      hook = CoRetrievalHook.createForTest(mockGraph, mockRepo);
      hook.register();

      eventBus.publish("memory:session-stored", makePayload({ memoryId: "aaa_new" }));
      await sleep(20);

      const [from, to] = mockGraph.createEdge.mock.calls[0];
      expect(from < to).toBe(true);
    });

    test("does nothing when no peers found", async () => {
      hook.register(); // mockRepo returns [] by default
      eventBus.publish("memory:session-stored", makePayload());
      await sleep(20);
      expect(mockGraph.createEdge).not.toHaveBeenCalled();
      expect(mockGraph.incrementEdgeWeight).not.toHaveBeenCalled();
    });

    test("limits pairs to MAX_PEERS (5)", async () => {
      const peers = Array.from({ length: 8 }, (_, i) => ({ id: `peer_${i}` }));
      mockRepo = makeMockRepo(peers);
      hook = CoRetrievalHook.createForTest(mockGraph, mockRepo);
      hook.register();

      eventBus.publish("memory:session-stored", makePayload());
      await sleep(20);

      expect(mockGraph.createEdge.mock.calls.length).toBeLessThanOrEqual(5);
    });
  });

  // ── Edge reinforcement ────────────────────────────────────

  describe("edge reinforcement", () => {
    test("increments weight when edge already exists", async () => {
      mockRepo = makeMockRepo([{ id: "peer_existing" }]);
      mockGraph.getEdge.mockReturnValueOnce({
        id: "edge_existing",
        weight: 0.25,
        sourceId: "mem_new",
        targetId: "peer_existing",
      });
      hook = CoRetrievalHook.createForTest(mockGraph, mockRepo);
      hook.register();

      eventBus.publish("memory:session-stored", makePayload({ memoryId: "mem_new" }));
      await sleep(20);

      expect(mockGraph.incrementEdgeWeight).toHaveBeenCalledTimes(1);
      expect(mockGraph.createEdge).not.toHaveBeenCalled();

      const [, , , delta, cap] = mockGraph.incrementEdgeWeight.mock.calls[0];
      expect(delta).toBe(0.1);
      expect(cap).toBe(0.85);
    });
  });

  // ── findRecentByTag query parameters ─────────────────────

  describe("query parameters", () => {
    test("passes correct tag, sessionId, projectId, excludeId", async () => {
      hook.register();

      const payload = makePayload({
        memoryId: "mem_abc",
        projectId: "myproject",
        sessionId: "sess-123",
      });
      eventBus.publish("memory:session-stored", payload);
      await sleep(20);

      const call = mockRepo.findRecentByTag.mock.calls[0];
      expect(call[0]).toBe("auto:search-session");
      expect(call[1].sessionId).toBe("sess-123");
      expect(call[1].projectId).toBe("myproject");
      expect(call[1].excludeId).toBe("mem_abc");
      expect(call[1].limit).toBe(5);
    });
  });

  // ── Repo without findRecentByTag ──────────────────────────

  describe("graceful degradation", () => {
    test("skips when injected repo lacks findRecentByTag", async () => {
      const repoWithoutMethod = {} as any;
      hook = CoRetrievalHook.createForTest(mockGraph, repoWithoutMethod);
      hook.register();

      eventBus.publish("memory:session-stored", makePayload());
      await sleep(20);

      expect(mockGraph.createEdge).not.toHaveBeenCalled();
    });
  });

  // ── Resilience ────────────────────────────────────────────

  describe("resilience", () => {
    test("does not throw when findRecentByTag rejects", async () => {
      mockRepo.findRecentByTag.mockRejectedValueOnce(new Error("DB down"));
      hook.register();

      expect(() =>
        eventBus.publish("memory:session-stored", makePayload()),
      ).not.toThrow();
      await sleep(20);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });

    test("subsequent events still processed after a repo failure", async () => {
      mockRepo.findRecentByTag.mockRejectedValueOnce(new Error("transient"));
      hook.register();

      eventBus.publish("memory:session-stored", makePayload({ memoryId: "a" }));
      await sleep(10);

      mockRepo.findRecentByTag.mockResolvedValueOnce([{ id: "peer_ok" }]);
      mockGraph.getEdge.mockReturnValueOnce(null);
      eventBus.publish("memory:session-stored", makePayload({ memoryId: "b" }));
      await sleep(10);

      expect(mockRepo.findRecentByTag).toHaveBeenCalledTimes(2);
      expect(mockGraph.createEdge).toHaveBeenCalledTimes(1);
    });
  });

  // ── Unregister ────────────────────────────────────────────

  describe("unregisterHook()", () => {
    test("stops receiving events after unregister", async () => {
      hook.register();
      hook.unregisterHook();
      eventBus.publish("memory:session-stored", makePayload());
      await sleep(20);
      expect(mockRepo.findRecentByTag).not.toHaveBeenCalled();
    });

    test("can re-register after unregister", async () => {
      hook.register();
      hook.unregisterHook();
      hook.register();
      mockRepo.findRecentByTag.mockResolvedValueOnce([{ id: "peer_1" }]);
      mockGraph.getEdge.mockReturnValueOnce(null);
      eventBus.publish("memory:session-stored", makePayload());
      await sleep(20);
      expect(mockRepo.findRecentByTag).toHaveBeenCalledTimes(1);
    });
  });
});
