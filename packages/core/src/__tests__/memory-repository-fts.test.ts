/**
 * Unit tests for MemoryRepository FTS5 query sanitization
 *
 * Validates that special characters in search queries (hyphens, quotes, etc.)
 * are properly escaped to prevent SQLite FTS5 interpretation errors.
 *
 * Bug context: Searching for "Agente-GT" caused SQLiteError "no such column: GT"
 * because FTS5 interprets "-" as a NOT operator.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

/**
 * Extracts just the FTS query building logic from MemoryRepository
 * so we can test it in isolation AND against a real FTS5 table.
 */
function buildFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
}

/**
 * The BUGGY version (without quoting) for comparison
 */
function buildFtsQueryBuggy(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .join(" OR ");
}

describe("MemoryRepository FTS5 Query Sanitization", () => {
  // ── Pure unit tests for query building ─────────────────────

  describe("buildFtsQuery (fixed)", () => {
    test("wraps simple terms in double quotes", () => {
      const result = buildFtsQuery("hello world");
      expect(result).toBe('"hello" OR "world"');
    });

    test("wraps hyphenated terms in double quotes to prevent NOT interpretation", () => {
      const result = buildFtsQuery("Agente-GT");
      expect(result).toBe('"Agente-GT"');
    });

    test("handles multi-word query with hyphens", () => {
      const result = buildFtsQuery("regras globais Agente-GT");
      expect(result).toBe('"regras" OR "globais" OR "Agente-GT"');
    });

    test("escapes double quotes inside terms", () => {
      const result = buildFtsQuery('term with "quotes"');
      expect(result).toBe('"term" OR "with" OR """quotes"""');
    });

    test("handles empty/whitespace-only input", () => {
      expect(buildFtsQuery("")).toBe("");
      expect(buildFtsQuery("   ")).toBe("");
    });

    test("handles single term", () => {
      expect(buildFtsQuery("typescript")).toBe('"typescript"');
    });

    test("handles terms with multiple special FTS5 operators", () => {
      // FTS5 operators: AND, OR, NOT, NEAR, +, -, *, ^
      const result = buildFtsQuery("foo+bar baz*qux");
      expect(result).toBe('"foo+bar" OR "baz*qux"');
    });

    test("handles terms with parentheses (FTS5 grouping)", () => {
      const result = buildFtsQuery("(grouped) terms");
      expect(result).toBe('"(grouped)" OR "terms"');
    });

    test("normalizes multiple spaces", () => {
      const result = buildFtsQuery("  spaced   out   terms  ");
      expect(result).toBe('"spaced" OR "out" OR "terms"');
    });
  });

  // ── Integration tests against real SQLite FTS5 ─────────────

  describe("FTS5 integration with real SQLite", () => {
    let db: Database;

    beforeEach(() => {
      db = new Database(":memory:");

      // Create the same schema as MemoryRepository
      db.exec(`
        CREATE TABLE memories (
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

        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          tags,
          content='memories',
          content_rowid='rowid'
        );
      `);

      // Insert test data
      const now = Date.now();
      const insertMemory = db.prepare(`
        INSERT INTO memories (id, content, type, level, importance, tags, created_at, updated_at)
        VALUES (?, ?, 'code', 1, 0.5, '[]', ?, ?)
      `);

      const insertFts = db.prepare(`
        INSERT INTO memories_fts (rowid, content, tags)
        SELECT rowid, content, tags FROM memories WHERE id = ?
      `);

      const testData = [
        ["m1", "regras globais e padrões de codificação do projeto Agente-GT"],
        ["m2", "configuração do TypeScript para o projeto"],
        ["m3", "padrões de arquitetura do Agente-GT backend"],
        ["m4", "deploy do sistema em produção"],
        ["m5", "next-auth configuração de autenticação"],
        ["m6", 'termo com "aspas" no conteúdo'],
      ];

      for (const [id, content] of testData) {
        insertMemory.run(id, content, now, now);
        insertFts.run(id);
      }
    });

    afterEach(() => {
      db.close();
    });

    function searchWithFixedQuery(query: string): any[] {
      const ftsQuery = buildFtsQuery(query);
      if (!ftsQuery) return [];
      return db
        .prepare(
          `SELECT m.id, m.content
           FROM memories m
           JOIN memories_fts fts ON m.rowid = fts.rowid
           WHERE fts.content MATCH ?`,
        )
        .all(ftsQuery);
    }

    function searchWithBuggyQuery(query: string): any[] {
      const ftsQuery = buildFtsQueryBuggy(query);
      if (!ftsQuery) return [];
      return db
        .prepare(
          `SELECT m.id, m.content
           FROM memories m
           JOIN memories_fts fts ON m.rowid = fts.rowid
           WHERE fts.content MATCH ?`,
        )
        .all(ftsQuery);
    }

    test("BUGGY: searching 'Agente-GT' throws SQLiteError 'no such column: GT'", () => {
      expect(() => searchWithBuggyQuery("Agente-GT")).toThrow(
        /no such column: GT/,
      );
    });

    test("FIXED: searching 'Agente-GT' returns results without error", () => {
      const results = searchWithFixedQuery("Agente-GT");
      expect(results.length).toBeGreaterThan(0);
      // Should find memories that contain "Agente-GT"
      const ids = results.map((r: any) => r.id);
      expect(ids).toContain("m1");
      expect(ids).toContain("m3");
    });

    test("BUGGY: searching 'next-auth' throws SQLiteError 'no such column: auth'", () => {
      expect(() => searchWithBuggyQuery("next-auth")).toThrow(
        /no such column: auth/,
      );
    });

    test("FIXED: searching 'next-auth' returns results without error", () => {
      const results = searchWithFixedQuery("next-auth");
      expect(results.length).toBeGreaterThan(0);
      const ids = results.map((r: any) => r.id);
      expect(ids).toContain("m5");
    });

    test("FIXED: multi-word query with hyphens works correctly", () => {
      const results = searchWithFixedQuery(
        "regras globais Agente-GT",
      );
      expect(results.length).toBeGreaterThan(0);
      const ids = results.map((r: any) => r.id);
      expect(ids).toContain("m1");
    });

    test("FIXED: simple query without special chars still works", () => {
      const results = searchWithFixedQuery("TypeScript projeto");
      expect(results.length).toBeGreaterThan(0);
      const ids = results.map((r: any) => r.id);
      expect(ids).toContain("m2");
    });

    test("FIXED: query with double quotes in content works", () => {
      const results = searchWithFixedQuery('aspas');
      expect(results.length).toBeGreaterThan(0);
      const ids = results.map((r: any) => r.id);
      expect(ids).toContain("m6");
    });

    test("FIXED: empty query returns no results", () => {
      const results = searchWithFixedQuery("");
      expect(results.length).toBe(0);
    });
  });
});
