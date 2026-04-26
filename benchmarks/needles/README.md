# th0th Needles Benchmark

Needle-in-haystack harness for measuring th0th's semantic search recall against
real codebases.

## Layout

```
benchmarks/needles/
├── scorer.ts            # CLI: reads dataset + harness output, writes report
├── fixtures/            # Per-project needle datasets (versioned)
│   └── sicad.json       # 12 needles validated against the Sicad codebase
└── reports/             # Harness outputs and generated reports (gitignored)
```

## Pipeline

```
fixtures/<project>.json ──┐
                          ├─▶ [E] harness                ─▶ reports/<project>-results.json
                          │   (Claude calls th0th_search per needle)
                          │                                       │
                          │                                       ▼
                          └────────────────────────▶ [T] scorer.ts ─▶ <project>.md + <project>.evaluations.json
```

- **E (Extract)** — the harness iterates over `fixtures/<project>.json` and,
  for each needle, calls
  `mcp__th0th__th0th_search(query, projectId=<project>, maxResults=10)`.
  Raw responses are accumulated into `reports/<project>-results.json` in the
  format documented at the top of `scorer.ts`.
- **T (Transform/Load)** — `scorer.ts` computes `hit@1/3/5/10`, `MRR`, and
  per-category / per-difficulty breakdowns. A "hit" requires the chunk's
  `filePath` to match the needle's expected file AND the chunk's
  `[lineStart, lineEnd]` to intersect the expected range within
  `lineTolerance` (default 5).

## Adding a new project

1. Put a fixture at `fixtures/<projectId>.json` following the same shape as
   `sicad.json` (see "Schema" below).
2. Make sure the project is indexed by th0th (`mcp__th0th__th0th_index` with
   `projectPath` and `projectId` matching the fixture).
3. Run the harness (today: a Claude Code session that loops the queries).
4. Score:
   ```sh
   bun benchmarks/needles/scorer.ts \
     --dataset benchmarks/needles/fixtures/<projectId>.json \
     --results benchmarks/needles/reports/<projectId>-results.json
   ```
   The scorer writes `<projectId>.md` and `<projectId>.evaluations.json`
   alongside the results file (override with `--out <prefix>`).

## Why needle-in-haystack?

Each fixture is curated to **penalise keyword search** so it actually exercises
semantic recall. The Sicad fixture covers seven hard categories:

| Category | What it tests |
|---|---|
| `domain-concept-without-keyword` | Historical/legal rules expressed only as arithmetic |
| `cross-language-stack` | Translation chains: enum → string → BACEN code |
| `business-rule-in-utility` | Business rules disguised as generic validators |
| `dynamic-property-access` | `obj[key]`, `'foo' in obj`, `as any` — invisible to indexers |
| `string-literal-config-magic` | Magic numbers that encode case-law thresholds |
| `portuguese-domain-concept` | Intent only clear via PT-BR comments (13º salário, pro-rata) |
| `cross-file-event-coupling` | Fire-and-forget promises with no static coupling |

## Schema

`fixtures/<projectId>.json`:

```jsonc
{
  "projectId": "sicad",
  "version": "1.0.0",
  "description": "...",
  "scoring": {
    "topK": 10,
    "hitAtK": [1, 3, 5, 10],
    "lineTolerance": 5,
    "notes": "A hit requires filePath equality AND [lineStart, lineEnd] intersection (with ±lineTolerance on each side)."
  },
  "needles": [
    {
      "id": "N01-...",
      "category": "domain-concept-without-keyword",
      "difficulty": "hard",
      "query": "...",
      "expected": { "filePath": "...", "lineStart": 71, "lineEnd": 93 },
      "rationale": "..."
    }
  ]
}
```

`reports/<projectId>-results.json`:

```jsonc
{
  "projectId": "sicad",
  "ranAt": "2026-04-20T00:00:00Z",
  "results": [
    {
      "needleId": "N01-...",
      "query": "...",
      "hits": [
        { "filePath": "...", "lineStart": 1, "lineEnd": 17, "score": 0.84 }
      ]
    }
  ]
}
```
