/**
 * Unit tests for RelationExtractor
 *
 * Tests the heuristic relation classification logic.
 * The classifyRelation method is public and testable without DB.
 */

import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { MemoryRelationType } from "@th0th/shared";

// ── Mock dependencies ────────────────────────────────────────
let tmpDir = "/tmp/th0th-test-relext";

mock.module("@th0th/shared", () => {
  const actual = require("@th0th/shared");
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
    },
  };
});

mock.module("../data/chromadb/vector-store.js", () => ({
  EmbeddingService: class MockEmbeddingService {
    async embed(_text: string): Promise<number[]> {
      return new Array(384).fill(0.1);
    }
  },
}));

import { RelationExtractor } from "../services/graph/relation-extractor.js";
import type { MemoryRowWithEmbedding } from "../services/graph/types.js";
import { GraphStore } from "../services/graph/graph-store.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("RelationExtractor.classifyRelation", () => {
  let extractor: RelationExtractor;
  let graphStore: GraphStore;

  function makeMemory(
    overrides: Partial<MemoryRowWithEmbedding> & { similarity?: number },
  ): MemoryRowWithEmbedding & { similarity: number } {
    return {
      id: "test_id",
      content: "test content",
      type: "code",
      level: 1,
      importance: 0.5,
      tags: "[]",
      embedding: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      access_count: 0,
      user_id: null,
      session_id: null,
      project_id: null,
      agent_id: null,
      similarity: 0.7,
      ...overrides,
    } as MemoryRowWithEmbedding & { similarity: number };
  }

  // Use a temp dir for DB
  let cleanupDir: string;

  beforeAll(() => {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), "th0th-test-relext-"));
    tmpDir = cleanupDir;
    (GraphStore as any).instance = null;
    graphStore = new GraphStore();
    extractor = new RelationExtractor(graphStore);
  });

  afterAll(() => {
    extractor.close();
    graphStore.close();
    fs.rmSync(cleanupDir, { recursive: true, force: true });
  });

  // ── Rule 1: SUPERSEDES ───────────────────────────────────
  test("SUPERSEDES: same type, very high similarity, newer", () => {
    const now = Date.now();
    const newMem = makeMemory({
      id: "new1",
      content: "Use Bun runtime for all builds",
      type: "decision",
      created_at: now,
    });
    const existing = makeMemory({
      id: "old1",
      content: "Use Bun runtime for all builds",
      type: "decision",
      created_at: now - 10000,
      similarity: 0.95,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.SUPERSEDES);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  // ── Rule 2: CONTRADICTS ──────────────────────────────────
  test("CONTRADICTS: contradiction signal in content", () => {
    const newMem = makeMemory({
      id: "new2",
      content: "We should no longer use Jest for testing",
      type: "decision",
    });
    const existing = makeMemory({
      id: "old2",
      content: "Use Jest for testing",
      type: "decision",
      similarity: 0.6,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.CONTRADICTS);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  test("CONTRADICTS: 'don't use' signal", () => {
    const newMem = makeMemory({
      id: "new3",
      content: "don't use global state for config",
      type: "pattern",
    });
    const existing = makeMemory({
      id: "old3",
      content: "use global state for config",
      type: "pattern",
      similarity: 0.7,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.CONTRADICTS);
  });

  // ── Rule 3: RESOLVES ─────────────────────────────────────
  test("RESOLVES: resolution signal + decision type", () => {
    const newMem = makeMemory({
      id: "new4",
      content: "Fixed the issue with memory leaks in graph traversal",
      type: "code",
    });
    const existing = makeMemory({
      id: "old4",
      content: "Memory leak in graph traversal",
      type: "decision",
      similarity: 0.7,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.RESOLVES);
  });

  test("RESOLVES: 'workaround' signal", () => {
    const newMem = makeMemory({
      id: "new5",
      content: "workaround for the FTS5 issue",
      type: "pattern",
    });
    const existing = makeMemory({
      id: "old5",
      content: "FTS5 doesn't work with special characters",
      type: "pattern",
      similarity: 0.65,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.RESOLVES);
  });

  // ── Rule 4: DERIVED_FROM ─────────────────────────────────
  test("DERIVED_FROM: derivation signal in content", () => {
    const newMem = makeMemory({
      id: "new6",
      content: "building on the previous decision about architecture",
      type: "decision",
    });
    const existing = makeMemory({
      id: "old6",
      content: "architecture decision about layers",
      type: "decision",
      similarity: 0.7,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.DERIVED_FROM);
  });

  test("DERIVED_FROM: type chain code from decision", () => {
    const newMem = makeMemory({
      id: "new7",
      content: "Implementation of the new controller layer",
      type: "code",
    });
    const existing = makeMemory({
      id: "old7",
      content: "Decision to add controller layer",
      type: "decision",
      similarity: 0.75,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.DERIVED_FROM);
  });

  // ── Rule 5: SUPPORTS ────────────────────────────────────
  test("SUPPORTS: support signal in content", () => {
    const newMem = makeMemory({
      id: "new8",
      content: "This confirms the approach of using SQLite",
      type: "decision",
    });
    const existing = makeMemory({
      id: "old8",
      content: "Use SQLite for graph storage",
      type: "decision",
      similarity: 0.7,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.SUPPORTS);
  });

  test("SUPPORTS: same type + high similarity for patterns", () => {
    const newMem = makeMemory({
      id: "new9",
      content: "Singleton pattern for services",
      type: "pattern",
    });
    const existing = makeMemory({
      id: "old9",
      content: "Singleton pattern for repositories",
      type: "pattern",
      similarity: 0.85,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.SUPPORTS);
  });

  // ── Rule 6: RELATES_TO (fallback) ───────────────────────
  test("RELATES_TO: high similarity without specific signals", () => {
    const newMem = makeMemory({
      id: "new10",
      content: "Memory management is important for performance",
      type: "code",
    });
    const existing = makeMemory({
      id: "old10",
      content: "Performance optimization for memory-intensive operations",
      type: "conversation",
      similarity: 0.8,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe(MemoryRelationType.RELATES_TO);
  });

  // ── No relation ──────────────────────────────────────────
  test("NONE: low similarity, no signals", () => {
    const newMem = makeMemory({
      id: "new11",
      content: "Refactor the database connection pool",
      type: "code",
    });
    const existing = makeMemory({
      id: "old11",
      content: "User prefers dark mode",
      type: "preference",
      similarity: 0.3,
    });

    const result = extractor.classifyRelation(newMem, existing);
    expect(result.relation).toBe("NONE");
    expect(result.confidence).toBe(0);
  });
});
