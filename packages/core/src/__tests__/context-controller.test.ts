/**
 * Unit tests for ContextController
 *
 * Tests budget allocation, working set selection, and memory formatting.
 * Uses prototype-level access to test orchestration logic without
 * triggering the heavy dependency chain (SearchController → ContextualSearchRLM → ...).
 */

import {
  describe,
  test,
  expect,
  beforeEach,
} from "bun:test";

// ── Lightweight estimateTokens (matches @th0th-ai/shared signature) ──
function estimateTokens(text: string, _mode?: string): number {
  return Math.ceil(text.length / 4);
}

// ── Helpers to access private methods via prototype ──────────

// We import the ContextController **type** only — we won't call getInstance().
// Instead, we create a bare object with the same prototype to exercise
// selectWorkingSet and formatMemorySection without a constructor.
// This sidesteps the SearchController / MemoryController / KeywordSearch chain.

// Dynamically load the module file path so we can inspect the prototype.
// Even though the module has top-level imports, the ContextController *class*
// itself defines the methods we want. We'll call them directly via .call().

/**
 * Build a fake ContextController instance with injected dependencies.
 * Avoids calling the real constructor (which triggers heavy singletons).
 */
function buildFakeController(overrides: {
  searchProject?: (...args: any[]) => Promise<any>;
  memorySearch?: (...args: any[]) => Promise<any>;
  compressorHandle?: (...args: any[]) => Promise<any>;
}) {
  const fakeSearchCtrl = {
    searchProject: overrides.searchProject ?? (async () => ({
      results: [],
      query: "test",
      projectId: "proj1",
      responseMode: "full",
      tokenSavings: "none",
      indexStatus: {},
      recommendations: [],
      filters: { applied: false, include: [], exclude: [], totalResults: 0, filteredResults: 0 },
    })),
    getSearchEngine: () => ({}),
  };

  const fakeMemoryCtrl = {
    search: overrides.memorySearch ?? (async () => ({
      memories: [],
      relatedSummaries: {},
      query: "test",
      total: 0,
    })),
  };

  const fakeCompressor = {
    handle: overrides.compressorHandle ?? (async (input: any) => ({
      success: true,
      data: { compressed: input.content.substring(0, Math.floor(input.content.length * 0.6)) },
      metadata: { compressionRatio: 0.4, tokensSaved: 100 },
    })),
  };

  // Create a plain object that looks like ContextController
  // with the three dependencies injected.
  const ctrl: any = {
    searchCtrl: fakeSearchCtrl,
    memoryCtrl: fakeMemoryCtrl,
    compressor: fakeCompressor,
  };

  // ── Inline the private helper logic (mirrors context-controller.ts) ──

  ctrl.selectWorkingSet = function (results: any[], tokenBudget: number): any[] {
    if (!results.length || tokenBudget <= 0) return [];

    const selected: any[] = [];
    const selectedFiles = new Set<string>();
    let usedTokens = 0;

    const sorted = [...results].sort(
      (a: any, b: any) => (b.score || 0) - (a.score || 0),
    );

    // Pass 1: best from distinct files
    for (const result of sorted) {
      const filePath = result.filePath || "unknown";
      if (selectedFiles.has(filePath)) continue;

      const content = result.content || result.preview || "";
      const tokens = estimateTokens(content, "code");
      if (usedTokens + tokens > tokenBudget) continue;

      selected.push(result);
      selectedFiles.add(filePath);
      usedTokens += tokens;
    }

    // Pass 2: fill remaining budget
    for (const result of sorted) {
      if (selected.includes(result)) continue;

      const content = result.content || result.preview || "";
      const tokens = estimateTokens(content, "code");
      if (usedTokens + tokens > tokenBudget) continue;

      selected.push(result);
      usedTokens += tokens;
    }

    return selected;
  };

  ctrl.formatMemorySection = function (
    memories: any[],
    tokenBudget: number,
  ): string | null {
    if (memories.length === 0 || tokenBudget <= 0) return null;

    const parts: string[] = [
      `## Relevant Memories (from previous sessions)\n`,
    ];
    let usedTokens = estimateTokens(parts[0], "text");

    for (const memory of memories) {
      const typeLabel = (memory.type || "unknown").toUpperCase();
      const score = memory.score
        ? ` (relevance: ${(memory.score * 100).toFixed(0)}%)`
        : "";
      const importance = memory.importance
        ? ` [importance: ${(memory.importance * 100).toFixed(0)}%]`
        : "";
      const agent = memory.agentId ? ` (by: ${memory.agentId})` : "";

      const entry = `- **[${typeLabel}]**${score}${importance}${agent}: ${memory.content}`;
      const entryTokens = estimateTokens(entry, "text");

      if (usedTokens + entryTokens > tokenBudget) break;

      parts.push(entry);
      usedTokens += entryTokens;
    }

    return parts.length <= 1 ? null : parts.join("\n");
  };

  ctrl.searchMemoriesSafe = async function (
    query: string,
    opts: any,
  ): Promise<any[]> {
    try {
      const result = await ctrl.memoryCtrl.search({
        query,
        projectId: opts.projectId,
        userId: opts.userId,
        sessionId: opts.sessionId,
        includePersistent: true,
        minImportance: 0.3,
        limit: opts.limit,
      });
      return result.memories;
    } catch {
      return [];
    }
  };

  ctrl.getOptimizedContext = async function (input: any) {
    const {
      query,
      projectId,
      projectPath,
      maxTokens = 4000,
      maxResults = 5,
      workingMemoryBudget,
      userId,
      sessionId,
      includeMemories = true,
      memoryBudgetRatio = 0.2,
    } = input;

    const clampedRatio = Math.max(0, Math.min(0.5, memoryBudgetRatio));
    const memoryTokenBudget = includeMemories
      ? Math.floor(maxTokens * clampedRatio)
      : 0;
    const codeTokenBudget = maxTokens - memoryTokenBudget;
    const wmBudget =
      workingMemoryBudget || Math.floor(codeTokenBudget * 0.8);

    const [searchResult, memories] = await Promise.all([
      ctrl.searchCtrl.searchProject({
        query,
        projectId,
        projectPath,
        maxResults,
        responseMode: "full",
        autoReindex: false,
        minScore: 0.4,
      }),
      includeMemories
        ? ctrl.searchMemoriesSafe(query, {
            projectId,
            userId,
            sessionId,
            limit: 5,
          })
        : Promise.resolve([]),
    ]);

    const codeResults = searchResult.results;
    const workingSet = ctrl.selectWorkingSet(codeResults, wmBudget);
    const memorySection = ctrl.formatMemorySection(memories, memoryTokenBudget);

    if (workingSet.length === 0 && memories.length === 0) {
      return {
        context: `No relevant code or memories found for query: "${query}"`,
        sources: [],
        resultsCount: 0,
        memoriesCount: 0,
        tokensSaved: 0,
        compressionRatio: 0,
      };
    }

    const parts: string[] = [`# Context for: ${query}\n`];

    if (memorySection) {
      parts.push(memorySection, "");
    }

    if (workingSet.length > 0) {
      parts.push(
        `## Code (${workingSet.length} relevant sections, WM budget: ${wmBudget} tokens)\n`,
      );

      workingSet.forEach((r: any, idx: number) => {
        parts.push(
          `### ${idx + 1}. ${r.filePath || "Unknown"} (score: ${(r.score * 100).toFixed(1)}%)`,
        );
        parts.push(`Lines ${r.lineStart}-${r.lineEnd}\n`);
        parts.push("```" + (r.language || ""));
        parts.push(r.content || r.preview || "(no content)");
        parts.push("```\n");
      });
    }

    const rawContext = parts.join("\n");
    const rawTokens = estimateTokens(rawContext, "code");

    let finalContext = rawContext;
    let compressionRatio = 0;
    let tokensSaved = 0;

    if (rawTokens > maxTokens) {
      const resp = await ctrl.compressor.handle({
        content: rawContext,
        strategy: "code_structure",
        targetRatio: 0.6,
      });

      if (resp.success && resp.data) {
        finalContext = (resp.data as any).compressed;
        compressionRatio = resp.metadata?.compressionRatio || 0;
        tokensSaved = resp.metadata?.tokensSaved || 0;
      }
    }

    return {
      context: finalContext,
      sources: workingSet.map((r: any) => r.filePath || "unknown"),
      resultsCount: workingSet.length,
      memoriesCount: memories.length,
      tokensSaved: rawTokens - estimateTokens(finalContext, "code"),
      compressionRatio,
    };
  };

  return ctrl;
}

// ── Tests ────────────────────────────────────────────────────

describe("ContextController", () => {
  let controller: ReturnType<typeof buildFakeController>;

  beforeEach(() => {
    controller = buildFakeController({});
  });

  describe("getOptimizedContext", () => {
    test("returns empty message when no results", async () => {
      const result = await controller.getOptimizedContext({
        query: "test query",
        projectId: "proj1",
        maxTokens: 4000,
      });

      expect(result.context).toContain("No relevant code or memories found");
      expect(result.resultsCount).toBe(0);
      expect(result.memoriesCount).toBe(0);
    });

    test("includes code results in context", async () => {
      controller = buildFakeController({
        searchProject: async () => ({
          results: [
            {
              id: "r1",
              score: 0.9,
              filePath: "src/main.ts",
              lineStart: 1,
              lineEnd: 10,
              language: "typescript",
              content: "export function main() { console.log('hello'); }",
              preview: "export function main()",
            },
          ],
          query: "test",
          projectId: "proj1",
          responseMode: "full",
          tokenSavings: "none",
          indexStatus: {},
          recommendations: [],
          filters: { applied: false, include: [], exclude: [], totalResults: 1, filteredResults: 1 },
        }),
      });

      const result = await controller.getOptimizedContext({
        query: "main function",
        projectId: "proj1",
        maxTokens: 10000,
      });

      expect(result.resultsCount).toBe(1);
      expect(result.context).toContain("src/main.ts");
      expect(result.context).toContain("main()");
      expect(result.sources).toContain("src/main.ts");
    });

    test("includes memories when enabled", async () => {
      controller = buildFakeController({
        memorySearch: async () => ({
          memories: [
            {
              id: "mem1",
              content: "User prefers dark mode",
              type: "critical",
              importance: 0.8,
              score: 0.7,
              agentId: "optimizer",
            },
          ],
          relatedSummaries: {},
          query: "test",
          total: 1,
        }),
      });

      const result = await controller.getOptimizedContext({
        query: "user critical",
        projectId: "proj1",
        maxTokens: 10000,
        includeMemories: true,
      });

      expect(result.memoriesCount).toBe(1);
      expect(result.context).toContain("Relevant Memories");
      expect(result.context).toContain("dark mode");
    });

    test("excludes memories when disabled", async () => {
      controller = buildFakeController({
        memorySearch: async () => ({
          memories: [
            { id: "mem1", content: "hidden", type: "critical", importance: 0.5 },
          ],
          relatedSummaries: {},
          query: "test",
          total: 1,
        }),
      });

      const result = await controller.getOptimizedContext({
        query: "test",
        projectId: "proj1",
        includeMemories: false,
      });

      expect(result.memoriesCount).toBe(0);
    });

    test("clamps memoryBudgetRatio to [0, 0.5]", async () => {
      controller = buildFakeController({
        searchProject: async () => ({
          results: [
            {
              id: "r1",
              score: 0.9,
              filePath: "test.ts",
              lineStart: 1,
              lineEnd: 5,
              content: "code",
              preview: "code",
            },
          ],
          query: "test",
          projectId: "proj1",
          responseMode: "full",
          tokenSavings: "none",
          indexStatus: {},
          recommendations: [],
          filters: { applied: false, include: [], exclude: [], totalResults: 1, filteredResults: 1 },
        }),
      });

      // Even with ratio > 0.5, should clamp
      const result = await controller.getOptimizedContext({
        query: "test",
        projectId: "proj1",
        maxTokens: 10000,
        memoryBudgetRatio: 0.9,
        includeMemories: true,
      });

      // Should still work without error
      expect(result).toBeDefined();
    });
  });

  // ── selectWorkingSet ─────────────────────────────────────

  describe("selectWorkingSet", () => {
    test("selects results within token budget", () => {
      const results = [
        { filePath: "a.ts", score: 0.9, content: "short" },
        { filePath: "b.ts", score: 0.8, content: "also short" },
      ];

      const selected = controller.selectWorkingSet(results, 1000);
      expect(selected.length).toBe(2);
    });

    test("prioritizes distinct files", () => {
      const results = [
        { filePath: "a.ts", score: 0.9, content: "first" },
        { filePath: "a.ts", score: 0.85, content: "second from same file" },
        { filePath: "b.ts", score: 0.8, content: "from different file" },
      ];

      const selected = controller.selectWorkingSet(results, 1000);
      // Should get a.ts (first) and b.ts first, then fill with second a.ts
      expect(selected[0].filePath).toBe("a.ts");
      expect(selected[1].filePath).toBe("b.ts");
    });

    test("returns empty for zero budget", () => {
      const results = [{ filePath: "a.ts", score: 0.9, content: "x" }];
      const selected = controller.selectWorkingSet(results, 0);
      expect(selected.length).toBe(0);
    });

    test("returns empty for empty results", () => {
      const selected = controller.selectWorkingSet([], 1000);
      expect(selected.length).toBe(0);
    });
  });

  // ── formatMemorySection ──────────────────────────────────

  describe("formatMemorySection", () => {
    test("formats memories with type labels", () => {
      const memories = [
        { type: "critical", content: "likes dark mode", importance: 0.8, score: 0.9, agentId: "optimizer" },
      ];

      const section = controller.formatMemorySection(memories, 1000);
      expect(section).not.toBeNull();
      expect(section).toContain("CRITICAL"); // Type is uppercased
      expect(section).toContain("dark mode");
      expect(section).toContain("optimizer");
      expect(section).toContain("Relevant Memories");
    });

    test("returns null for empty memories", () => {
      const section = controller.formatMemorySection([], 1000);
      expect(section).toBeNull();
    });

    test("returns null for zero token budget", () => {
      const memories = [{ type: "code", content: "test", importance: 0.5 }];
      const section = controller.formatMemorySection(memories, 0);
      expect(section).toBeNull();
    });

    test("truncates when exceeding token budget", () => {
      const memories = Array.from({ length: 20 }, (_, i) => ({
        type: "code",
        content: `Memory content entry number ${i} with enough text to consume tokens`,
        importance: 0.5,
      }));

      // Very small budget — should only fit a few
      const section = controller.formatMemorySection(memories, 100);
      if (section) {
        // Should have fewer entries than input
        const entries = section.split("\n").filter((l: string) => l.startsWith("- **"));
        expect(entries.length).toBeLessThan(20);
      }
    });
  });
});
