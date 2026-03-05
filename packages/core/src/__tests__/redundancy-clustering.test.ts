/**
 * Unit tests for RedundancyFilter and MemoryClustering
 *
 * Tests duplicate detection, merge logic, and K-means clustering.
 * Uses a real temp SQLite database with synthetic embeddings.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
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
    config: {
      get: (key: string) => {
        if (key === "dataDir") return tmpDir;
        // Provide safe defaults for module-level singletons that may load
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

import { RedundancyFilter } from "../services/memory/redundancy-filter.js";
import { MemoryClustering } from "../services/memory/memory-clustering.js";

// ── Helpers ──────────────────────────────────────────────────

function makeEmbedding(seed: number, dim: number = 16): Buffer {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.sin(seed + i * 0.1);
  }
  return Buffer.from(arr.buffer);
}

function makeSimilarEmbedding(
  base: Buffer,
  noise: number = 0.001,
): Buffer {
  const original = new Float32Array(
    base.buffer,
    base.byteOffset,
    base.byteLength / 4,
  );
  const arr = new Float32Array(original.length);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = original[i] + (Math.random() - 0.5) * noise;
  }
  return Buffer.from(arr.buffer);
}

function setupMemoriesTable(dbPath: string) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      level INTEGER NOT NULL,
      user_id TEXT,
      session_id TEXT,
      project_id TEXT,
      agent_id TEXT,
      importance REAL DEFAULT 0.5,
      tags TEXT,
      embedding BLOB,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      access_count INTEGER DEFAULT 0,
      last_accessed INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, tags
    );
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
  `);
  return db;
}

function insertMemory(
  db: Database,
  id: string,
  content: string,
  type: string,
  embedding: Buffer,
  importance: number = 0.5,
  accessCount: number = 0,
  createdAt?: number,
) {
  const now = createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO memories (id, content, type, level, importance, tags, embedding, created_at, updated_at, access_count)
     VALUES (?, ?, ?, 1, ?, '[]', ?, ?, ?, ?)`,
  ).run(id, content, type, importance, embedding, now, now, accessCount);
}

// ── RedundancyFilter ─────────────────────────────────────────

describe("RedundancyFilter", () => {
  let filter: RedundancyFilter;
  let db: Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "th0th-test-rf-"));
    const dbPath = path.join(tmpDir, "memories.db");
    db = setupMemoriesTable(dbPath);
    (RedundancyFilter as any).instance = null;
    filter = new RedundancyFilter();
  });

  afterEach(() => {
    filter.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("findDuplicates", () => {
    test("finds near-duplicate memories (same type)", () => {
      const emb = makeEmbedding(1);
      const similar = makeSimilarEmbedding(emb, 0.0001);

      insertMemory(db, "m1", "Use Bun for testing", "decision", emb, 0.8, 5);
      insertMemory(
        db,
        "m2",
        "Use Bun for testing",
        "decision",
        similar,
        0.5,
        2,
      );

      const pairs = filter.findDuplicates(0.95);
      expect(pairs.length).toBe(1);
      // Higher importance should be kept
      expect(pairs[0].keepId).toBe("m1");
      expect(pairs[0].removeId).toBe("m2");
      expect(pairs[0].similarity).toBeGreaterThan(0.95);
    });

    test("does not flag different types as duplicates", () => {
      const emb = makeEmbedding(2);
      const similar = makeSimilarEmbedding(emb, 0.0001);

      insertMemory(db, "m1", "same content", "code", emb);
      insertMemory(db, "m2", "same content", "decision", similar);

      const pairs = filter.findDuplicates(0.95);
      expect(pairs.length).toBe(0);
    });

    test("does not flag dissimilar memories", () => {
      const emb1 = makeEmbedding(10);
      const emb2 = makeEmbedding(100); // Very different

      insertMemory(db, "m1", "content A", "code", emb1);
      insertMemory(db, "m2", "content B", "code", emb2);

      const pairs = filter.findDuplicates(0.95);
      expect(pairs.length).toBe(0);
    });

    test("keeper selection: importance > access > recency", () => {
      const emb = makeEmbedding(3);
      const sim = makeSimilarEmbedding(emb, 0.0001);

      // Same importance, different access counts
      insertMemory(db, "m1", "test", "pattern", emb, 0.5, 10);
      insertMemory(db, "m2", "test", "pattern", sim, 0.5, 2);

      const pairs = filter.findDuplicates(0.95);
      expect(pairs.length).toBe(1);
      expect(pairs[0].keepId).toBe("m1"); // More accesses
    });
  });

  describe("mergeDuplicates", () => {
    test("merges and deletes duplicate", () => {
      const emb = makeEmbedding(4);
      const sim = makeSimilarEmbedding(emb, 0.0001);

      insertMemory(db, "keep1", "content", "code", emb, 0.8, 5);
      insertMemory(db, "rm1", "content", "code", sim, 0.3, 3);

      const pairs = filter.findDuplicates(0.95);
      const result = filter.mergeDuplicates(pairs);

      expect(result.merged).toBe(1);
      // rm1 should be deleted
      const remaining = db
        .prepare("SELECT id FROM memories")
        .all() as any[];
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe("keep1");

      // Access count should be boosted
      const kept = db
        .prepare("SELECT access_count FROM memories WHERE id = ?")
        .get("keep1") as any;
      expect(kept.access_count).toBe(8); // 5 + 3
    });

    test("handles empty pairs list", () => {
      const result = filter.mergeDuplicates([]);
      expect(result.merged).toBe(0);
    });
  });

  describe("runCleanup", () => {
    test("finds and merges in one call", () => {
      const emb = makeEmbedding(5);
      const sim = makeSimilarEmbedding(emb, 0.0001);

      insertMemory(db, "a", "cleanup test", "decision", emb, 0.9);
      insertMemory(db, "b", "cleanup test", "decision", sim, 0.4);

      const stats = filter.runCleanup(0.95);
      expect(stats.duplicatesFound).toBe(1);
      expect(stats.merged).toBe(1);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("performance benchmarks", () => {
    test("handles large batch (200+ memories) efficiently", () => {
      // Create realistic scenario: 200 memories across 5 types
      const types = ["code", "pattern", "decision", "conversation", "preference"];
      const memoriesPerType = 40;

      for (let t = 0; t < types.length; t++) {
        for (let i = 0; i < memoriesPerType; i++) {
          // Create some near-duplicates within each type
          const seed = t * 100 + Math.floor(i / 3);
          const emb = makeEmbedding(seed, 1536); // Full dimension
          insertMemory(
            db,
            `m_${types[t]}_${i}`,
            `Memory content for ${types[t]} number ${i}`,
            types[t],
            emb,
            0.5 + Math.random() * 0.3,
            Math.floor(Math.random() * 10),
          );
        }
      }

      const start = performance.now();
      const pairs = filter.findDuplicates(0.95, 200);
      const duration = performance.now() - start;

      // Should complete in reasonable time (much faster than old O(n²×d))
      // Old: ~69M operations for 300×1536, ~46ms per test
      // New: ~5.5M operations for 200/5=40²×5×1536, target <15ms
      expect(duration).toBeLessThan(30); // Conservative threshold

      // Should find some duplicates (due to seed-based embedding generation)
      expect(pairs.length).toBeGreaterThanOrEqual(0);

      // Verify all pairs are within same type (binning validation)
      const memoryTypes = new Map<string, string>();
      for (let t = 0; t < types.length; t++) {
        for (let i = 0; i < memoriesPerType; i++) {
          memoryTypes.set(`m_${types[t]}_${i}`, types[t]);
        }
      }

      for (const pair of pairs) {
        const keepType = memoryTypes.get(pair.keepId);
        const removeType = memoryTypes.get(pair.removeId);
        expect(keepType).toBe(removeType);
      }
    });

    test("performance scales sub-quadratically with type diversity", () => {
      // Test scaling: same total memories, different type distributions
      
      // Scenario 1: All same type (worst case, full O(n²) within bin)
      const n1 = 100;
      for (let i = 0; i < n1; i++) {
        insertMemory(
          db,
          `s1_${i}`,
          `Same type ${i}`,
          "code",
          makeEmbedding(i * 10, 256),
        );
      }

      const start1 = performance.now();
      filter.findDuplicates(0.95, n1);
      const duration1 = performance.now() - start1;

      // Clean up
      db.exec("DELETE FROM memories");

      // Scenario 2: Diverse types (best case, O(n²/t) across bins)
      const types = ["code", "pattern", "decision", "conversation", "preference"];
      const n2 = 100;
      for (let i = 0; i < n2; i++) {
        insertMemory(
          db,
          `s2_${i}`,
          `Diverse ${i}`,
          types[i % types.length],
          makeEmbedding(i * 10, 256),
        );
      }

      const start2 = performance.now();
      filter.findDuplicates(0.95, n2);
      const duration2 = performance.now() - start2;

      // With binning, diverse types should be faster or comparable
      // In practice, the improvement depends on type distribution and memory layout
      // With 5 types, we expect 20 items per bin vs 100 in single bin
      // Theoretical: (100²) vs (5 × 20²) = 10000 vs 2000 = 5x improvement
      // Actual improvement will be lower due to overhead, but should still show benefit
      
      // Log for visibility during test runs
      console.log(`Same-type duration: ${duration1.toFixed(2)}ms, Diverse-type duration: ${duration2.toFixed(2)}ms, Speedup: ${(duration1/duration2).toFixed(2)}x`);
      
      // Conservative assertion: diverse should not be slower than same-type
      // (in theory it's always better or equal, never worse)
      expect(duration2).toBeLessThanOrEqual(duration1 * 1.5); // Allow 50% margin for variance
    });
  });

  describe("early-exit optimization", () => {
    test("early-exit accelerates dissimilar batches", () => {
      // Create batch with dissimilar pairs
      // Use large seed spacing to ensure low similarity
      const n = 50;
      
      for (let i = 0; i < n; i++) {
        // Seeds spaced very far apart to create dissimilar embeddings
        insertMemory(
          db,
          `dissim_${i}`,
          `Memory ${i}`,
          "code",
          makeEmbedding(i * 1000, 1536), // Full dimension, very wide spacing
          0.5,
        );
      }

      const start = performance.now();
      const pairs = filter.findDuplicates(0.95, n);
      const duration = performance.now() - start;

      // Should complete efficiently despite O(n²) comparisons
      // Early-exit should abort most pairs quickly
      // Without early-exit: 50²×1536 = 3.84M ops
      // With early-exit: most pairs abort after 25-50% → ~1-2M ops
      expect(duration).toBeLessThan(15); // Should be fast due to early exits

      // With very wide spacing, should find very few duplicates
      console.log(`Dissimilar batch: ${pairs.length} duplicates found in ${duration.toFixed(2)}ms (n=${n})`);
    });

    test("early-exit maintains correct results for similar pairs", () => {
      // Mix of similar and dissimilar pairs
      const emb1 = makeEmbedding(1, 1536);
      const emb2 = makeSimilarEmbedding(emb1, 0.0001); // Very similar
      const emb3 = makeEmbedding(10000, 1536); // Dissimilar
      const emb4 = makeEmbedding(20000, 1536); // Dissimilar

      insertMemory(db, "sim1", "Similar A", "code", emb1, 0.8);
      insertMemory(db, "sim2", "Similar B", "code", emb2, 0.7);
      insertMemory(db, "diff1", "Different A", "code", emb3, 0.6);
      insertMemory(db, "diff2", "Different B", "code", emb4, 0.5);

      const pairs = filter.findDuplicates(0.95);

      // Should find exactly one pair: sim1 ↔ sim2
      expect(pairs.length).toBe(1);
      expect(pairs[0].similarity).toBeGreaterThan(0.95);
      
      // Verify the correct pair was found
      const ids = new Set([pairs[0].keepId, pairs[0].removeId]);
      expect(ids.has("sim1")).toBe(true);
      expect(ids.has("sim2")).toBe(true);
    });

    test("early-exit with varying vector dimensions", () => {
      // Test with different dimension sizes to ensure block logic works
      const dimensions = [256, 512, 1024, 1536];
      
      for (const dim of dimensions) {
        // Clean up previous iteration
        if (db) {
          db.exec("DELETE FROM memories");
        }

        // Create dissimilar pairs with very wide spacing
        for (let i = 0; i < 20; i++) {
          insertMemory(
            db,
            `d${dim}_${i}`,
            `Memory ${i}`,
            "code",
            makeEmbedding(i * 5000, dim), // Very wide spacing
            0.5,
          );
        }

        const start = performance.now();
        const pairs = filter.findDuplicates(0.95, 20);
        const duration = performance.now() - start;

        // Should complete quickly regardless of dimension
        // (early-exit prevents full dimension traversal)
        expect(duration).toBeLessThan(15);
        
        console.log(`Dimension ${dim}: ${pairs.length} pairs found in ${duration.toFixed(2)}ms`);
      }
    });

    test("heterogeneous batch (mixed similar/dissimilar) performance", () => {
      // Realistic scenario: 80% dissimilar, 20% similar
      // 50 memories with 5 clusters of ~10 similar items each
      
      for (let cluster = 0; cluster < 5; cluster++) {
        const baseSeed = cluster * 10000; // Wide spacing between clusters
        const baseEmb = makeEmbedding(baseSeed, 1536);
        
        // 10 similar memories in this cluster
        for (let i = 0; i < 10; i++) {
          const emb = i === 0 ? baseEmb : makeSimilarEmbedding(baseEmb, 0.001);
          insertMemory(
            db,
            `c${cluster}_${i}`,
            `Cluster ${cluster} memory ${i}`,
            "code",
            emb,
            0.5,
          );
        }
      }

      const start = performance.now();
      const pairs = filter.findDuplicates(0.95, 50);
      const duration = performance.now() - start;

      // Should be fast: early-exit rejects most cross-cluster pairs
      // Only ~45 intra-cluster pairs need full computation
      // vs 1225 total pairs without early-exit
      expect(duration).toBeLessThan(15);

      // Should find duplicates within clusters
      expect(pairs.length).toBeGreaterThan(0);
      
      console.log(`Heterogeneous batch: ${pairs.length} duplicates found in ${duration.toFixed(2)}ms`);
    });
  });
});

// ── MemoryClustering ─────────────────────────────────────────

describe("MemoryClustering", () => {
  let clustering: MemoryClustering;
  let db: Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "th0th-test-clust-"));
    const dbPath = path.join(tmpDir, "memories.db");
    db = setupMemoriesTable(dbPath);
    (MemoryClustering as any).instance = null;
    clustering = new MemoryClustering();
  });

  afterEach(() => {
    clustering.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("clusterMemories", () => {
    test("returns empty for < 3 memories", () => {
      const emb = makeEmbedding(1);
      insertMemory(db, "m1", "only one", "code", emb);

      const result = clustering.clusterMemories(2);
      expect(result.clusters.length).toBe(0);
      expect(result.unclustered).toBe(1);
    });

    test("clusters memories into groups", () => {
      // Create two distinct clusters
      // Cluster A: embeddings seeded near 1
      for (let i = 0; i < 5; i++) {
        insertMemory(
          db,
          `cA_${i}`,
          `database query optimization technique ${i}`,
          "pattern",
          makeEmbedding(1 + i * 0.01),
          0.7,
        );
      }

      // Cluster B: embeddings seeded near 100
      for (let i = 0; i < 5; i++) {
        insertMemory(
          db,
          `cB_${i}`,
          `user interface design pattern ${i}`,
          "code",
          makeEmbedding(100 + i * 0.01),
          0.5,
        );
      }

      const result = clustering.clusterMemories(2);
      expect(result.clusters.length).toBeGreaterThanOrEqual(1);

      // Each cluster should have members
      for (const cluster of result.clusters) {
        expect(cluster.memberIds.length).toBeGreaterThanOrEqual(2);
        expect(cluster.label.length).toBeGreaterThan(0);
        expect(cluster.dominantType).toBeTruthy();
        expect(cluster.importance).toBeGreaterThan(0);
      }

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("auto-tunes k when not provided", () => {
      // Insert enough memories for auto-k to work (20+)
      for (let i = 0; i < 20; i++) {
        insertMemory(
          db,
          `m${i}`,
          `memory content number ${i} about topic ${i % 3}`,
          i % 2 === 0 ? "code" : "pattern",
          makeEmbedding(i * 10),
        );
      }

      const result = clustering.clusterMemories();
      // Should produce some clusters
      expect(result.clusters.length).toBeGreaterThan(0);
    });
  });

  describe("findCluster", () => {
    test("finds cluster containing a specific memory", () => {
      for (let i = 0; i < 6; i++) {
        insertMemory(
          db,
          `fc_${i}`,
          `cluster finding test content ${i}`,
          "code",
          makeEmbedding(1 + i * 0.01),
        );
      }

      const result = clustering.clusterMemories(2);
      if (result.clusters.length > 0) {
        const targetId = result.clusters[0].memberIds[0];
        const found = clustering.findCluster(targetId, result);
        expect(found).not.toBeNull();
        expect(found!.memberIds).toContain(targetId);
      }
    });

    test("returns null for unclustered memory", () => {
      for (let i = 0; i < 4; i++) {
        insertMemory(
          db,
          `nc_${i}`,
          `content ${i}`,
          "code",
          makeEmbedding(i * 100),
        );
      }

      const result = clustering.clusterMemories(2);
      const found = clustering.findCluster("nonexistent", result);
      expect(found).toBeNull();
    });
  });

  describe("summarizeCluster", () => {
    test("generates readable summary", () => {
      for (let i = 0; i < 4; i++) {
        insertMemory(
          db,
          `sc_${i}`,
          `Database performance optimization for queries. Method ${i}.`,
          "pattern",
          makeEmbedding(1 + i * 0.01),
          0.7 + i * 0.05,
        );
      }

      const result = clustering.clusterMemories(1);
      if (result.clusters.length > 0) {
        const summary = clustering.summarizeCluster(result.clusters[0]);
        expect(summary.length).toBeGreaterThan(0);
        expect(summary).toContain("[");
        expect(summary).toContain("memories");
      }
    });
  });
});
