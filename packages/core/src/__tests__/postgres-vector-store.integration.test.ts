/**
 * Integration tests for PostgresVectorStore
 *
 * These tests require a running PostgreSQL instance with pgvector.
 * Run with: docker-compose -f docker-compose.test.yml up -d
 * 
 * Connection: postgresql://test:test@localhost:5433/th0th_test
 * 
 * Skip these tests in CI if PostgreSQL is not available:
 *   SKIP_POSTGRES_TESTS=1 bun test
 * 
 * Or run explicitly:
 *   RUN_POSTGRES_TESTS=1 bun test postgres-vector-store.integration.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { SearchSource } from "@th0th-ai/shared";

// Only run if explicitly enabled (requires PostgreSQL running)
const RUN_TESTS = process.env.RUN_POSTGRES_TESTS === "1";
const POSTGRES_URL = process.env.POSTGRES_TEST_URL || "postgresql://test:test@localhost:5433/th0th_test";

// These tests need real embeddings, so we don't mock the embedding service
// Make sure OLLAMA_URL is set or embeddings are available

import { PostgresVectorStore } from "../data/vector/postgres-vector-store.js";

describe.skipIf(!RUN_TESTS)("PostgresVectorStore Integration", () => {
  let store: PostgresVectorStore;

  beforeAll(async () => {
    store = new PostgresVectorStore({
      connectionString: POSTGRES_URL,
      poolSize: 5,
      indexType: "hnsw",
      indexParams: { m: 16, efConstruction: 64 },
    });
  });

  afterAll(async () => {
    // Cleanup test data
    try {
      await store.deleteByProject("integration-test");
      await store.deleteByProject("integration-test-2");
    } catch {
      // Ignore cleanup errors
    }
    await store.close();
  });

  beforeEach(async () => {
    // Clean up before each test
    await store.deleteByProject("integration-test");
  });

  // ── Connection Tests ───────────────────────────────────────
  describe("connection", () => {
    test("connects to PostgreSQL successfully", async () => {
      const healthy = await store.healthCheck();
      expect(healthy).toBe(true);
    });

    test("creates pgvector extension", async () => {
      // If we got here, the extension was created successfully
      // during initialization
      const stats = await store.getStats();
      expect(stats).toBeDefined();
    });
  });

  // ── Document Operations ────────────────────────────────────
  describe("document operations", () => {
    test("adds and retrieves document", async () => {
      await store.addDocument("int-doc-1", "TypeScript is a typed JavaScript", {
        projectId: "integration-test",
        filePath: "/test/file.ts",
      });

      const stats = await store.getStats("integration-test");
      expect(stats.totalDocuments).toBe(1);
    });

    test("batch inserts documents", async () => {
      const docs = [
        { id: "batch-1", content: "First document content", metadata: { projectId: "integration-test" } },
        { id: "batch-2", content: "Second document content", metadata: { projectId: "integration-test" } },
        { id: "batch-3", content: "Third document content", metadata: { projectId: "integration-test" } },
      ];

      await store.addDocuments(docs);

      const stats = await store.getStats("integration-test");
      expect(stats.totalDocuments).toBe(3);
    });

    test("updates document on conflict", async () => {
      await store.addDocument("update-doc", "original content", {
        projectId: "integration-test",
      });
      
      await store.addDocument("update-doc", "updated content", {
        projectId: "integration-test",
        newField: true,
      });

      const stats = await store.getStats("integration-test");
      expect(stats.totalDocuments).toBe(1);

      // Search should find the updated content
      const results = await store.search("updated content", 5, "integration-test");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toBe("updated content");
    });

    test("deletes document", async () => {
      await store.addDocument("delete-doc", "to be deleted", {
        projectId: "integration-test",
      });

      const deleted = await store.delete("delete-doc");
      expect(deleted).toBe(true);

      const stats = await store.getStats("integration-test");
      expect(stats.totalDocuments).toBe(0);
    });

    test("deletes all documents for project", async () => {
      await store.addDocuments([
        { id: "p1-doc1", content: "doc 1", metadata: { projectId: "integration-test" } },
        { id: "p1-doc2", content: "doc 2", metadata: { projectId: "integration-test" } },
        { id: "p2-doc1", content: "doc 3", metadata: { projectId: "integration-test-2" } },
      ]);

      const deleted = await store.deleteByProject("integration-test");
      
      expect(deleted).toBe(2);
      expect((await store.getStats("integration-test")).totalDocuments).toBe(0);
      expect((await store.getStats("integration-test-2")).totalDocuments).toBe(1);

      // Cleanup
      await store.deleteByProject("integration-test-2");
    });
  });

  // ── Search Tests ───────────────────────────────────────────
  describe("search", () => {
    beforeEach(async () => {
      // Add test documents
      await store.addDocuments([
        { id: "search-1", content: "TypeScript programming language features", metadata: { projectId: "integration-test" } },
        { id: "search-2", content: "JavaScript runtime and execution", metadata: { projectId: "integration-test" } },
        { id: "search-3", content: "Python machine learning algorithms", metadata: { projectId: "integration-test" } },
        { id: "search-4", content: "Database query optimization techniques", metadata: { projectId: "integration-test" } },
      ]);
    });

    test("finds semantically similar documents", async () => {
      const results = await store.search("TypeScript code", 4, "integration-test");

      expect(results.length).toBe(4);
      expect(results[0].source).toBe(SearchSource.VECTOR);
      // TypeScript doc should rank highest
      expect(results[0].id).toBe("search-1");
    });

    test("returns scores between 0 and 1", async () => {
      const results = await store.search("TypeScript", 4, "integration-test");

      for (const result of results) {
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }
    });

    test("respects limit parameter", async () => {
      const results = await store.search("programming", 2, "integration-test");

      expect(results.length).toBe(2);
    });

    test("filters by project", async () => {
      await store.addDocument("other-project", "TypeScript code", {
        projectId: "integration-test-2",
      });

      const results = await store.search("TypeScript", 10, "integration-test");

      expect(results.every(r => r.id !== "other-project")).toBe(true);

      // Cleanup
      await store.deleteByProject("integration-test-2");
    });

    test("searches across all projects when no projectId", async () => {
      await store.addDocument("other-project", "TypeScript code", {
        projectId: "integration-test-2",
      });

      const results = await store.search("TypeScript", 10);

      expect(results.some(r => r.id === "other-project")).toBe(true);

      // Cleanup
      await store.deleteByProject("integration-test-2");
    });
  });

  // ── Statistics Tests ───────────────────────────────────────
  describe("statistics", () => {
    test("returns accurate document count", async () => {
      await store.addDocuments([
        { id: "stat-1", content: "doc 1", metadata: { projectId: "integration-test" } },
        { id: "stat-2", content: "doc 2", metadata: { projectId: "integration-test" } },
      ]);

      const stats = await store.getStats("integration-test");

      expect(stats.totalDocuments).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.embeddingDimensions).toBeGreaterThan(0);
    });

    test("reports index status", async () => {
      const stats = await store.getStats();

      expect(stats.indexType).toBe("hnsw");
      expect(["ready", "none"]).toContain(stats.indexStatus);
    });
  });

  // ── Project Listing ────────────────────────────────────────
  describe("listProjects", () => {
    test("lists all projects with counts", async () => {
      await store.addDocuments([
        { id: "list-1", content: "doc 1", metadata: { projectId: "integration-test" } },
        { id: "list-2", content: "doc 2", metadata: { projectId: "integration-test" } },
        { id: "list-3", content: "doc 3", metadata: { projectId: "integration-test-2" } },
      ]);

      const projects = await store.listProjects();

      const project1 = projects.find(p => p.projectId === "integration-test");
      const project2 = projects.find(p => p.projectId === "integration-test-2");

      expect(project1?.documentCount).toBe(2);
      expect(project2?.documentCount).toBe(1);

      // Cleanup
      await store.deleteByProject("integration-test-2");
    });
  });

  // ── Performance Tests ──────────────────────────────────────
  describe("performance", () => {
    test("handles batch of 100 documents", async () => {
      const docs = Array(100).fill(null).map((_, i) => ({
        id: `perf-${i}`,
        content: `Document number ${i} with some content for embedding`,
        metadata: { projectId: "integration-test" },
      }));

      const start = Date.now();
      await store.addDocuments(docs);
      const insertTime = Date.now() - start;

      console.log(`Inserted 100 docs in ${insertTime}ms`);

      const searchStart = Date.now();
      const results = await store.search("document content", 10, "integration-test");
      const searchTime = Date.now() - searchStart;

      console.log(`Search in 100 docs took ${searchTime}ms`);

      expect(results.length).toBe(10);
      expect(searchTime).toBeLessThan(5000); // Should be fast with HNSW
    }, 60000); // Allow more time for embedding generation
  });
});
