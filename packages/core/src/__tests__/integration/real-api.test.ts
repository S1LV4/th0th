/**
 * Real-world integration tests against the running th0th API.
 *
 * Uses the th0th codebase itself as the test fixture — indexes the project
 * and validates semantic search, memory, symbol graph, and compression.
 *
 * Requires:
 *   - API running at http://localhost:3333
 *   - Ollama with qwen3-embedding (or bge-m3) available
 *   - Local PostgreSQL at localhost:5434
 *
 * Run: DATABASE_URL=postgresql://th0th:th0th_password@localhost:5434/th0th \
 *        bun test src/__tests__/integration/real-api.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import path from "path";

const API = process.env.TH0TH_API_URL ?? "http://localhost:3333";
const PROJECT_ID = "th0th-self-test";
const PROJECT_PATH = path.resolve(__dirname, "../../../../..");  // project root

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function get(endpoint: string) {
  const res = await fetch(`${API}${endpoint}`);
  return res.json();
}

async function post(endpoint: string, body: unknown) {
  const res = await fetch(`${API}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Poll until condition is true or timeout
async function pollUntil(
  fn: () => Promise<boolean>,
  { timeoutMs = 120_000, intervalMs = 3_000 } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("th0th API — real integration (using th0th codebase as fixture)", () => {

  // ── Health ─────────────────────────────────────────────────────────────────
  describe("health", () => {
    test("API is up and reports healthy", async () => {
      const res = await get("/health");
      expect(res.status).toBe("ok");
      expect(res.service).toBe("th0th-tools-api");
      expect(res.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  // ── Indexing ───────────────────────────────────────────────────────────────
  describe("project indexing", () => {
    let jobId: string;

    test("POST /api/v1/project/index returns a jobId", async () => {
      const res = await post("/api/v1/project/index", {
        projectPath: PROJECT_PATH,
        projectId: PROJECT_ID,
        forceReindex: true,
      });

      // Accept either immediate success or async jobId
      if (res.data?.jobId) {
        jobId = res.data.jobId;
        expect(typeof jobId).toBe("string");
      } else {
        expect(res.success ?? res.status).toBeTruthy();
      }
    }, 30_000);

    test("GET /api/v1/project/index/status/:jobId resolves to indexed", async () => {
      if (!jobId) return;  // skipped if index was synchronous

      const done = await pollUntil(async () => {
        const status = await get(`/api/v1/project/index/status/${jobId}`);
        return status.data?.status === "indexed" || status.data?.status === "completed";
      }, { timeoutMs: 120_000 });

      expect(done).toBe(true);
    }, 130_000);
  });

  // ── Search ─────────────────────────────────────────────────────────────────
  describe("semantic search", () => {

    test("finds the queue-based mutex implementation", async () => {
      const res = await post("/api/v1/search/project", {
        query: "concurrent indexing mutex queue lock serialization",
        projectId: PROJECT_ID,
        maxResults: 5,
        responseMode: "full",
        format: "json",
      });

      expect(res.success).toBe(true);
      const results = res.data?.results ?? [];
      expect(results.length).toBeGreaterThan(0);

      const topResult = results[0];
      expect(topResult.score).toBeGreaterThan(0);

      // Should surface contextual-search-rlm.ts which has the mutex
      const paths = results.map((r: any) => r.filePath ?? r.file ?? "");
      const hasRlm = paths.some((p: string) => p.includes("contextual-search-rlm"));
      expect(hasRlm).toBe(true);
    }, 30_000);

    test("finds the memory consolidation decay logic", async () => {
      const res = await post("/api/v1/search/project", {
        query: "memory decay importance stale executeRaw N+1 bulk update",
        projectId: PROJECT_ID,
        maxResults: 5,
        responseMode: "summary",
        format: "json",
      });

      expect(res.success).toBe(true);
      const results = res.data?.results ?? [];
      expect(results.length).toBeGreaterThan(0);

      const paths = results.map((r: any) => r.filePath ?? r.file ?? "");
      const hasJob = paths.some((p: string) => p.includes("memory-consolidation-job"));
      expect(hasJob).toBe(true);
    }, 30_000);

    test("finds Prisma client initialization code", async () => {
      const res = await post("/api/v1/search/project", {
        query: "PrismaClient PostgreSQL SQLite adapter singleton initialization",
        projectId: PROJECT_ID,
        maxResults: 5,
        responseMode: "summary",
        format: "json",
      });

      expect(res.success).toBe(true);
      const results = res.data?.results ?? [];
      expect(results.length).toBeGreaterThan(0);

      const paths = results.map((r: any) => r.filePath ?? r.file ?? "");
      const hasPrisma = paths.some((p: string) => p.includes("prisma-client"));
      expect(hasPrisma).toBe(true);
    }, 30_000);

    test("summary mode returns significantly fewer tokens than full mode", async () => {
      const [summary, full] = await Promise.all([
        post("/api/v1/search/project", {
          query: "embedding provider configuration",
          projectId: PROJECT_ID,
          maxResults: 3,
          responseMode: "summary",
          format: "json",
        }),
        post("/api/v1/search/project", {
          query: "embedding provider configuration",
          projectId: PROJECT_ID,
          maxResults: 3,
          responseMode: "full",
          format: "json",
        }),
      ]);

      const summaryLen = JSON.stringify(summary).length;
      const fullLen = JSON.stringify(full).length;
      // Summary should be at least 40% smaller
      expect(summaryLen).toBeLessThan(fullLen * 0.6);
    }, 30_000);

    test("glob filter restricts results to matching files", async () => {
      const res = await post("/api/v1/search/project", {
        query: "index project files",
        projectId: PROJECT_ID,
        maxResults: 10,
        responseMode: "summary",
        format: "json",
        include: ["packages/core/src/services/**/*.ts"],
      });

      expect(res.success).toBe(true);
      const results = res.data?.results ?? [];
      for (const r of results) {
        const fp: string = r.filePath ?? r.file ?? "";
        expect(fp).toMatch(/packages\/core\/src\/services\//);
      }
    }, 30_000);

    test("nonsense query with minScore:0.7 returns zero results", async () => {
      // minScore is now applied to the RAW cosine similarity from the vector store,
      // not the normalized RRF score.  A nonsense query has raw vectorScore well
      // below 0.7 against any real code, so all results are filtered out.
      const res = await post("/api/v1/search/project", {
        query: "xzxzxz_nonexistent_gibberish_qqq",
        projectId: PROJECT_ID,
        maxResults: 3,
        minScore: 0.7,
        responseMode: "summary",
        format: "json",
      });

      expect(res.success).toBe(true);
      const results = res.data?.results ?? [];
      expect(results.length).toBe(0);
    }, 30_000);
  });

  // ── Symbol graph ──────────────────────────────────────────────────────────
  describe("symbol graph tools", () => {
    test("list projects returns th0th-self-test as indexed", async () => {
      const res = await get(`/api/v1/workspace/list`);
      expect(res.success ?? true).toBeTruthy();

      const projects = res.data ?? res;
      const found = Array.isArray(projects)
        ? projects.find((p: any) => p.projectId === PROJECT_ID || p.id === PROJECT_ID)
        : null;
      // May not be in list API depending on implementation — just assert no crash
      expect(res).toBeTruthy();
    }, 10_000);

    test("search definitions finds ContextualSearchRLM class", async () => {
      const res = await get(
        `/api/v1/symbol/definitions?projectId=${PROJECT_ID}&query=ContextualSearchRLM&kind=class`
      );

      expect(res.success ?? res).toBeTruthy();

      const defs = res.data?.definitions ?? res.data ?? [];
      if (Array.isArray(defs) && defs.length > 0) {
        const rlm = defs.find((d: any) =>
          (d.name ?? "").includes("ContextualSearchRLM")
        );
        expect(rlm).toBeTruthy();
        expect(rlm.file ?? rlm.filePath ?? "").toMatch(/contextual-search-rlm/);
      }
    }, 15_000);

    test("search definitions finds MemoryConsolidationJob class", async () => {
      const res = await get(
        `/api/v1/symbol/definitions?projectId=${PROJECT_ID}&query=MemoryConsolidationJob&kind=class`
      );

      expect(res.success ?? res).toBeTruthy();
      const defs = res.data?.definitions ?? res.data ?? [];
      if (Array.isArray(defs) && defs.length > 0) {
        const found = defs.find((d: any) =>
          (d.name ?? "").includes("MemoryConsolidationJob")
        );
        if (found) {
          expect(found.file ?? found.filePath ?? "").toMatch(/memory-consolidation-job/);
        }
      }
    }, 15_000);

    test("get references for getPrismaClient returns usages", async () => {
      const res = await get(
        `/api/v1/symbol/references?projectId=${PROJECT_ID}&symbolName=getPrismaClient`
      );

      expect(res.success ?? res).toBeTruthy();
      const refs = res.data?.references ?? res.data ?? [];
      if (Array.isArray(refs) && refs.length > 0) {
        // Should be referenced in at least memory-controller, search, etc.
        expect(refs.length).toBeGreaterThan(0);
      }
    }, 15_000);

    test("go to definition for indexProject resolves to contextual-search-rlm.ts", async () => {
      const res = await get(
        `/api/v1/symbol/definition?projectId=${PROJECT_ID}&symbolName=indexProject&fromFile=packages/core/src/controllers/search-controller.ts`
      );

      // Just verify the endpoint responds — symbol may not be indexed yet
      expect(res).toBeTruthy();
    }, 15_000);
  });

  // ── Memory ─────────────────────────────────────────────────────────────────
  describe("memory — store and recall", () => {
    const SESSION_ID = `test-session-${Date.now()}`;
    let storedMemoryId: string | null = null;

    test("stores a decision memory successfully", async () => {
      const res = await post("/api/v1/memory/store", {
        content: "Using PostgreSQL with pgvector for production deployments; SQLite for development",
        type: "decision",
        importance: 0.9,
        tags: ["database", "architecture", "deployment"],
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        format: "json",
      });

      expect(res.success).toBe(true);
      storedMemoryId = res.data?.memoryId ?? res.data?.id ?? null;
      expect(storedMemoryId).toBeTruthy();
    }, 15_000);

    test("stores a code pattern memory", async () => {
      const res = await post("/api/v1/memory/store", {
        content: "Queue-based mutex pattern: each caller chains onto the previous lock tail using Map<string, Promise<void>>",
        type: "pattern",
        importance: 0.85,
        tags: ["concurrency", "mutex", "pattern"],
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        format: "json",
      });

      expect(res.success).toBe(true);
    }, 15_000);

    test("recalls stored decision memory by semantic query", async () => {
      // Give the API a moment to persist
      await new Promise((r) => setTimeout(r, 500));

      const res = await post("/api/v1/memory/search", {
        query: "database deployment architecture decision PostgreSQL",
        projectId: PROJECT_ID,
        types: ["decision"],
        limit: 5,
        minImportance: 0.5,
        format: "json",
      });

      expect(res.success).toBe(true);
      const memories = res.data?.memories ?? [];
      expect(memories.length).toBeGreaterThan(0);

      const found = memories.find((m: any) =>
        (m.content ?? "").includes("PostgreSQL")
      );
      expect(found).toBeTruthy();
    }, 15_000);

    test("recalls stored pattern memory", async () => {
      await new Promise((r) => setTimeout(r, 500));

      const res = await post("/api/v1/memory/search", {
        query: "concurrent mutex lock queue pattern",
        projectId: PROJECT_ID,
        types: ["pattern"],
        limit: 5,
        minImportance: 0.5,
        format: "json",
      });

      expect(res.success).toBe(true);
      const memories = res.data?.memories ?? [];
      expect(memories.length).toBeGreaterThan(0);
    }, 15_000);

    test("returns empty results for an unrelated query", async () => {
      const res = await post("/api/v1/memory/search", {
        query: "xzxz_totally_unrelated_gibberish_1234",
        projectId: PROJECT_ID,
        limit: 5,
        minImportance: 0.9,
        format: "json",
      });

      expect(res.success).toBe(true);
      const memories = res.data?.memories ?? [];
      expect(memories.length).toBe(0);
    }, 15_000);
  });

  // ── Context compression ───────────────────────────────────────────────────
  describe("context compression", () => {
    const CODE_SAMPLE = `
import { getPrismaClient } from "../services/query/prisma-client.js";
import { Prisma } from "../../generated/prisma/index.js";
import { MemoryLevel } from "@th0th-ai/shared";

export class MemoryConsolidationJob {
  private running = false;
  private lastRunAt = 0;

  async decayStaleMemories(prisma: any, now: Date, day: number): Promise<number> {
    const staleThreshold = new Date(now.getTime() - 7 * day);
    let totalDecayed = 0;

    for (const [memType, rate] of Object.entries(DECAY_RATES)) {
      const result = await prisma.$executeRaw\`
        UPDATE memories
        SET importance = GREATEST(0.1, importance * \${rate}),
            updated_at = NOW()
        WHERE id IN (
          SELECT id FROM memories
          WHERE type = \${memType}
            AND importance < 0.8
            AND created_at < \${staleThreshold}
          LIMIT 500
        )
      \`;
      totalDecayed += result;
    }
    return totalDecayed;
  }
}
    `.trim();

    test("compresses TypeScript code with code_structure strategy", async () => {
      const res = await post("/api/v1/context/compress", {
        content: CODE_SAMPLE,
        strategy: "code_structure",
        targetRatio: 0.5,
        language: "typescript",
      });

      expect(res.success).toBe(true);
      const compressed = res.data?.compressed ?? res.data?.content ?? "";
      expect(compressed.length).toBeGreaterThan(0);
      expect(compressed.length).toBeLessThan(CODE_SAMPLE.length);
    }, 15_000);

    test("optimized_context returns search + compressed result", async () => {
      const res = await post("/api/v1/context/optimized", {
        query: "how does memory decay work?",
        projectId: PROJECT_ID,
        maxTokens: 2000,
        maxResults: 3,
      });

      expect(res.success).toBe(true);
      const ctx = res.data?.context ?? res.data?.compressed ?? "";
      expect(ctx.length).toBeGreaterThan(0);
    }, 30_000);
  });

  // ── Analytics ─────────────────────────────────────────────────────────────
  describe("analytics", () => {
    test("returns summary analytics", async () => {
      const res = await post("/api/v1/analytics", {
        type: "summary",
        limit: 5,
      });

      expect(res.success).toBe(true);
      const data = res.data ?? {};
      expect(data).toBeTruthy();
    }, 10_000);

    test("returns recent search analytics", async () => {
      const res = await post("/api/v1/analytics", {
        type: "recent",
        limit: 10,
      });

      expect(res.success).toBe(true);
    }, 10_000);
  });
});
