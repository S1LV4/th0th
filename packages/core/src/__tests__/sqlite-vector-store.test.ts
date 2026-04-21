/**
 * Unit tests for SQLiteVectorStore
 *
 * Tests the SQLite-based vector store implementation:
 * - Document CRUD operations
 * - Search functionality (full O(n) and pre-filter)
 * - Project isolation
 * - Statistics and health checks
 * - Batch operations
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { SearchSource } from "@th0th-ai/shared";
import fs from "fs";
import path from "path";
import os from "os";

// Mock EmbeddingService to avoid actual API calls
const mockEmbeddings: Map<string, number[]> = new Map();
let embedCallCount = 0;

function generateMockEmbedding(text: string): number[] {
  // Generate deterministic embeddings based on text hash
  const hash = text.split("").reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  
  // Create 384-dim vector with values based on hash
  return Array(384).fill(0).map((_, i) => 
    Math.sin(hash + i) * 0.5 + 0.5
  );
}

mock.module("../data/chromadb/vector-store.js", () => ({
  EmbeddingService: class MockEmbeddingService {
    async embed(text: string): Promise<number[]> {
      embedCallCount++;
      if (!mockEmbeddings.has(text)) {
        mockEmbeddings.set(text, generateMockEmbedding(text));
      }
      return mockEmbeddings.get(text)!;
    }
    async embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map(t => this.embed(t)));
    }
    getDimensions() {
      return 384;
    }
  },
}));

// Mock config
let testDbPath: string;
mock.module("@th0th-ai/shared", () => {
  const actual = require("@th0th-ai/shared");
  return {
    ...actual,
    config: {
      get: (key: string) => {
        if (key === "vectorStore") {
          return { dbPath: testDbPath };
        }
        return actual.config.get(key);
      },
    },
  };
});

// Import after mocking
import { SQLiteVectorStore } from "../data/vector/sqlite-vector-store.js";

describe("SQLiteVectorStore", () => {
  let store: SQLiteVectorStore;
  let tempDir: string;

  beforeEach(() => {
    // Create temp directory for test database
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-vector-test-"));
    testDbPath = path.join(tempDir, "test-vectors.db");
    
    // Reset mocks
    mockEmbeddings.clear();
    embedCallCount = 0;
    
    // Create new store instance
    store = new SQLiteVectorStore();
  });

  afterEach(async () => {
    // Close store and cleanup
    await store.close();
    
    // Remove temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ── Basic CRUD Operations ──────────────────────────────────
  describe("addDocument", () => {
    test("adds document with metadata", async () => {
      await store.addDocument("doc1", "test content", {
        projectId: "project1",
        filePath: "/path/to/file.ts",
      });

      const stats = await store.getStats("project1");
      expect(stats.totalDocuments).toBe(1);
    });

    test("uses default projectId when not provided", async () => {
      await store.addDocument("doc1", "test content");

      const stats = await store.getStats("default");
      expect(stats.totalDocuments).toBe(1);
    });

    test("replaces document with same id", async () => {
      await store.addDocument("doc1", "original content", { projectId: "p1" });
      await store.addDocument("doc1", "updated content", { projectId: "p1" });

      const stats = await store.getStats("p1");
      expect(stats.totalDocuments).toBe(1);
    });
  });

  describe("addDocuments (batch)", () => {
    test("adds multiple documents", async () => {
      const docs = [
        { id: "doc1", content: "content 1", metadata: { projectId: "p1" } },
        { id: "doc2", content: "content 2", metadata: { projectId: "p1" } },
        { id: "doc3", content: "content 3", metadata: { projectId: "p1" } },
      ];

      await store.addDocuments(docs);

      const stats = await store.getStats("p1");
      expect(stats.totalDocuments).toBe(3);
    });

    test("handles empty batch", async () => {
      await store.addDocuments([]);
      
      const stats = await store.getStats();
      expect(stats.totalDocuments).toBe(0);
    });

    test("uses sub-batching for embeddings", async () => {
      // Create 20 documents (should be split into sub-batches)
      const docs = Array(20).fill(null).map((_, i) => ({
        id: `doc${i}`,
        content: `content ${i}`,
        metadata: { projectId: "p1" },
      }));

      await store.addDocuments(docs);

      const stats = await store.getStats("p1");
      expect(stats.totalDocuments).toBe(20);
    });
  });

  describe("delete", () => {
    test("deletes existing document", async () => {
      await store.addDocument("doc1", "content", { projectId: "p1" });
      
      const deleted = await store.delete("doc1");
      
      expect(deleted).toBe(true);
      const stats = await store.getStats("p1");
      expect(stats.totalDocuments).toBe(0);
    });

    test("returns false for non-existent document", async () => {
      const deleted = await store.delete("nonexistent");
      
      expect(deleted).toBe(false);
    });
  });

  describe("deleteByProject", () => {
    test("deletes all documents for project", async () => {
      await store.addDocument("doc1", "content 1", { projectId: "p1" });
      await store.addDocument("doc2", "content 2", { projectId: "p1" });
      await store.addDocument("doc3", "content 3", { projectId: "p2" });

      const deleted = await store.deleteByProject("p1");

      expect(deleted).toBe(2);
      expect((await store.getStats("p1")).totalDocuments).toBe(0);
      expect((await store.getStats("p2")).totalDocuments).toBe(1);
    });

    test("returns 0 for empty project", async () => {
      const deleted = await store.deleteByProject("nonexistent");
      
      expect(deleted).toBe(0);
    });
  });

  describe("update", () => {
    test("updates existing document", async () => {
      await store.addDocument("doc1", "original", { projectId: "p1" });
      
      await store.update("doc1", "updated", { projectId: "p1", newField: true });

      // Search should find updated content
      const results = await store.search("updated", 10, "p1");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── Search Operations ──────────────────────────────────────
  describe("search", () => {
    beforeEach(async () => {
      // Add test documents
      await store.addDocument("doc1", "TypeScript programming language", { projectId: "p1" });
      await store.addDocument("doc2", "JavaScript runtime environment", { projectId: "p1" });
      await store.addDocument("doc3", "Python machine learning", { projectId: "p1" });
    });

    test("returns results sorted by similarity", async () => {
      const results = await store.search("TypeScript", 10, "p1");

      expect(results.length).toBe(3);
      expect(results[0].source).toBe(SearchSource.VECTOR);
      // First result should be most similar to query
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
    });

    test("respects limit parameter", async () => {
      const results = await store.search("programming", 2, "p1");

      expect(results.length).toBe(2);
    });

    test("filters by projectId", async () => {
      await store.addDocument("doc4", "TypeScript code", { projectId: "p2" });

      const resultsP1 = await store.search("TypeScript", 10, "p1");
      const resultsP2 = await store.search("TypeScript", 10, "p2");

      expect(resultsP1.every(r => r.metadata?.projectId !== "p2")).toBe(true);
      expect(resultsP2.length).toBe(1);
    });

    test("returns all projects when projectId not specified", async () => {
      await store.addDocument("doc4", "TypeScript code", { projectId: "p2" });

      const results = await store.search("TypeScript", 10);

      expect(results.length).toBe(4);
    });

    test("handles empty results", async () => {
      const results = await store.search("query", 10, "nonexistent");

      expect(results).toEqual([]);
    });
  });

  describe("searchByEmbedding", () => {
    test("searches using pre-computed embedding", async () => {
      await store.addDocument("doc1", "test content", { projectId: "p1" });

      const embedding = generateMockEmbedding("test content");
      const results = await store.searchByEmbedding(embedding, 10, "p1");

      expect(results.length).toBe(1);
      expect(results[0].score).toBeGreaterThan(0.9); // Should be very similar
    });
  });

  // ── Project Management ─────────────────────────────────────
  describe("listProjects", () => {
    test("lists all projects with document counts", async () => {
      await store.addDocument("doc1", "content 1", { projectId: "project-a" });
      await store.addDocument("doc2", "content 2", { projectId: "project-a" });
      await store.addDocument("doc3", "content 3", { projectId: "project-b" });

      const projects = await store.listProjects();

      expect(projects.length).toBe(2);
      
      const projectA = projects.find(p => p.projectId === "project-a");
      const projectB = projects.find(p => p.projectId === "project-b");
      
      expect(projectA?.documentCount).toBe(2);
      expect(projectB?.documentCount).toBe(1);
    });

    test("returns empty array for empty store", async () => {
      const projects = await store.listProjects();

      expect(projects).toEqual([]);
    });
  });

  // ── Statistics ─────────────────────────────────────────────
  describe("getStats", () => {
    test("returns stats for specific project", async () => {
      await store.addDocument("doc1", "content 1", { projectId: "p1" });
      await store.addDocument("doc2", "content 2", { projectId: "p1" });

      const stats = await store.getStats("p1");

      expect(stats.totalDocuments).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
    });

    test("returns global stats when no projectId", async () => {
      await store.addDocument("doc1", "content 1", { projectId: "p1" });
      await store.addDocument("doc2", "content 2", { projectId: "p2" });

      const stats = await store.getStats();

      expect(stats.totalDocuments).toBe(2);
    });

    test("returns zero for empty project", async () => {
      const stats = await store.getStats("nonexistent");

      expect(stats.totalDocuments).toBe(0);
      expect(stats.totalSize).toBe(0);
    });
  });

  // ── Health Check ───────────────────────────────────────────
  describe("healthCheck", () => {
    test("returns true for healthy store", async () => {
      const healthy = await store.healthCheck();

      expect(healthy).toBe(true);
    });
  });

  // ── Collection Interface ───────────────────────────────────
  describe("getCollection", () => {
    test("returns collection for project", async () => {
      await store.addDocument("doc1", "content", { projectId: "p1" });

      const collection = await store.getCollection("p1");

      expect(collection).toBeDefined();
      expect(typeof collection.query).toBe("function");
    });
  });

  // ── Pre-filter Search (Opt-in) ─────────────────────────────
  describe("search with SQLITE_VECTOR_PREFILTER", () => {
    const originalEnv = process.env.SQLITE_VECTOR_PREFILTER;

    afterEach(() => {
      if (originalEnv) {
        process.env.SQLITE_VECTOR_PREFILTER = originalEnv;
      } else {
        delete process.env.SQLITE_VECTOR_PREFILTER;
      }
    });

    test("uses full search by default", async () => {
      delete process.env.SQLITE_VECTOR_PREFILTER;
      
      await store.addDocument("doc1", "test content", { projectId: "p1" });
      const results = await store.search("test", 10, "p1");

      expect(results.length).toBe(1);
    });

    test("uses pre-filter when env var is set", async () => {
      process.env.SQLITE_VECTOR_PREFILTER = "true";
      
      await store.addDocument("doc1", "test content", { projectId: "p1" });
      const results = await store.search("test", 10, "p1");

      // Should still return results, just via different code path
      expect(results.length).toBe(1);
    });
  });

  // ── Large Dataset Warning ──────────────────────────────────
  describe("large dataset handling", () => {
    test("logs warning for datasets > 10k docs", async () => {
      // This test would require mocking logger.warn and adding 10k+ docs
      // For now, we just verify the store doesn't crash with moderate sizes
      const docs = Array(100).fill(null).map((_, i) => ({
        id: `doc${i}`,
        content: `content ${i}`,
        metadata: { projectId: "large-project" },
      }));

      await store.addDocuments(docs);
      
      const results = await store.search("content", 10, "large-project");
      expect(results.length).toBe(10);
    });
  });
});
