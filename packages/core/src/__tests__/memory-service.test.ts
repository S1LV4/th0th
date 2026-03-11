/**
 * Unit tests for MemoryService
 *
 * Tests pure domain logic: ID generation, level determination,
 * rowToMemory conversion, and semantic ranking.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { MemoryType, MemoryLevel } from "@th0th-ai/shared";

// ── Mock EmbeddingService before importing MemoryService ─────
mock.module("../data/chromadb/vector-store.js", () => ({
  EmbeddingService: class MockEmbeddingService {
    async embed(_text: string): Promise<number[]> {
      return new Array(384).fill(0.1);
    }
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(() => new Array(384).fill(0.1));
    }
    getDimensions() {
      return 384;
    }
  },
}));

import { MemoryService } from "../services/memory/memory-service.js";
import type { MemoryRow } from "../data/memory/memory-repository.js";

// ── Reset singleton between tests ────────────────────────────
function resetSingleton() {
  (MemoryService as any).instance = null;
}

describe("MemoryService", () => {
  let service: MemoryService;

  beforeEach(() => {
    resetSingleton();
    service = MemoryService.getInstance();
  });

  // ── generateId ───────────────────────────────────────────
  describe("generateId", () => {
    test("generates ID with type prefix", () => {
      const id = service.generateId(MemoryType.DECISION, "user1");
      expect(id).toStartWith("dec_");
    });

    test("generates ID with user suffix when userId provided", () => {
      const id = service.generateId(MemoryType.CODE, "user123");
      expect(id).toContain("_user");
    });

    test("generates ID without user suffix when no userId", () => {
      const id = service.generateId(MemoryType.PATTERN);
      // Should not end with _userXXXX
      const parts = id.split("_");
      expect(parts.length).toBe(3); // prefix_timestamp_random
    });

    test("generates unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(service.generateId(MemoryType.CONVERSATION));
      }
      expect(ids.size).toBe(100);
    });
  });

  // ── determineLevel ───────────────────────────────────────
  describe("determineLevel", () => {
    test("orchestrator + decision = PERSISTENT (L0)", () => {
      const level = service.determineLevel(MemoryType.DECISION, {
        agentId: "orchestrator",
      });
      expect(level).toBe(MemoryLevel.PERSISTENT);
    });

    test("architect + pattern = PROJECT (L1)", () => {
      const level = service.determineLevel(MemoryType.PATTERN, {
        agentId: "architect",
      });
      expect(level).toBe(MemoryLevel.PROJECT);
    });

    test("architect + code = PROJECT (L1)", () => {
      const level = service.determineLevel(MemoryType.CODE, {
        agentId: "architect",
      });
      expect(level).toBe(MemoryLevel.PROJECT);
    });

    test("optimizer + preference = USER (L2)", () => {
      const level = service.determineLevel(MemoryType.PREFERENCE, {
        agentId: "optimizer",
      });
      expect(level).toBe(MemoryLevel.USER);
    });

    test("projectId provided = PROJECT", () => {
      const level = service.determineLevel(MemoryType.CONVERSATION, {
        projectId: "proj1",
      });
      expect(level).toBe(MemoryLevel.PROJECT);
    });

    test("userId only (no session) = USER", () => {
      const level = service.determineLevel(MemoryType.CONVERSATION, {
        userId: "user1",
      });
      expect(level).toBe(MemoryLevel.USER);
    });

    test("sessionId = SESSION", () => {
      const level = service.determineLevel(MemoryType.CONVERSATION, {
        userId: "user1",
        sessionId: "sess1",
      });
      expect(level).toBe(MemoryLevel.SESSION);
    });

    test("type-based defaults", () => {
      expect(service.determineLevel(MemoryType.PREFERENCE, {})).toBe(
        MemoryLevel.USER,
      );
      expect(service.determineLevel(MemoryType.CONVERSATION, {})).toBe(
        MemoryLevel.SESSION,
      );
      expect(service.determineLevel(MemoryType.CODE, {})).toBe(
        MemoryLevel.PROJECT,
      );
      expect(service.determineLevel(MemoryType.PATTERN, {})).toBe(
        MemoryLevel.PROJECT,
      );
      expect(service.determineLevel(MemoryType.DECISION, {})).toBe(
        MemoryLevel.PERSISTENT,
      );
    });
  });

  // ── rowToMemory ──────────────────────────────────────────
  describe("rowToMemory", () => {
    test("converts MemoryRow to Memory domain object", () => {
      const row: MemoryRow = {
        id: "test_1",
        content: "test content",
        type: "decision",
        level: 0,
        user_id: "user1",
        session_id: null,
        project_id: "proj1",
        agent_id: "architect",
        importance: 0.8,
        tags: '["tag1","tag2"]',
        embedding: null,
        metadata: null,
        created_at: 1000,
        updated_at: 2000,
        access_count: 5,
        last_accessed: 3000,
      };

      const memory = service.rowToMemory(row);

      expect(memory.id).toBe("test_1");
      expect(memory.content).toBe("test content");
      expect(memory.type).toBe(MemoryType.DECISION);
      expect(memory.level).toBe(MemoryLevel.PERSISTENT);
      expect(memory.userId).toBe("user1");
      expect(memory.sessionId).toBeNull();
      expect(memory.projectId).toBe("proj1");
      expect(memory.agentId).toBe("architect");
      expect(memory.importance).toBe(0.8);
      expect(memory.tags).toEqual(["tag1", "tag2"]);
      expect(memory.accessCount).toBe(5);
      expect(memory.lastAccessed).toBe(3000);
    });

    test("handles null/empty tags", () => {
      const row: MemoryRow = {
        id: "test_2",
        content: "c",
        type: "code",
        level: 1,
        user_id: null,
        session_id: null,
        project_id: null,
        agent_id: null,
        importance: 0.5,
        tags: "",
        embedding: null,
        metadata: null,
        created_at: 1000,
        updated_at: 1000,
        access_count: 0,
        last_accessed: null,
      };

      const memory = service.rowToMemory(row);
      expect(memory.tags).toEqual([]);
      expect(memory.accessCount).toBe(0);
      expect(memory.lastAccessed).toBeNull();
    });
  });

  // ── semanticRank ─────────────────────────────────────────
  describe("semanticRank", () => {
    test("ranks memories by composite score", () => {
      const now = Date.now();
      // Create a known embedding
      const embedding = new Array(384).fill(0);
      embedding[0] = 1.0;

      const queryEmbedding = new Array(384).fill(0);
      queryEmbedding[0] = 1.0;

      const memories = [
        {
          id: "m1",
          content: "first",
          type: MemoryType.DECISION,
          level: MemoryLevel.PERSISTENT,
          userId: null,
          sessionId: null,
          projectId: null,
          agentId: null,
          importance: 0.9,
          tags: [],
          createdAt: now,
          accessCount: 10,
          lastAccessed: now,
          embedding: Buffer.from(new Float32Array(embedding).buffer),
        },
        {
          id: "m2",
          content: "second",
          type: MemoryType.CONVERSATION,
          level: MemoryLevel.SESSION,
          userId: null,
          sessionId: null,
          projectId: null,
          agentId: null,
          importance: 0.3,
          tags: [],
          createdAt: now - 72 * 60 * 60 * 1000, // 72 hours old
          accessCount: 0,
          lastAccessed: null,
          embedding: Buffer.from(new Float32Array(embedding).buffer),
        },
      ];

      const ranked = service.semanticRank(memories, queryEmbedding, 10);

      expect(ranked.length).toBe(2);
      // m1 should rank higher (same embedding similarity but better temporal/access/type)
      expect(ranked[0].id).toBe("m1");
      expect(ranked[1].id).toBe("m2");
      // All should have scores
      expect(ranked[0].score).toBeGreaterThan(0);
      expect(ranked[1].score).toBeGreaterThan(0);
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    test("respects limit parameter", () => {
      const queryEmbedding = new Array(384).fill(0.1);

      const memories = Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`,
        content: `memory ${i}`,
        type: MemoryType.CONVERSATION,
        level: MemoryLevel.SESSION,
        userId: null,
        sessionId: null,
        projectId: null,
        agentId: null,
        importance: 0.5,
        tags: [],
        createdAt: Date.now(),
        accessCount: 0,
        lastAccessed: null,
        embedding: null,
      }));

      const ranked = service.semanticRank(memories, queryEmbedding, 3);
      expect(ranked.length).toBe(3);
    });

    test("handles memories with no embedding (assigns 0.5 base score)", () => {
      const queryEmbedding = new Array(384).fill(0.1);

      const memories = [
        {
          id: "m1",
          content: "no embedding",
          type: MemoryType.CODE,
          level: MemoryLevel.PROJECT,
          userId: null,
          sessionId: null,
          projectId: null,
          agentId: null,
          importance: 0.5,
          tags: [],
          createdAt: Date.now(),
          accessCount: 0,
          lastAccessed: null,
          embedding: null,
        },
      ];

      const ranked = service.semanticRank(memories, queryEmbedding, 10);
      expect(ranked.length).toBe(1);
      // With no embedding, semantic score = 0.5, so final score should include that component
      expect(ranked[0].score).toBeGreaterThan(0);
    });
  });

  // ── generateEmbedding (delegates to mock) ────────────────
  describe("generateEmbedding", () => {
    test("returns 384-dim vector from mocked service", async () => {
      const embedding = await service.generateEmbedding("test text");
      expect(embedding.length).toBe(384);
      expect(embedding[0]).toBe(0.1);
    });
  });

  // ── Singleton ─────────────────────────────────────────────
  describe("singleton", () => {
    test("returns same instance", () => {
      const a = MemoryService.getInstance();
      const b = MemoryService.getInstance();
      expect(a).toBe(b);
    });
  });
});
