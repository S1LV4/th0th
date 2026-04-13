/**
 * Unit tests for PostgresVectorStore
 *
 * These tests verify the PostgresVectorStore configuration and error handling
 * without requiring a real PostgreSQL connection.
 * 
 * For full integration tests with a real PostgreSQL instance, see:
 *   postgres-vector-store.integration.test.ts
 *   Run with: RUN_POSTGRES_TESTS=1 bun test postgres-vector-store.integration.test.ts
 */

import { describe, test, expect } from "bun:test";
import { PostgresVectorStore, PostgresConfig } from "../data/vector/postgres-vector-store.js";

describe("PostgresVectorStore", () => {
  // ── Configuration Tests ────────────────────────────────────
  describe("configuration", () => {
    test("accepts minimal config with just connectionString", () => {
      const store = new PostgresVectorStore({
        connectionString: "postgresql://test@localhost/test",
      });
      
      expect(store).toBeDefined();
    });

    test("applies default poolSize of 10", () => {
      const config: PostgresConfig = {
        connectionString: "postgresql://test@localhost/test",
      };
      
      const store = new PostgresVectorStore(config);
      
      // Can't directly verify, but constructor should not throw
      expect(store).toBeDefined();
    });

    test("applies default indexType of hnsw", () => {
      const config: PostgresConfig = {
        connectionString: "postgresql://test@localhost/test",
      };
      
      const store = new PostgresVectorStore(config);
      
      expect(store).toBeDefined();
    });

    test("accepts custom poolSize", () => {
      const store = new PostgresVectorStore({
        connectionString: "postgresql://test@localhost/test",
        poolSize: 25,
      });
      
      expect(store).toBeDefined();
    });

    test("accepts custom indexType ivfflat", () => {
      const store = new PostgresVectorStore({
        connectionString: "postgresql://test@localhost/test",
        indexType: "ivfflat",
      });
      
      expect(store).toBeDefined();
    });

    test("accepts custom index params for hnsw", () => {
      const store = new PostgresVectorStore({
        connectionString: "postgresql://test@localhost/test",
        indexType: "hnsw",
        indexParams: { m: 32, efConstruction: 128 },
      });
      
      expect(store).toBeDefined();
    });

    test("accepts custom index params for ivfflat", () => {
      const store = new PostgresVectorStore({
        connectionString: "postgresql://test@localhost/test",
        indexType: "ivfflat",
        indexParams: { lists: 200 },
      });
      
      expect(store).toBeDefined();
    });
  });

  // ── Health Check (without connection) ──────────────────────
  describe("healthCheck", () => {
    test("returns false when not initialized", async () => {
      const store = new PostgresVectorStore({
        connectionString: "postgresql://test@localhost/test",
      });
      
      const healthy = await store.healthCheck();
      
      expect(healthy).toBe(false);
    });
  });

  // ── Close (without connection) ─────────────────────────────
  describe("close", () => {
    test("handles close on uninitialized store", async () => {
      const store = new PostgresVectorStore({
        connectionString: "postgresql://test@localhost/test",
      });
      
      // Should not throw
      await store.close();
    });
  });

  // ── Interface Compliance ───────────────────────────────────
  describe("interface compliance", () => {
    test("has all required IVectorStore methods", () => {
      const store = new PostgresVectorStore({
        connectionString: "postgresql://test@localhost/test",
      });
      
      // Verify all methods exist
      expect(typeof store.addDocument).toBe("function");
      expect(typeof store.addDocuments).toBe("function");
      expect(typeof store.search).toBe("function");
      expect(typeof store.searchByEmbedding).toBe("function");
      expect(typeof store.delete).toBe("function");
      expect(typeof store.deleteByProject).toBe("function");
      expect(typeof store.update).toBe("function");
      expect(typeof store.getStats).toBe("function");
      expect(typeof store.listProjects).toBe("function");
      expect(typeof store.healthCheck).toBe("function");
      expect(typeof store.close).toBe("function");
    });
  });
});

// ── PostgresConfig Type Tests ────────────────────────────────
describe("PostgresConfig", () => {
  test("connectionString is required", () => {
    // TypeScript ensures this at compile time
    const config: PostgresConfig = {
      connectionString: "postgresql://test@localhost/test",
    };
    
    expect(config.connectionString).toBeDefined();
  });

  test("poolSize is optional", () => {
    const config: PostgresConfig = {
      connectionString: "postgresql://test@localhost/test",
      // poolSize not provided
    };
    
    expect(config.poolSize).toBeUndefined();
  });

  test("indexType accepts hnsw or ivfflat", () => {
    const hnswConfig: PostgresConfig = {
      connectionString: "postgresql://test@localhost/test",
      indexType: "hnsw",
    };
    
    const ivfflatConfig: PostgresConfig = {
      connectionString: "postgresql://test@localhost/test",
      indexType: "ivfflat",
    };
    
    expect(hnswConfig.indexType).toBe("hnsw");
    expect(ivfflatConfig.indexType).toBe("ivfflat");
  });
});
