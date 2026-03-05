#!/usr/bin/env bun
/**
 * Symbol Benchmark (symbol-benchmark.ts)
 *
 * Mede a qualidade e performance do Symbol Graph sobre o próprio projeto th0th.
 *
 * Métricas coletadas:
 *   - listDefinitions  : latência p50/p95, total de símbolos indexados
 *   - goToDefinition   : hit-rate e latência para fixtures conhecidas
 *   - getReferences    : recall e latência para fixtures conhecidas
 *   - centralityRank   : verifica que símbolos "hub" têm score > threshold
 *
 * Uso:
 *   bun packages/core/src/scripts/symbol-benchmark.ts [--projectPath <path>] [--projectId <id>] [--k <n>]
 *
 * Argumentos:
 *   --projectPath   Caminho absoluto do projeto a indexar (padrão: cwd)
 *   --projectId     ID do projeto no Symbol Graph (padrão: "th0th-bench")
 *   --k             Top-K para hit-rate (padrão: 3)
 *   --forceReindex  Limpar índice antes de indexar (padrão: false)
 *   --json          Saída em JSON puro (padrão: false, modo pretty)
 */

import fsSync from "fs";
import path from "path";
import dotenv from "dotenv";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CliOptions {
  projectPath: string;
  projectId: string;
  k: number;
  forceReindex: boolean;
  jsonOutput: boolean;
}

interface LatencyStats {
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  samples: number;
}

interface BenchmarkResult {
  projectPath: string;
  projectId: string;
  k: number;
  timestamp: string;
  indexing: {
    durationMs: number;
    symbolsIndexed: number;
    filesIndexed: number;
  };
  listDefinitions: {
    totalSymbols: number;
    latency: LatencyStats;
  };
  goToDefinition: {
    fixtures: number;
    hits: number;
    hitRate: number;
    latency: LatencyStats;
  };
  getReferences: {
    fixtures: number;
    withResults: number;
    recallRate: number;
    latency: LatencyStats;
  };
  centralityRank: {
    hubsChecked: number;
    hubsAboveThreshold: number;
    passRate: number;
    threshold: number;
    topSymbols: Array<{ name: string; score: number; file: string }>;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveEnvPath(startDir: string): string | null {
  let current = path.resolve(startDir);
  let firstFound: string | null = null;

  while (true) {
    const candidate = path.join(current, ".env");
    if (fsSync.existsSync(candidate)) {
      if (!firstFound) firstFound = candidate;
      const pkgJson = path.join(current, "package.json");
      if (fsSync.existsSync(pkgJson)) {
        try {
          const content = fsSync.readFileSync(pkgJson, "utf-8");
          if (content.includes('"workspaces"')) return candidate;
        } catch {
          // ignore
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return firstFound;
    current = parent;
  }
}

function loadEnvironment(): void {
  const explicit = process.env.DOTENV_CONFIG_PATH;
  const envPath = explicit || resolveEnvPath(process.cwd());
  if (!envPath) {
    console.warn("[symbol-bench] .env not found; using existing process environment");
    return;
  }
  const result = dotenv.config({ path: envPath, override: false });
  if (result.error) {
    console.warn(`[symbol-bench] failed to load .env at ${envPath}: ${result.error.message}`);
    return;
  }
  console.log(`[symbol-bench] loaded .env from ${envPath}`);
}

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key.slice(2), "true");
      continue;
    }
    args.set(key.slice(2), next);
    i += 1;
  }

  return {
    projectPath: path.resolve(args.get("projectPath") || process.cwd()),
    projectId: args.get("projectId") || "th0th-bench",
    k: Number(args.get("k") || "3"),
    forceReindex: args.get("forceReindex") === "true",
    jsonOutput: args.get("json") === "true",
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function latencyStats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.length === 0 ? 0 : samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    avgMs: Math.round(avg),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    samples: samples.length,
  };
}

function measure<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  return fn().then((result) => ({ result, ms: Math.round(performance.now() - start) }));
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Símbolos que devem existir no projeto th0th.
 * Se o benchmark for usado em outro projeto, apenas os que existirem serão contados.
 *
 * Cada fixture declara:
 *   - name       : nome do símbolo
 *   - kind       : tipo esperado (function/class/etc.) — opcional para validação
 *   - minRefs    : mínimo esperado de referências no projeto (0 = só testa latência)
 */
const DEFINITION_FIXTURES: Array<{ name: string; kind?: string; minRefs: number }> = [
  { name: "ContextualSearchRLM", kind: "class", minRefs: 2 },
  { name: "symbolGraphService", kind: "variable", minRefs: 1 },
  { name: "contextualSearch", kind: "variable", minRefs: 1 },
  { name: "workspaceManager", kind: "variable", minRefs: 1 },
  { name: "computePageRank", kind: "function", minRefs: 1 },
  { name: "SearchController", kind: "class", minRefs: 1 },
  { name: "ContextController", kind: "class", minRefs: 0 },
  { name: "IndexManager", kind: "class", minRefs: 1 },
  { name: "SearchCache", kind: "class", minRefs: 1 },
  { name: "smartChunk", kind: "function", minRefs: 1 },
];

/**
 * Símbolos "hub" esperados com centralidade alta.
 * São os símbolos com mais conexões no grafo de dependências.
 */
const HUB_SYMBOLS = [
  "ContextualSearchRLM",
  "symbolGraphService",
  "contextualSearch",
  "workspaceManager",
  "SearchController",
];

const CENTRALITY_THRESHOLD = 0.01; // score mínimo para ser considerado "hub"

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvironment();

  const { symbolGraphService } = await import(
    "../services/symbol/symbol-graph.service.js"
  );
  const { contextualSearch } = await import(
    "../services/search/contextual-search-rlm.js"
  );

  const opts = parseArgs(process.argv);

  if (!opts.jsonOutput) {
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║         th0th Symbol Graph Benchmark          ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log(`Project path : ${opts.projectPath}`);
    console.log(`Project ID   : ${opts.projectId}`);
    console.log(`Top-K        : ${opts.k}`);
    console.log(`Force reindex: ${opts.forceReindex}`);
    console.log("");
  }

  // ── 1. Indexing ────────────────────────────────────────────────────────────

  if (opts.forceReindex) {
    await contextualSearch.clearProjectIndex(opts.projectId);
    if (!opts.jsonOutput) console.log("[1/5] Cleared existing index.");
  }

  if (!opts.jsonOutput) console.log("[1/5] Indexing project (vector + keyword)...");
  const indexStart = performance.now();
  const indexStats = await contextualSearch.indexProject(opts.projectPath, opts.projectId);
  const indexMs = Math.round(performance.now() - indexStart);

  if (!opts.jsonOutput) {
    console.log(`      Done: ${indexStats.filesIndexed} files, ${indexStats.chunksIndexed} chunks in ${indexMs}ms`);
  }

  // ── 2. listDefinitions ─────────────────────────────────────────────────────

  if (!opts.jsonOutput) console.log("[2/5] Benchmarking listDefinitions...");

  const listLatencies: number[] = [];

  // Warm run (sem cache de símbolo)
  const { result: allDefs } = await measure(() =>
    symbolGraphService.listDefinitions(opts.projectId, { limit: 1000 })
  );

  // 5 medições para latência estável
  for (let i = 0; i < 5; i++) {
    const { ms } = await measure(() =>
      symbolGraphService.listDefinitions(opts.projectId, { limit: 100 })
    );
    listLatencies.push(ms);
  }

  if (!opts.jsonOutput) {
    console.log(`      Total symbols indexed: ${allDefs.length}`);
    console.log(`      Latency (5 runs): avg=${latencyStats(listLatencies).avgMs}ms, p95=${latencyStats(listLatencies).p95Ms}ms`);
  }

  // ── 3. goToDefinition hit-rate ─────────────────────────────────────────────

  if (!opts.jsonOutput) console.log("[3/5] Benchmarking goToDefinition hit-rate...");

  let gotoHits = 0;
  const gotoLatencies: number[] = [];

  for (const fixture of DEFINITION_FIXTURES) {
    const { result: defs, ms } = await measure(() =>
      symbolGraphService.goToDefinition(opts.projectId, fixture.name)
    );
    gotoLatencies.push(ms);

    const hit = defs.length > 0;
    if (hit) gotoHits++;

    if (!opts.jsonOutput) {
      const kindMatch =
        !fixture.kind || defs.some((d) => d.kind === fixture.kind);
      const status = hit ? (kindMatch ? "✓" : "⚠ wrong kind") : "✗";
      console.log(`      ${status} ${fixture.name} (${ms}ms, ${defs.length} result(s))`);
    }
  }

  const gotoHitRate = DEFINITION_FIXTURES.length === 0 ? 0 : gotoHits / DEFINITION_FIXTURES.length;

  // ── 4. getReferences recall ────────────────────────────────────────────────

  if (!opts.jsonOutput) console.log("[4/5] Benchmarking getReferences recall...");

  let refsWithResults = 0;
  const refLatencies: number[] = [];

  // Only test symbols that had a definition hit (otherwise refs are expected empty)
  const fixturesWithDef = DEFINITION_FIXTURES.filter((f) => f.minRefs > 0);

  for (const fixture of fixturesWithDef) {
    const { result: refs, ms } = await measure(() =>
      symbolGraphService.getReferences(opts.projectId, fixture.name)
    );
    refLatencies.push(ms);

    const hasEnoughRefs = refs.length >= fixture.minRefs;
    if (hasEnoughRefs) refsWithResults++;

    if (!opts.jsonOutput) {
      const status = hasEnoughRefs ? "✓" : "⚠";
      console.log(`      ${status} ${fixture.name}: ${refs.length} ref(s) (expected ≥${fixture.minRefs}, ${ms}ms)`);
    }
  }

  const recallRate = fixturesWithDef.length === 0 ? 1 : refsWithResults / fixturesWithDef.length;

  // ── 5. centralityRank ──────────────────────────────────────────────────────

  if (!opts.jsonOutput) console.log("[5/5] Checking centralityRank for hub symbols...");

  let hubsAboveThreshold = 0;
  const topByScore = [...allDefs]
    .filter((d) => d.centralityScore > 0)
    .sort((a, b) => b.centralityScore - a.centralityScore)
    .slice(0, 10);

  for (const hubName of HUB_SYMBOLS) {
    const match = allDefs.find((d) => d.name === hubName);
    if (!match) {
      if (!opts.jsonOutput) console.log(`      ✗ ${hubName}: not found in index`);
      continue;
    }
    const above = match.centralityScore >= CENTRALITY_THRESHOLD;
    if (above) hubsAboveThreshold++;
    if (!opts.jsonOutput) {
      const status = above ? "✓" : "⚠";
      console.log(`      ${status} ${hubName}: centralityScore=${match.centralityScore.toFixed(4)} (threshold=${CENTRALITY_THRESHOLD})`);
    }
  }

  const hubsChecked = Math.min(HUB_SYMBOLS.length, allDefs.length > 0 ? HUB_SYMBOLS.length : 0);
  const centralityPassRate = hubsChecked === 0 ? 0 : hubsAboveThreshold / hubsChecked;

  // ── Result ─────────────────────────────────────────────────────────────────

  const result: BenchmarkResult = {
    projectPath: opts.projectPath,
    projectId: opts.projectId,
    k: opts.k,
    timestamp: new Date().toISOString(),
    indexing: {
      durationMs: indexMs,
      symbolsIndexed: allDefs.length,
      filesIndexed: indexStats.filesIndexed,
    },
    listDefinitions: {
      totalSymbols: allDefs.length,
      latency: latencyStats(listLatencies),
    },
    goToDefinition: {
      fixtures: DEFINITION_FIXTURES.length,
      hits: gotoHits,
      hitRate: gotoHitRate,
      latency: latencyStats(gotoLatencies),
    },
    getReferences: {
      fixtures: fixturesWithDef.length,
      withResults: refsWithResults,
      recallRate,
      latency: latencyStats(refLatencies),
    },
    centralityRank: {
      hubsChecked,
      hubsAboveThreshold,
      passRate: centralityPassRate,
      threshold: CENTRALITY_THRESHOLD,
      topSymbols: topByScore.map((d) => ({
        name: d.name,
        score: d.centralityScore,
        file: d.file,
      })) satisfies Array<{ name: string; score: number; file: string }>,
    },
  };

  if (opts.jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n═══ SYMBOL BENCHMARK RESULT ═══════════════════════════════");
    console.log(`Symbols indexed      : ${result.indexing.symbolsIndexed}`);
    console.log(`Files indexed        : ${result.indexing.filesIndexed}`);
    console.log(`Index time           : ${result.indexing.durationMs}ms`);
    console.log(`listDefinitions avg  : ${result.listDefinitions.latency.avgMs}ms (p95: ${result.listDefinitions.latency.p95Ms}ms)`);
    console.log(`goToDefinition hits  : ${result.goToDefinition.hits}/${result.goToDefinition.fixtures} (${(gotoHitRate * 100).toFixed(1)}%)`);
    console.log(`goToDefinition avg   : ${result.goToDefinition.latency.avgMs}ms (p95: ${result.goToDefinition.latency.p95Ms}ms)`);
    console.log(`getReferences recall : ${result.getReferences.withResults}/${result.getReferences.fixtures} (${(recallRate * 100).toFixed(1)}%)`);
    console.log(`getReferences avg    : ${result.getReferences.latency.avgMs}ms (p95: ${result.getReferences.latency.p95Ms}ms)`);
    console.log(`Centrality pass rate : ${result.centralityRank.hubsAboveThreshold}/${result.centralityRank.hubsChecked} (${(centralityPassRate * 100).toFixed(1)}%)`);
    if (topByScore.length > 0) {
      console.log(`\nTop-5 by centrality:`);
      topByScore.slice(0, 5).forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.name} (${s.centralityScore.toFixed(4)}) — ${s.file}`);
      });
    }
    console.log("════════════════════════════════════════════════════════════\n");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[symbol-bench] Fatal error:", err);
  process.exit(1);
});
