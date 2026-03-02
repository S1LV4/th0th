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

mock.module("@th0th/shared", () => {
  const actual = require("@th0th/shared");
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
