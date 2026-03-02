/**
 * Unit tests for SearchController
 *
 * Tests preview generation and glob pattern filtering logic.
 * These are pure functions that don't need DB access.
 */

import { describe, test, expect, mock, beforeAll } from "bun:test";

// ── Mock dependencies ────────────────────────────────────────
mock.module("@th0th/shared", () => {
  const actual = require("@th0th/shared");
  return {
    ...actual,
    config: {
      get: (key: string) => {
        if (key === "dataDir") return "/tmp/th0th-test-search-ctrl";
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

// Mock ContextualSearchRLM since it requires full infrastructure
mock.module("../services/search/contextual-search-rlm.js", () => ({
  ContextualSearchRLM: class MockSearch {
    async search() {
      return [];
    }
    async ensureFreshIndex() {
      return { wasStale: false, reindexed: false };
    }
  },
}));

import { SearchController } from "../controllers/search-controller.js";

describe("SearchController", () => {
  let controller: SearchController;

  beforeAll(() => {
    (SearchController as any).instance = null;
    controller = SearchController.getInstance();
  });

  // ── generatePreview ───────────────────────────────────────
  describe("generatePreview", () => {
    test("returns preview from metadata if available", () => {
      const result = {
        content: "full content here",
        metadata: { context: { preview: "metadata preview" } },
      };
      expect(controller.generatePreview(result)).toBe("metadata preview");
    });

    test("skips import lines and comments", () => {
      const result = {
        content: `import foo from "bar";\n// comment\nexport function main() {}`,
        metadata: {},
      };
      const preview = controller.generatePreview(result);
      expect(preview).toBe("export function main() {}");
    });

    test("falls back to first line if all are imports/comments", () => {
      const result = {
        content: `import a from "a";\nimport b from "b";`,
        metadata: {},
      };
      const preview = controller.generatePreview(result);
      expect(preview).toContain("import");
    });

    test("truncates long previews at 100 chars", () => {
      const result = {
        content: "x".repeat(200),
        metadata: {},
      };
      const preview = controller.generatePreview(result);
      expect(preview.length).toBeLessThanOrEqual(100);
      expect(preview).toEndWith("...");
    });

    test("returns (empty) for no content", () => {
      const result = { content: "", metadata: {} };
      expect(controller.generatePreview(result)).toBe("(empty)");
    });
  });

  // ── filterByPatterns ──────────────────────────────────────
  describe("filterByPatterns", () => {
    const results = [
      { id: "1", metadata: { filePath: "src/controllers/memory.ts" } },
      { id: "2", metadata: { filePath: "src/services/graph.ts" } },
      { id: "3", metadata: { filePath: "tests/memory.test.ts" } },
      { id: "4", metadata: { filePath: "node_modules/foo/bar.js" } },
      { id: "5", metadata: {} }, // No filePath
    ];

    test("no filters returns all results", () => {
      const filtered = controller.filterByPatterns(results);
      expect(filtered.length).toBe(5);
    });

    test("include filter keeps only matching", () => {
      const filtered = controller.filterByPatterns(results, ["src/**/*.ts"]);
      expect(filtered.length).toBe(3); // 2 src files + 1 no-path (passthrough)
    });

    test("exclude filter removes matching", () => {
      const filtered = controller.filterByPatterns(results, undefined, [
        "node_modules/**",
      ]);
      expect(filtered.length).toBe(4);
      expect(filtered.every((r: any) => !r.metadata?.filePath?.startsWith("node_modules"))).toBe(true);
    });

    test("both include and exclude", () => {
      const filtered = controller.filterByPatterns(
        results,
        ["src/**/*.ts"],
        ["src/services/**"],
      );
      // Include src/**/*.ts -> mem.ts, graph.ts, + no-path
      // Exclude src/services/** -> removes graph.ts
      expect(filtered.some((r: any) => r.id === "1")).toBe(true); // controllers/memory.ts
      expect(filtered.some((r: any) => r.id === "2")).toBe(false); // services/graph.ts excluded
    });
  });

  // ── singleton ─────────────────────────────────────────────
  describe("singleton", () => {
    test("returns same instance", () => {
      const a = SearchController.getInstance();
      const b = SearchController.getInstance();
      expect(a).toBe(b);
    });
  });
});
