/**
 * Unit tests for GraphQueries
 *
 * Tests BFS traversal, path finding, contradiction detection,
 * and batch loading performance optimizations.
 *
 * Performance focus: Validates that batch loading eliminates N+1 queries.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { MemoryRelationType, MemoryType } from "@th0th-ai/shared";
import fs from "fs";
import path from "path";
import os from "os";
import { Database } from "bun:sqlite";

// ── Mock config and logger ────────────────────────────────────
let tmpDir: string;

mock.module("@th0th-ai/shared", () => {
  const actual = require("@th0th-ai/shared");
  return {
    ...actual,
    MemoryRelationType: actual.MemoryRelationType,
    MemoryType: actual.MemoryType,
    config: {
      get: (key: string) => {
        if (key === "dataDir") return tmpDir;
        const defaults: Record<string, any> = {
          vectorStore: { type: "sqlite", dbPath: "/tmp/th0th-test-vs.db", collectionName: "test", embeddingModel: "default" },
          keywordSearch: { dbPath: "/tmp/th0th-test-kw.db", ftsVersion: "fts5" },
          cache: { l1: { maxSize: 1024, defaultTTL: 60 }, l2: { dbPath: "/tmp/th0th-test-cache.db", maxSize: 1024, defaultTTL: 60 }, embedding: { dbPath: "/tmp/th0th-test-emb-cache.db", maxAgeHours: 1 } },
          security: { maxInputLength: 10000, sanitizeInputs: true, maxIndexSize: 1000, maxFileSize: 1048576, allowedExtensions: [".ts"], excludePatterns: [] },
        };
        return defaults[key];
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      metric: () => {},
    },
  };
});

import { GraphStore } from "../services/graph/graph-store.js";
import { GraphQueries } from "../services/graph/graph-queries.js";

/**
 * Query counter: wraps Database.prepare to count SQL queries
 */
class QueryCounter {
  count = 0;
  private originalPrepare: any;

  constructor(private db: Database) {
    this.originalPrepare = db.prepare.bind(db);
  }

  start() {
    this.count = 0;
    this.db.prepare = (sql: string) => {
      // Only count SELECT queries to memories table (not edges/metadata)
      if (sql.includes("SELECT") && sql.includes("FROM memories")) {
        this.count++;
      }
      return this.originalPrepare(sql);
    };
  }

  stop() {
    this.db.prepare = this.originalPrepare;
  }

  getCount(): number {
    return this.count;
  }
}

describe("GraphQueries", () => {
  let store: GraphStore;
  let queries: GraphQueries;
  let db: Database;
  let counter: QueryCounter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "th0th-test-queries-"));
    (GraphStore as any).instance = null;
    store = new GraphStore();
    queries = new GraphQueries(store);

    // Access internal db for query counting
    db = (queries as any).db;
    counter = new QueryCounter(db);

    // Create test memories
    const dbPath = path.join(tmpDir, "memories.db");
    const memDb = new Database(dbPath);
    memDb.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        level INTEGER DEFAULT 0,
        importance REAL DEFAULT 0.5,
        tags TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        access_count INTEGER DEFAULT 0,
        user_id TEXT,
        session_id TEXT,
        project_id TEXT,
        agent_id TEXT
      )
    `);

    // Insert test memories
    const insertStmt = memDb.prepare(`
      INSERT INTO memories (id, content, type, importance)
      VALUES (?, ?, ?, ?)
    `);

    for (let i = 1; i <= 100; i++) {
      insertStmt.run(
        `mem${i}`,
        `Memory content ${i}`,
        MemoryType.CONVERSATION,
        0.5
      );
    }

    memDb.close();
  });

  afterEach(() => {
    queries.close();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── getRelatedContext ──────────────────────────────────────
  describe("getRelatedContext - Batch Loading", () => {
    test("batch loads memories per BFS level (reduces queries from O(N) to O(depth))", () => {
      // Create a graph: mem1 -> mem2, mem3, mem4, mem5 (depth 1)
      //                 mem2 -> mem6, mem7 (depth 2)
      for (let i = 2; i <= 5; i++) {
        store.createEdge("mem1", `mem${i}`, MemoryRelationType.RELATES_TO, {
          weight: 0.8,
        });
      }
      store.createEdge("mem2", "mem6", MemoryRelationType.RELATES_TO, {
        weight: 0.7,
      });
      store.createEdge("mem2", "mem7", MemoryRelationType.RELATES_TO, {
        weight: 0.7,
      });

      counter.start();
      const related = queries.getRelatedContext("mem1", { maxDepth: 2 });
      counter.stop();

      // Expected: 2 batch queries (one per BFS level)
      // Actual: Should be 2 (level 1 batch + level 2 batch)
      // Old implementation would be 6 queries (4 at depth 1 + 2 at depth 2)
      expect(counter.getCount()).toBeLessThanOrEqual(2);
      expect(related.length).toBe(6); // mem2-5 at depth 1, mem6-7 at depth 2
    });

    test("handles large fan-out efficiently (50+ neighbors)", () => {
      // Create hub: mem1 connects to mem2-mem51 (50 neighbors)
      for (let i = 2; i <= 51; i++) {
        store.createEdge("mem1", `mem${i}`, MemoryRelationType.RELATES_TO, {
          weight: 0.5,
        });
      }

      counter.start();
      const related = queries.getRelatedContext("mem1", {
        maxDepth: 1,
        limit: 50,
      });
      counter.stop();

      // Should use 1 batch query instead of 50 individual queries
      // Note: getAllEdges has internal limit of 20, so we get fewer results
      // The key point is batch loading reduces queries from O(N) to O(1) per level
      expect(counter.getCount()).toBe(1);
      expect(related.length).toBeGreaterThan(10); // At least some neighbors loaded
    });
  });

  // ── findContradictions ─────────────────────────────────────
  describe("findContradictions - Batch Loading", () => {
    test("batch loads all memories in one query", () => {
      // Create 10 contradiction edges
      for (let i = 1; i <= 10; i++) {
        store.createEdge(
          `mem${i}`,
          `mem${i + 10}`,
          MemoryRelationType.CONTRADICTS,
          { weight: 0.9, evidence: `Contradiction ${i}` }
        );
      }

      counter.start();
      const contradictions = queries.findContradictions(10);
      counter.stop();

      // Should use 1 batch query for all 20 memories (10 pairs)
      // Old implementation would use 20 individual queries
      expect(counter.getCount()).toBe(1);
      expect(contradictions.length).toBe(10);
    });

    test("handles overlapping memory IDs efficiently", () => {
      // Create contradictions where some memories appear multiple times
      store.createEdge("mem1", "mem2", MemoryRelationType.CONTRADICTS, {
        weight: 0.9,
      });
      store.createEdge("mem1", "mem3", MemoryRelationType.CONTRADICTS, {
        weight: 0.8,
      });
      store.createEdge("mem2", "mem4", MemoryRelationType.CONTRADICTS, {
        weight: 0.7,
      });

      counter.start();
      const contradictions = queries.findContradictions(10);
      counter.stop();

      // Should deduplicate mem1, mem2 and batch load 4 unique memories
      expect(counter.getCount()).toBe(1);
      expect(contradictions.length).toBe(3);
    });
  });

  // ── getHubMemories ─────────────────────────────────────────
  describe("getHubMemories - Batch Loading", () => {
    test("batch loads all hub memories in one query", () => {
      // Create 10 hub nodes with varying degrees
      for (let i = 1; i <= 10; i++) {
        for (let j = 0; j < i * 5; j++) {
          const targetIdx = 10 + i * 10 + j;
          if (targetIdx <= 100) {
            store.createEdge(
              `mem${i}`,
              `mem${targetIdx}`,
              MemoryRelationType.RELATES_TO,
              { weight: 0.5 }
            );
          }
        }
      }

      counter.start();
      const hubs = queries.getHubMemories(10);
      counter.stop();

      // Should use 1 batch query instead of 10 individual queries
      expect(counter.getCount()).toBe(1);
      expect(hubs.length).toBeGreaterThan(0);
      expect(hubs.length).toBeLessThanOrEqual(10);
    });
  });

  // ── findPath + reconstructPath ─────────────────────────────
  describe("findPath - Batch Loading", () => {
    test("batch loads path memories in one query", () => {
      // Create a path: mem1 -> mem2 -> mem3 -> mem4 -> mem5
      store.createEdge("mem1", "mem2", MemoryRelationType.RELATES_TO, {
        weight: 0.8,
      });
      store.createEdge("mem2", "mem3", MemoryRelationType.RELATES_TO, {
        weight: 0.8,
      });
      store.createEdge("mem3", "mem4", MemoryRelationType.RELATES_TO, {
        weight: 0.8,
      });
      store.createEdge("mem4", "mem5", MemoryRelationType.RELATES_TO, {
        weight: 0.8,
      });

      counter.start();
      const graphPath = queries.findPath("mem1", "mem5", 5);
      counter.stop();

      // Should use 1 batch query for path reconstruction (5 nodes)
      // Old implementation would use 5 individual queries
      expect(counter.getCount()).toBe(1);
      expect(graphPath).not.toBeNull();
      expect(graphPath!.nodes.length).toBe(5);
      expect(graphPath!.length).toBe(4);
    });

    test("handles no path found without excessive queries", () => {
      // No edges, so no path exists
      counter.start();
      const graphPath = queries.findPath("mem1", "mem50", 3);
      counter.stop();

      expect(graphPath).toBeNull();
      // Should not attempt to load any memories since path doesn't exist
      expect(counter.getCount()).toBe(0);
    });
  });

  // ── Performance Benchmark ──────────────────────────────────
  describe("Performance Benchmark", () => {
    test("demonstrates O(depth) queries instead of O(N) for deep BFS", () => {
      // Create a linear chain for predictable testing
      // mem1 -> mem2 -> mem3 -> mem4 -> mem5
      // Also add siblings at each level to test batch loading
      // Level 1: mem2, mem11
      // Level 2: mem3, mem12 (from mem2)
      // Level 3: mem4, mem13 (from mem3)
      
      store.createEdge("mem1", "mem2", MemoryRelationType.RELATES_TO, { weight: 0.8 });
      store.createEdge("mem1", "mem11", MemoryRelationType.RELATES_TO, { weight: 0.8 });
      
      store.createEdge("mem2", "mem3", MemoryRelationType.RELATES_TO, { weight: 0.7 });
      store.createEdge("mem2", "mem12", MemoryRelationType.RELATES_TO, { weight: 0.7 });
      
      store.createEdge("mem3", "mem4", MemoryRelationType.RELATES_TO, { weight: 0.6 });
      store.createEdge("mem3", "mem13", MemoryRelationType.RELATES_TO, { weight: 0.6 });

      const startTime = performance.now();
      counter.start();
      const related = queries.getRelatedContext("mem1", { maxDepth: 3, limit: 50 });
      counter.stop();
      const endTime = performance.now();

      // With batch loading: expect 3 queries (one per depth level)
      // Without batch loading: would be 6 queries (2 at level 1 + 2 at level 2 + 2 at level 3)
      console.log(`\n📊 BFS Performance:`);
      console.log(`   Nodes retrieved: ${related.length}`);
      console.log(`   Query count: ${counter.getCount()} (expected ≤3 for depth 3)`);
      console.log(`   Time: ${(endTime - startTime).toFixed(2)}ms`);
      console.log(`   Speedup: ${(6 / counter.getCount()).toFixed(1)}x (6 queries → ${counter.getCount()})`);

      expect(counter.getCount()).toBeLessThanOrEqual(3);
      expect(related.length).toBe(6); // mem2,11 + mem3,12 + mem4,13
    });
  });
});
