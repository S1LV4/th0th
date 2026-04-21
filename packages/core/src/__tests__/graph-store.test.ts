/**
 * Unit tests for GraphStore
 *
 * Tests edge CRUD, analytics (degree, hub, stats), and
 * edge-case handling (self-references, duplicate edges, weight clamping).
 *
 * Uses an in-memory SQLite database by mocking config.get("dataDir")
 * to point to a temp directory.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { MemoryRelationType } from "@th0th-ai/shared";
import fs from "fs";
import path from "path";
import os from "os";

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

describe("GraphStore", () => {
  let store: GraphStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "th0th-test-graph-"));
    // Reset singleton
    (GraphStore as any).instance = null;
    store = new GraphStore();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── createEdge ─────────────────────────────────────────────
  describe("createEdge", () => {
    test("creates an edge successfully", () => {
      const edge = store.createEdge(
        "mem1",
        "mem2",
        MemoryRelationType.SUPPORTS,
        { weight: 0.8, evidence: "test evidence" },
      );

      expect(edge).not.toBeNull();
      expect(edge!.sourceId).toBe("mem1");
      expect(edge!.targetId).toBe("mem2");
      expect(edge!.relationType).toBe(MemoryRelationType.SUPPORTS);
      expect(edge!.weight).toBe(0.8);
      expect(edge!.evidence).toBe("test evidence");
      expect(edge!.autoExtracted).toBe(false);
      expect(edge!.id).toStartWith("edge_");
    });

    test("prevents self-referencing edges", () => {
      const edge = store.createEdge(
        "mem1",
        "mem1",
        MemoryRelationType.RELATES_TO,
      );
      expect(edge).toBeNull();
    });

    test("handles duplicate edge by updating weight", () => {
      store.createEdge("mem1", "mem2", MemoryRelationType.SUPPORTS, {
        weight: 0.5,
      });

      // Attempt to create same edge with higher weight
      const updated = store.createEdge(
        "mem1",
        "mem2",
        MemoryRelationType.SUPPORTS,
        { weight: 0.9, evidence: "updated evidence" },
      );

      expect(updated).not.toBeNull();
      // Weight should be MAX of old and new
      expect(updated!.weight).toBeGreaterThanOrEqual(0.5);
    });

    test("auto-extracted flag works", () => {
      const edge = store.createEdge(
        "mem1",
        "mem2",
        MemoryRelationType.DERIVED_FROM,
        { autoExtracted: true },
      );

      expect(edge!.autoExtracted).toBe(true);
    });
  });

  // ── getEdge ───────────────────────────────────────────────
  describe("getEdge", () => {
    test("retrieves existing edge", () => {
      store.createEdge("mem1", "mem2", MemoryRelationType.CONTRADICTS);

      const edge = store.getEdge(
        "mem1",
        "mem2",
        MemoryRelationType.CONTRADICTS,
      );
      expect(edge).not.toBeNull();
      expect(edge!.sourceId).toBe("mem1");
      expect(edge!.targetId).toBe("mem2");
    });

    test("returns null for non-existent edge", () => {
      const edge = store.getEdge(
        "nonexistent1",
        "nonexistent2",
        MemoryRelationType.SUPPORTS,
      );
      expect(edge).toBeNull();
    });
  });

  // ── getOutgoingEdges / getIncomingEdges / getAllEdges ──────
  describe("edge queries", () => {
    beforeEach(() => {
      store.createEdge("A", "B", MemoryRelationType.SUPPORTS, { weight: 0.8 });
      store.createEdge("A", "C", MemoryRelationType.DERIVED_FROM, {
        weight: 0.6,
      });
      store.createEdge("D", "A", MemoryRelationType.CONTRADICTS, {
        weight: 0.9,
      });
    });

    test("getOutgoingEdges returns edges from source", () => {
      const edges = store.getOutgoingEdges("A");
      expect(edges.length).toBe(2);
      expect(edges.every((e) => e.sourceId === "A")).toBe(true);
    });

    test("getIncomingEdges returns edges to target", () => {
      const edges = store.getIncomingEdges("A");
      expect(edges.length).toBe(1);
      expect(edges[0].sourceId).toBe("D");
    });

    test("getAllEdges returns both directions", () => {
      const edges = store.getAllEdges("A");
      expect(edges.length).toBe(3);
    });

    test("filter by relation types", () => {
      const edges = store.getAllEdges("A", {
        relationTypes: [MemoryRelationType.SUPPORTS],
      });
      expect(edges.length).toBe(1);
      expect(edges[0].relationType).toBe(MemoryRelationType.SUPPORTS);
    });

    test("filter by min weight", () => {
      const edges = store.getAllEdges("A", { minWeight: 0.85 });
      expect(edges.length).toBe(1);
      expect(edges[0].sourceId).toBe("D"); // weight 0.9
    });
  });

  // ── deleteEdge / deleteEdgesForMemory ────────────────────
  describe("deletion", () => {
    test("deleteEdge removes by ID", () => {
      const edge = store.createEdge(
        "mem1",
        "mem2",
        MemoryRelationType.RELATES_TO,
      );
      expect(edge).not.toBeNull();

      const deleted = store.deleteEdge(edge!.id);
      expect(deleted).toBe(true);

      const retrieved = store.getEdge(
        "mem1",
        "mem2",
        MemoryRelationType.RELATES_TO,
      );
      expect(retrieved).toBeNull();
    });

    test("deleteEdge returns false for non-existent", () => {
      expect(store.deleteEdge("nonexistent")).toBe(false);
    });

    test("deleteEdgesForMemory removes all connected edges", () => {
      store.createEdge("X", "Y", MemoryRelationType.SUPPORTS);
      store.createEdge("Z", "X", MemoryRelationType.CONTRADICTS);
      store.createEdge("Y", "Z", MemoryRelationType.RELATES_TO);

      const removed = store.deleteEdgesForMemory("X");
      expect(removed).toBe(2);

      // Y→Z should still exist
      const remaining = store.getEdge(
        "Y",
        "Z",
        MemoryRelationType.RELATES_TO,
      );
      expect(remaining).not.toBeNull();
    });
  });

  // ── updateWeight ──────────────────────────────────────────
  describe("updateWeight", () => {
    test("updates weight within bounds", () => {
      const edge = store.createEdge(
        "mem1",
        "mem2",
        MemoryRelationType.SUPPORTS,
        { weight: 0.5 },
      );

      store.updateWeight(edge!.id, 0.8);
      const updated = store.getEdge(
        "mem1",
        "mem2",
        MemoryRelationType.SUPPORTS,
      );
      expect(updated!.weight).toBe(0.8);
    });

    test("clamps weight to [0, 1]", () => {
      const edge = store.createEdge(
        "mem1",
        "mem2",
        MemoryRelationType.SUPPORTS,
      );

      store.updateWeight(edge!.id, 1.5);
      let updated = store.getEdge(
        "mem1",
        "mem2",
        MemoryRelationType.SUPPORTS,
      );
      expect(updated!.weight).toBe(1);

      store.updateWeight(edge!.id, -0.5);
      updated = store.getEdge("mem1", "mem2", MemoryRelationType.SUPPORTS);
      expect(updated!.weight).toBe(0);
    });
  });

  // ── Analytics ─────────────────────────────────────────────
  describe("analytics", () => {
    beforeEach(() => {
      store.createEdge("A", "B", MemoryRelationType.SUPPORTS);
      store.createEdge("A", "C", MemoryRelationType.DERIVED_FROM);
      store.createEdge("B", "A", MemoryRelationType.CONTRADICTS);
      store.createEdge("D", "E", MemoryRelationType.RELATES_TO);
    });

    test("getDegree returns correct counts", () => {
      const degree = store.getDegree("A");
      expect(degree.out).toBe(2); // A→B, A→C
      expect(degree.in).toBe(1); // B→A
      expect(degree.total).toBe(3);
    });

    test("getHubMemories returns sorted by degree", () => {
      const hubs = store.getHubMemories(5);
      expect(hubs.length).toBeGreaterThan(0);
      // A has 3 edges, should be first or second
      const memA = hubs.find((h) => h.memoryId === "A");
      expect(memA).toBeDefined();
      expect(memA!.degree).toBe(3);
    });

    test("getStats returns correct totals", () => {
      const stats = store.getStats();
      expect(stats.totalEdges).toBe(4);
      expect(stats.byRelation[MemoryRelationType.SUPPORTS]).toBe(1);
      expect(stats.byRelation[MemoryRelationType.DERIVED_FROM]).toBe(1);
      expect(stats.byRelation[MemoryRelationType.CONTRADICTS]).toBe(1);
      expect(stats.byRelation[MemoryRelationType.RELATES_TO]).toBe(1);
      expect(stats.autoExtracted).toBe(0);
      expect(stats.avgWeight).toBeGreaterThan(0);
    });

    test("getStats on empty graph", () => {
      // Use a fresh store
      (GraphStore as any).instance = null;
      const freshTmp = fs.mkdtempSync(
        path.join(os.tmpdir(), "th0th-test-empty-"),
      );
      const origTmp = tmpDir;
      tmpDir = freshTmp;

      const fresh = new GraphStore();
      const stats = fresh.getStats();
      expect(stats.totalEdges).toBe(0);
      expect(stats.avgWeight).toBe(0);

      fresh.close();
      tmpDir = origTmp;
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });
  });

  // ── Performance & Optimizations ────────────────────────────
  describe("performance optimizations", () => {
    test("getAllEdges uses UNION ALL for efficient index lookups", () => {
      // Create a hub memory with many edges in both directions
      const hubId = "hub";
      
      // 50 outgoing edges
      for (let i = 0; i < 50; i++) {
        store.createEdge(
          hubId,
          `target_${i}`,
          MemoryRelationType.SUPPORTS,
          { weight: 0.5 + (i / 100) }
        );
      }
      
      // 50 incoming edges
      for (let i = 0; i < 50; i++) {
        store.createEdge(
          `source_${i}`,
          hubId,
          MemoryRelationType.DERIVED_FROM,
          { weight: 0.6 + (i / 100) }
        );
      }

      const start = performance.now();
      const edges = store.getAllEdges(hubId, { limit: 200 });
      const duration = performance.now() - start;

      // Should retrieve all 100 edges efficiently
      expect(edges.length).toBe(100);
      
      // Should be fast (UNION ALL with indexes vs OR scan)
      expect(duration).toBeLessThan(10); // Conservative threshold
      
      // Should be properly ordered by weight DESC
      expect(edges[0].weight).toBeGreaterThanOrEqual(edges[1].weight);
      
      console.log(`getAllEdges retrieved ${edges.length} edges in ${duration.toFixed(2)}ms`);
    });

    test("getAllEdges deduplicates correctly", () => {
      // Edge case: ensure no duplicates if somehow the same edge appears
      store.createEdge("A", "B", MemoryRelationType.SUPPORTS);
      store.createEdge("B", "A", MemoryRelationType.CONTRADICTS);
      
      const edges = store.getAllEdges("A");
      
      // Should find 2 distinct edges
      expect(edges.length).toBe(2);
      
      // All IDs should be unique
      const ids = edges.map(e => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    test("getAllEdges with filters maintains correctness", () => {
      const memId = "filtered";
      
      // Mix of relations and weights
      store.createEdge(memId, "a", MemoryRelationType.SUPPORTS, { weight: 0.9 });
      store.createEdge("b", memId, MemoryRelationType.SUPPORTS, { weight: 0.8 });
      store.createEdge(memId, "c", MemoryRelationType.CONTRADICTS, { weight: 0.7 });
      store.createEdge("d", memId, MemoryRelationType.DERIVED_FROM, { weight: 0.6 });
      
      // Filter by relation type
      const supportEdges = store.getAllEdges(memId, {
        relationTypes: [MemoryRelationType.SUPPORTS]
      });
      expect(supportEdges.length).toBe(2);
      expect(supportEdges.every(e => e.relationType === MemoryRelationType.SUPPORTS)).toBe(true);
      
      // Filter by min weight
      const highWeightEdges = store.getAllEdges(memId, {
        minWeight: 0.75
      });
      expect(highWeightEdges.length).toBe(2); // 0.9 and 0.8
      expect(highWeightEdges.every(e => e.weight >= 0.75)).toBe(true);
    });

    test("index redundancy removed (idx_edges_source)", () => {
      // Verify that the redundant index was dropped
      // Query the sqlite_master table to check index existence
      const indices = (store as any).db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_edges'")
        .all() as { name: string }[];
      
      const indexNames = indices.map(i => i.name);
      
      // idx_edges_source should NOT exist (redundant with UNIQUE constraint)
      expect(indexNames).not.toContain("idx_edges_source");
      
      // idx_edges_target should exist
      expect(indexNames).toContain("idx_edges_target");
      
      console.log("Active indexes:", indexNames.join(", "));
    });
  });
});
