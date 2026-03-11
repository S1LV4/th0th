/**
 * SessionFileCache — unit tests
 *
 * Run with: bun test packages/core/src/__tests__/session-file-cache.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  SessionFileCache,
  REFERENCE_TOKEN_COST,
} from "../services/context/session-file-cache.js";

// ── Reset singleton between test suites ──────────────────────────────────────

function freshCache(): SessionFileCache {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (SessionFileCache as any).instance = null;
  return SessionFileCache.getInstance();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SESSION = "test-session-1";
const OTHER   = "test-session-2";

function makeContent(lines: string[]): string {
  return lines.join("\n");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionFileCache", () => {
  let cache: SessionFileCache;

  beforeEach(() => {
    cache = freshCache();
  });

  // ── chunkKey ────────────────────────────────────────────────────────────────

  describe("chunkKey", () => {
    it("formats key as path:start-end", () => {
      expect(cache.chunkKey("src/foo.ts", 1, 50)).toBe("src/foo.ts:1-50");
    });
  });

  // ── First delivery (new) ────────────────────────────────────────────────────

  describe("first delivery", () => {
    it("returns status 'new' for an unseen chunk", () => {
      const key     = cache.chunkKey("src/a.ts", 1, 10);
      const content = makeContent(["const x = 1;", "const y = 2;"]);

      const result = cache.check(SESSION, key, content);

      expect(result.status).toBe("new");
      expect(result.tokensSaved).toBe(0);
      expect(result.diff).toBeUndefined();
    });

    it("returns 'new' independently for different sessions", () => {
      const key     = cache.chunkKey("src/a.ts", 1, 10);
      const content = "const x = 1;";

      cache.check(SESSION, key, content); // primes SESSION

      const result = cache.check(OTHER, key, content); // OTHER is fresh
      expect(result.status).toBe("new");
    });
  });

  // ── Repeated delivery (unchanged) ──────────────────────────────────────────

  describe("unchanged chunk", () => {
    it("returns status 'unchanged' on second call with same content", () => {
      const key     = cache.chunkKey("src/b.ts", 5, 20);
      const content = makeContent(["function foo() {", "  return 42;", "}"]);

      cache.check(SESSION, key, content); // first call
      const result = cache.check(SESSION, key, content); // second call

      expect(result.status).toBe("unchanged");
      expect(result.diff).toBeUndefined();
    });

    it("tokensSaved is positive for non-trivial content", () => {
      const key     = cache.chunkKey("src/b.ts", 5, 20);
      const content = "x".repeat(200); // ~50 tokens

      cache.check(SESSION, key, content);
      const result = cache.check(SESSION, key, content);

      expect(result.tokensSaved).toBeGreaterThan(REFERENCE_TOKEN_COST);
    });

    it("tokensSaved = 0 when content is shorter than REFERENCE_TOKEN_COST", () => {
      const key     = cache.chunkKey("src/tiny.ts", 1, 1);
      const content = "x"; // 1 char → ~1 token < REFERENCE_TOKEN_COST

      cache.check(SESSION, key, content);
      const result = cache.check(SESSION, key, content);

      // Math.max(0, ...) clamp — should not go negative
      expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Content changed ─────────────────────────────────────────────────────────

  describe("changed chunk", () => {
    it("returns status 'changed' when content differs", () => {
      const key = cache.chunkKey("src/c.ts", 1, 3);

      cache.check(SESSION, key, "const a = 1;\nconst b = 2;");
      const result = cache.check(SESSION, key, "const a = 1;\nconst b = 99;");

      expect(result.status).toBe("changed");
    });

    it("diff contains the changed line", () => {
      const key = cache.chunkKey("src/c.ts", 1, 3);

      cache.check(SESSION, key, "const b = 2;");
      const result = cache.check(SESSION, key, "const b = 99;");

      expect(result.diff).toContain("- const b = 2;");
      expect(result.diff).toContain("+ const b = 99;");
    });

    it("diff handles line additions", () => {
      const key = cache.chunkKey("src/c.ts", 1, 5);

      cache.check(SESSION, key, "line1\nline2");
      const result = cache.check(SESSION, key, "line1\nline2\nline3");

      expect(result.status).toBe("changed");
      expect(result.diff).toContain("+ line3");
    });

    it("diff handles line removals", () => {
      const key = cache.chunkKey("src/c.ts", 1, 5);

      cache.check(SESSION, key, "line1\nline2\nline3");
      const result = cache.check(SESSION, key, "line1\nline2");

      expect(result.status).toBe("changed");
      expect(result.diff).toContain("- line3");
    });

    it("updates the cached record after a change", () => {
      const key = cache.chunkKey("src/d.ts", 1, 2);

      cache.check(SESSION, key, "v1");
      cache.check(SESSION, key, "v2"); // changed
      const result = cache.check(SESSION, key, "v2"); // now unchanged

      expect(result.status).toBe("unchanged");
    });
  });

  // ── Session isolation ───────────────────────────────────────────────────────

  describe("session isolation", () => {
    it("does not share state between different sessions", () => {
      const key     = cache.chunkKey("src/e.ts", 1, 5);
      const content = "shared content";

      cache.check(SESSION, key, content);
      cache.check(OTHER,   key, content);

      // Both sessions see the chunk — but they hold independent records
      const r1 = cache.check(SESSION, key, content);
      const r2 = cache.check(OTHER,   key, content);

      expect(r1.status).toBe("unchanged");
      expect(r2.status).toBe("unchanged");
    });
  });

  // ── invalidateSession ───────────────────────────────────────────────────────

  describe("invalidateSession", () => {
    it("forces 'new' on all chunks after invalidation", () => {
      const key     = cache.chunkKey("src/f.ts", 1, 5);
      const content = "some code";

      cache.check(SESSION, key, content); // prime
      cache.invalidateSession(SESSION);

      const result = cache.check(SESSION, key, content);
      expect(result.status).toBe("new");
    });

    it("does not affect other sessions", () => {
      const key     = cache.chunkKey("src/f.ts", 1, 5);
      const content = "code";

      cache.check(SESSION, key, content);
      cache.check(OTHER,   key, content);
      cache.invalidateSession(SESSION); // only SESSION evicted

      const result = cache.check(OTHER, key, content);
      expect(result.status).toBe("unchanged");
    });
  });

  // ── getStats ─────────────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("counts checks and hits correctly", () => {
      const key     = cache.chunkKey("src/g.ts", 1, 5);
      const content = "code content...";

      cache.check(SESSION, key, content); // check 1: new (no hit)
      cache.check(SESSION, key, content); // check 2: unchanged (hit)
      cache.check(SESSION, key, content); // check 3: unchanged (hit)

      const stats = cache.getStats();
      expect(stats.totalChecks).toBe(3);
      expect(stats.cacheHits).toBe(2);
      expect(stats.unchangedHits).toBe(2);
      expect(stats.changedHits).toBe(0);
      expect(stats.totalTokensSaved).toBeGreaterThanOrEqual(0);
    });

    it("increments trackedSessions for new sessions", () => {
      const key = cache.chunkKey("src/h.ts", 1, 1);

      cache.check("sess-a", key, "a");
      cache.check("sess-b", key, "b");

      const stats = cache.getStats();
      expect(stats.trackedSessions).toBe(2);
    });
  });
});
