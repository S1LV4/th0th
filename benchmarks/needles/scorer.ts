#!/usr/bin/env bun
/**
 * Needle-in-haystack scorer for th0th semantic search.
 *
 * Reads a dataset (needles + expected hits) and a results file (raw search
 * output from a harness), then writes a Markdown report and an evaluations
 * JSON.
 *
 * Usage:
 *   bun benchmarks/needles/scorer.ts \
 *     --dataset benchmarks/needles/fixtures/sicad.json \
 *     --results benchmarks/needles/reports/sicad-2026-04-20.json \
 *     --out     benchmarks/needles/reports/sicad-2026-04-20
 *
 * Defaults (when run from repo root with no args):
 *   --dataset = benchmarks/needles/fixtures/<projectId>.json
 *   --results = benchmarks/needles/reports/<projectId>-results.json
 *   --out     = benchmarks/needles/reports/<projectId>
 *
 * The harness (typically Claude Code calling mcp__th0th__th0th_search) is
 * responsible for producing the results file in this format:
 *   {
 *     "projectId": "sicad",
 *     "ranAt": "ISO-8601",
 *     "results": [
 *       { "needleId": "...", "query": "...", "hits": [{ "filePath": "...", "lineStart": 1, "lineEnd": 17, "score": 0.84 }, ...] }
 *     ]
 *   }
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

interface NeedleExpected {
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

interface Needle {
  id: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  query: string;
  expected: NeedleExpected;
  rationale: string;
}

interface Dataset {
  projectId: string;
  version: string;
  description: string;
  scoring: { topK: number; hitAtK: number[]; lineTolerance: number; notes: string };
  needles: Needle[];
}

interface Hit {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  score: number;
}

interface RawResult {
  needleId: string;
  query: string;
  hits: Hit[];
  latencyMs?: number;
}

interface ResultsFile {
  projectId: string;
  ranAt: string;
  results: RawResult[];
}

interface Evaluation {
  needleId: string;
  category: string;
  difficulty: string;
  query: string;
  expected: NeedleExpected;
  rank: number | null;
  topHit: Hit | null;
  matchedHit: Hit | null;
  reciprocalRank: number;
}

function intersects(a: [number, number], b: [number, number], tol: number): boolean {
  const aStart = a[0] - tol;
  const aEnd = a[1] + tol;
  return !(aEnd < b[0] || aStart > b[1]);
}

function findRank(needle: Needle, hits: Hit[], tol: number): { rank: number | null; hit: Hit | null } {
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (
      h.filePath === needle.expected.filePath &&
      intersects([h.lineStart, h.lineEnd], [needle.expected.lineStart, needle.expected.lineEnd], tol)
    ) {
      return { rank: i + 1, hit: h };
    }
  }
  return { rank: null, hit: null };
}

function evaluate(dataset: Dataset, results: ResultsFile): { evaluations: Evaluation[]; summary: any } {
  const tol = dataset.scoring.lineTolerance;
  const byId = new Map(results.results.map((r) => [r.needleId, r]));

  const evaluations: Evaluation[] = dataset.needles.map((needle) => {
    const raw = byId.get(needle.id);
    const hits = raw?.hits ?? [];
    const { rank, hit } = findRank(needle, hits, tol);
    return {
      needleId: needle.id,
      category: needle.category,
      difficulty: needle.difficulty,
      query: needle.query,
      expected: needle.expected,
      rank,
      topHit: hits[0] ?? null,
      matchedHit: hit,
      reciprocalRank: rank ? 1 / rank : 0,
    };
  });

  const total = evaluations.length;
  const hitAtK = Object.fromEntries(
    dataset.scoring.hitAtK.map((k) => [
      `hit@${k}`,
      evaluations.filter((e) => e.rank !== null && e.rank <= k).length / total,
    ]),
  );
  const mrr = evaluations.reduce((s, e) => s + e.reciprocalRank, 0) / total;

  const byCategory: Record<string, { n: number; hits: number; mrr: number }> = {};
  const byDifficulty: Record<string, { n: number; hits: number; mrr: number }> = {};
  for (const e of evaluations) {
    for (const [bucket, key] of [
      [byCategory, e.category],
      [byDifficulty, e.difficulty],
    ] as const) {
      const k = key as string;
      bucket[k] ??= { n: 0, hits: 0, mrr: 0 };
      bucket[k].n += 1;
      bucket[k].hits += e.rank !== null && e.rank <= 5 ? 1 : 0;
      bucket[k].mrr += e.reciprocalRank;
    }
  }
  for (const bucket of [byCategory, byDifficulty]) {
    for (const k of Object.keys(bucket)) {
      bucket[k].mrr = +(bucket[k].mrr / bucket[k].n).toFixed(3);
    }
  }

  return {
    evaluations,
    summary: {
      total,
      ...hitAtK,
      mrr: +mrr.toFixed(3),
      byCategory,
      byDifficulty,
    },
  };
}

function renderMarkdown(
  dataset: Dataset,
  results: ResultsFile,
  evaluations: Evaluation[],
  summary: any,
): string {
  const lines: string[] = [];
  lines.push(`# th0th Needles Benchmark Report — ${dataset.projectId}`);
  lines.push("");
  lines.push(`- Ran at: \`${results.ranAt}\``);
  lines.push(`- Dataset version: \`${dataset.version}\``);
  lines.push(`- Needles: **${summary.total}**`);
  lines.push("");
  lines.push("## Global metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  for (const k of dataset.scoring.hitAtK) {
    lines.push(`| hit@${k} | ${(summary[`hit@${k}`] * 100).toFixed(1)}% |`);
  }
  lines.push(`| MRR | ${summary.mrr} |`);
  lines.push("");
  lines.push("## By category");
  lines.push("");
  lines.push("| Category | N | hit@5 | MRR |");
  lines.push("|---|---:|---:|---:|");
  for (const [cat, v] of Object.entries<any>(summary.byCategory)) {
    lines.push(`| ${cat} | ${v.n} | ${((v.hits / v.n) * 100).toFixed(0)}% | ${v.mrr} |`);
  }
  lines.push("");
  lines.push("## By difficulty");
  lines.push("");
  lines.push("| Difficulty | N | hit@5 | MRR |");
  lines.push("|---|---:|---:|---:|");
  for (const [d, v] of Object.entries<any>(summary.byDifficulty)) {
    lines.push(`| ${d} | ${v.n} | ${((v.hits / v.n) * 100).toFixed(0)}% | ${v.mrr} |`);
  }
  lines.push("");
  lines.push("## Per-needle breakdown");
  lines.push("");
  lines.push("| # | ID | Diff | Rank | Top hit | Expected |");
  lines.push("|---|---|---|---:|---|---|");
  evaluations.forEach((e, i) => {
    const rank = e.rank ?? "—";
    const top = e.topHit ? `${e.topHit.filePath}:${e.topHit.lineStart}-${e.topHit.lineEnd}` : "—";
    const exp = `${e.expected.filePath}:${e.expected.lineStart}-${e.expected.lineEnd}`;
    lines.push(`| ${i + 1} | ${e.needleId} | ${e.difficulty} | ${rank} | \`${top}\` | \`${exp}\` |`);
  });
  lines.push("");
  lines.push("## Misses (rank > 5 or not found)");
  lines.push("");
  const misses = evaluations.filter((e) => e.rank === null || e.rank > 5);
  if (misses.length === 0) {
    lines.push("_None_ ");
  } else {
    for (const m of misses) {
      lines.push(`### ${m.needleId} (${m.difficulty}, ${m.category})`);
      lines.push(`- **Query:** ${m.query}`);
      lines.push(`- **Expected:** \`${m.expected.filePath}:${m.expected.lineStart}-${m.expected.lineEnd}\``);
      lines.push(
        `- **Top hit:** ${m.topHit ? `\`${m.topHit.filePath}:${m.topHit.lineStart}-${m.topHit.lineEnd}\` (score ${m.topHit.score.toFixed(3)})` : "no hits"}`,
      );
      lines.push("");
    }
  }
  return lines.join("\n");
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dataset || !args.results) {
    console.error("Usage: scorer.ts --dataset <path> --results <path> [--out <path-prefix>]");
    console.error("  --dataset   path to needles fixture (e.g. fixtures/sicad.json)");
    console.error("  --results   path to harness output (e.g. reports/sicad-results.json)");
    console.error("  --out       output path prefix; writes <prefix>.md and <prefix>.evaluations.json");
    console.error("              defaults to <results>-without-extension");
    process.exit(1);
  }

  const datasetPath = resolve(args.dataset);
  const resultsPath = resolve(args.results);
  const outPrefix = resolve(
    args.out ?? resultsPath.replace(/\.json$/, "").replace(/-results$/, ""),
  );

  const dataset: Dataset = JSON.parse(readFileSync(datasetPath, "utf8"));
  const results: ResultsFile = JSON.parse(readFileSync(resultsPath, "utf8"));
  const { evaluations, summary } = evaluate(dataset, results);

  mkdirSync(dirname(outPrefix), { recursive: true });
  const reportPath = `${outPrefix}.md`;
  const evalPath = `${outPrefix}.evaluations.json`;
  writeFileSync(evalPath, JSON.stringify({ summary, evaluations }, null, 2));
  writeFileSync(reportPath, renderMarkdown(dataset, results, evaluations, summary));
  console.log(`Report:      ${reportPath}`);
  console.log(`Evaluations: ${evalPath}`);
  console.log(`Summary:`, summary);
}

if (import.meta.main) main();
