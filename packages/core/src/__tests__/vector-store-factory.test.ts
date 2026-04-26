/**
 * Unit tests for VectorStoreFactory
 *
 * Tests the factory pattern for vector store creation:
 * - Configuration from environment variables
 * - Singleton caching behavior
 * - Reset functionality for tests
 * 
 * NOTE: These tests use the real implementations since mocking ES modules
 * in bun is complex. Tests focus on behavior that can be verified without mocks.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// Mock the ChromaDB EmbeddingService so tests don't require a running Ollama.
// SQLiteVectorStore creates an EmbeddingService in its constructor, which
// would otherwise kick off a provider-selection round-trip to Ollama per test.
mock.module("../data/chromadb/vector-store.js", () => ({
  EmbeddingService: class MockEmbeddingService {
    async embed(text: string): Promise<number[]> {
      return new Array(384).fill(0.1);
    }
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(() => new Array(384).fill(0.1));
    }
    getDimensions() { return 384; }
  },
}));

import {
  getVectorStore,
  resetVectorStore,
} from "../data/vector/vector-store-factory.js";

describe("VectorStoreFactory", () => {
  // Store original env vars
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    // Reset state between tests
    await resetVectorStore();

    // Clear all env vars that can trigger Postgres or non-Ollama providers.
    // DATABASE_URL must also be cleared — the factory falls back to it as the
    // Postgres connection string, so leaving it set causes PostgresVectorStore
    // to be selected even when VECTOR_STORE_TYPE / POSTGRES_VECTOR_URL are unset.
    delete process.env.VECTOR_STORE_TYPE;
    delete process.env.POSTGRES_VECTOR_URL;
    delete process.env.POSTGRES_VECTOR_POOL_SIZE;
    delete process.env.POSTGRES_VECTOR_INDEX;
    delete process.env.DATABASE_URL;
    // Prevent new embedding providers from trying live endpoints during tests
    delete process.env.LITELLM_BASE_URL;
    delete process.env.CUSTOM_EMBEDDING_BASE_URL;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_API_KEY;
  });

  afterEach(async () => {
    await resetVectorStore();
    // Restore env vars
    Object.assign(process.env, originalEnv);
  });

  // ── Default Behavior (SQLite) ──────────────────────────────
  describe("default behavior", () => {
    test("returns SQLite store when no config provided", async () => {
      const store = await getVectorStore();

      expect(store).toBeDefined();
      expect(typeof store.search).toBe("function");
      expect(typeof store.addDocument).toBe("function");
    });

    test("returns SQLite when VECTOR_STORE_TYPE is sqlite", async () => {
      process.env.VECTOR_STORE_TYPE = "sqlite";

      const store = await getVectorStore();

      expect(store).toBeDefined();
      // SQLite store should have healthCheck
      const healthy = await store.healthCheck();
      expect(healthy).toBe(true);
    });
  });

  // ── Singleton Caching ──────────────────────────────────────
  describe("singleton caching", () => {
    test("returns same instance on subsequent calls", async () => {
      const store1 = await getVectorStore();
      const store2 = await getVectorStore();

      expect(store1).toBe(store2);
    });

    test("resets cache when resetVectorStore called", async () => {
      const store1 = await getVectorStore();
      const ref1 = store1;
      
      await resetVectorStore();
      
      const store2 = await getVectorStore();
      
      // After reset, health check on original should work
      // but we should get a new functional store
      expect(store2).toBeDefined();
      expect(await store2.healthCheck()).toBe(true);
    });

    test("concurrent calls return same instance", async () => {
      const promises = Array(5).fill(null).map(() => getVectorStore());
      const stores = await Promise.all(promises);

      const uniqueStores = new Set(stores);
      expect(uniqueStores.size).toBe(1);
    });
  });

  // ── resetVectorStore ───────────────────────────────────────
  describe("resetVectorStore", () => {
    test("handles reset when no store exists", async () => {
      // Should not throw
      await resetVectorStore();
    });

    test("allows getting new store after reset", async () => {
      await getVectorStore();
      await resetVectorStore();
      
      const store = await getVectorStore();
      expect(store).toBeDefined();
    });
  });

  // ── Config Matching ────────────────────────────────────────
  describe("config matching", () => {
    test("returns cached store if config type matches", async () => {
      const store1 = await getVectorStore({ type: "sqlite" });
      const store2 = await getVectorStore({ type: "sqlite" });

      expect(store1).toBe(store2);
    });
  });

  // ── Health Check ───────────────────────────────────────────
  describe("health check", () => {
    test("SQLite store passes health check", async () => {
      const store = await getVectorStore({ type: "sqlite" });
      
      const healthy = await store.healthCheck();
      
      expect(healthy).toBe(true);
    });
  });

  // ── PostgreSQL Config (without real connection) ────────────
  describe("PostgreSQL configuration", () => {
    test("falls back to SQLite if postgres type but no connection string", async () => {
      process.env.VECTOR_STORE_TYPE = "postgres";
      // No POSTGRES_VECTOR_URL set

      const store = await getVectorStore();

      // Should fallback to SQLite and be healthy
      const healthy = await store.healthCheck();
      expect(healthy).toBe(true);
    });
  });
});

// ── Usage Pattern Tests (for documentation) ──────────────────
describe("Usage Patterns", () => {
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    await resetVectorStore();
    delete process.env.DATABASE_URL;
    delete process.env.VECTOR_STORE_TYPE;
    delete process.env.POSTGRES_VECTOR_URL;
    delete process.env.LITELLM_BASE_URL;
    delete process.env.CUSTOM_EMBEDDING_BASE_URL;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_API_KEY;
  });

  afterEach(async () => {
    await resetVectorStore();
    Object.assign(process.env, savedEnv);
  });

  test("recommended test setup pattern", async () => {
    // In tests, always reset between test cases
    await resetVectorStore();

    // Then get a fresh store
    const store = await getVectorStore();

    // Use the store
    expect(store).toBeDefined();
    expect(await store.healthCheck()).toBe(true);

    // Cleanup
    await resetVectorStore();
  });

  test("production usage pattern (singleton)", async () => {
    // In production, just call getVectorStore() - it handles caching
    const store1 = await getVectorStore();
    const store2 = await getVectorStore();

    // Both should be healthy and functional
    expect(await store1.healthCheck()).toBe(true);
    expect(await store2.healthCheck()).toBe(true);
    
    // Both should have same methods
    expect(typeof store1.search).toBe("function");
    expect(typeof store2.search).toBe("function");
  });
});
