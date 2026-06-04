#!/usr/bin/env bun
/**
 * Fetch a CoIR (CoIR-Retrieval) code-retrieval dataset and emit it in the
 * BEIR layout consumed by `bench:beir` (packages/core/src/scripts/beir-benchmark.ts):
 *
 *   <out>/corpus.jsonl      {"_id","title","text"}
 *   <out>/queries.jsonl     {"_id","text"}
 *   <out>/qrels/test.tsv    query-id\tcorpus-id\trelevance
 *
 * Uses the HuggingFace dataset-viewer REST API (JSON, no python/parquet deps).
 * CoIR splits each dataset into "<name>-queries-corpus" (splits: corpus, queries)
 * and "<name>-qrels" (splits: train/test/valid).
 *
 * For a fast first baseline the corpus is subsampled to: every relevant doc for
 * the selected queries + up to `--distractors` random non-relevant docs. This
 * keeps the qrels valid while shrinking how many docs get embedded/indexed.
 *
 * Usage:
 *   bun scripts/fetch-coir-dataset.ts \
 *     --dataset cosqa --split test \
 *     --out benchmarks/datasets/cosqa \
 *     --maxQueries 200 --distractors 1500
 */
import fs from "fs/promises";
import path from "path";

const API = "https://datasets-server.huggingface.co/rows";
const PAGE = 100; // dataset-viewer hard limit per request

interface Args {
  dataset: string;
  split: string;
  out: string;
  maxQueries: number; // 0 = all
  distractors: number; // 0 = none (relevant-only corpus)
  config: string;
}

function parseArgs(argv: string[]): Args {
  const m = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) {
      m.set(k.slice(2), "true");
    } else {
      m.set(k.slice(2), v);
      i += 1;
    }
  }
  const dataset = m.get("dataset");
  if (!dataset) throw new Error("Missing required --dataset (e.g. cosqa)");
  return {
    dataset,
    split: m.get("split") || "test",
    out: m.get("out") || `benchmarks/datasets/${dataset}`,
    maxQueries: Number(m.get("maxQueries") || "0"),
    distractors: Number(m.get("distractors") || "1500"),
    config: m.get("config") || "default",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch one page with light retry/backoff (dataset-viewer occasionally 5xx). */
async function fetchPage(
  dataset: string,
  config: string,
  split: string,
  offset: number,
): Promise<{ rows: Array<{ row: Record<string, any> }>; total: number }> {
  const url = `${API}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${PAGE}`;
  let lastErr = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = (await res.json()) as { rows: any[]; num_rows_total: number };
        return { rows: json.rows || [], total: json.num_rows_total ?? 0 };
      }
      lastErr = `HTTP ${res.status}`;
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        await sleep(Math.max(retryAfter * 1000, 2000 * (attempt + 1)));
        continue;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await sleep(700 * (attempt + 1));
  }
  throw new Error(`Failed to fetch ${split}@${offset}: ${lastErr}`);
}

/** Stream every row of a split, invoking `onRow` until it returns false (stop). */
async function streamSplit(
  dataset: string,
  config: string,
  split: string,
  onRow: (row: Record<string, any>) => boolean,
): Promise<void> {
  const first = await fetchPage(dataset, config, split, 0);
  const total = first.total;
  let offset = 0;
  let page = first;
  while (true) {
    for (const r of page.rows) {
      if (!onRow(r.row)) return;
    }
    offset += PAGE;
    if (offset >= total) break;
    process.stdout.write(`\r  ${split}: ${Math.min(offset, total)}/${total}   `);
    page = await fetchPage(dataset, config, split, offset);
    await sleep(40); // be polite to the public API
  }
  process.stdout.write(`\r  ${split}: ${total}/${total}   \n`);
}

/** Parse the numeric suffix of an id like "q20105" / "d42" → 20105 / 42, or null. */
function numericId(id: string): number | null {
  const m = id.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Stream a bounded offset window [start, end) of a split. CoIR dumps are row-ordered
 * by numeric _id, so targeting the window of needed ids avoids scanning the whole
 * split (and the rate limits that come with it).
 */
async function streamRange(
  dataset: string,
  config: string,
  split: string,
  start: number,
  end: number,
  onRow: (row: Record<string, any>) => boolean,
): Promise<void> {
  let offset = Math.max(0, Math.floor(start / PAGE) * PAGE);
  while (offset < end) {
    const page = await fetchPage(dataset, config, split, offset);
    for (const r of page.rows) {
      if (!onRow(r.row)) return;
    }
    offset += PAGE;
    process.stdout.write(`\r  ${split}: ${Math.min(offset, end)}/${end}   `);
    if (offset >= (page.total || end)) break;
    await sleep(40);
  }
  process.stdout.write("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const qcDataset = `CoIR-Retrieval/${args.dataset}-queries-corpus`;
  const qrelsDataset = `CoIR-Retrieval/${args.dataset}-qrels`;
  const outDir = path.resolve(args.out);
  const qrelsDir = path.join(outDir, "qrels");
  await fs.mkdir(qrelsDir, { recursive: true });

  console.log(`CoIR → BEIR fetch`);
  console.log(`  queries-corpus: ${qcDataset}`);
  console.log(`  qrels:          ${qrelsDataset} (split=${args.split})`);
  console.log(`  out:            ${outDir}`);
  console.log(`  maxQueries=${args.maxQueries || "all"}  distractors=${args.distractors}\n`);

  // 1) qrels: build query -> [{corpusId, score}], capped to maxQueries.
  console.log("[1/4] qrels");
  const qrels = new Map<string, Array<{ corpusId: string; score: number }>>();
  const relevantCorpusIds = new Set<string>();
  await streamSplit(qrelsDataset, args.config, args.split, (row) => {
    const qid = String(row.query_id);
    const cid = String(row.corpus_id);
    const score = Number(row.score ?? 1);
    if (score <= 0) return true;
    if (!qrels.has(qid)) {
      if (args.maxQueries && qrels.size >= args.maxQueries) return false; // enough queries — stop scan
      qrels.set(qid, []);
    }
    qrels.get(qid)!.push({ corpusId: cid, score });
    relevantCorpusIds.add(cid);
    return true;
  });
  const queryIds = new Set(qrels.keys());
  console.log(`  queries=${queryIds.size}  relevant docs=${relevantCorpusIds.size}`);

  // 2) queries: keep text for selected query ids (offset-targeted by numeric id).
  console.log("[2/4] queries");
  const queryText = new Map<string, string>();
  const collectQuery = (row: Record<string, any>) => {
    const id = String(row._id);
    if (queryIds.has(id)) queryText.set(id, String(row.text ?? ""));
    return queryText.size < queryIds.size; // stop once all found
  };
  const qNums = [...queryIds].map((id) => numericId(id));
  if (qNums.every((n) => n !== null)) {
    const nums = qNums as number[];
    await streamRange(qcDataset, args.config, "queries", Math.min(...nums), Math.max(...nums) + 1, collectQuery);
  } else {
    await streamSplit(qcDataset, args.config, "queries", collectQuery);
  }
  if (queryText.size < queryIds.size) {
    await streamSplit(qcDataset, args.config, "queries", collectQuery); // fallback: ordering assumption failed
  }
  console.log(`  resolved query texts=${queryText.size}/${queryIds.size}`);

  // 3) corpus: all relevant docs (offset-targeted) + up to `distractors` from the head.
  console.log("[3/4] corpus");
  const corpus = new Map<string, { title: string; text: string }>();
  const setDoc = (row: Record<string, any>) =>
    corpus.set(String(row._id), { title: String(row.title ?? ""), text: String(row.text ?? "") });

  // 3a) relevant docs
  let relevantRemaining = relevantCorpusIds.size;
  const collectRelevant = (row: Record<string, any>) => {
    const id = String(row._id);
    if (relevantCorpusIds.has(id) && !corpus.has(id)) {
      setDoc(row);
      relevantRemaining -= 1;
    }
    return relevantRemaining > 0;
  };
  const rNums = [...relevantCorpusIds].map((id) => numericId(id));
  if (rNums.every((n) => n !== null)) {
    const nums = rNums as number[];
    await streamRange(qcDataset, args.config, "corpus", Math.min(...nums), Math.max(...nums) + 1, collectRelevant);
  } else {
    await streamSplit(qcDataset, args.config, "corpus", collectRelevant);
  }
  if (relevantRemaining > 0) {
    await streamSplit(qcDataset, args.config, "corpus", collectRelevant); // fallback
  }

  // 3b) distractors: first non-relevant docs from the head of the corpus
  let distractorsKept = 0;
  if (args.distractors > 0) {
    await streamRange(qcDataset, args.config, "corpus", 0, args.distractors + 500, (row) => {
      const id = String(row._id);
      if (!relevantCorpusIds.has(id) && !corpus.has(id)) {
        setDoc(row);
        distractorsKept += 1;
      }
      return distractorsKept < args.distractors;
    });
  }
  const relevantFound = [...relevantCorpusIds].filter((id) => corpus.has(id)).length;
  console.log(`  corpus docs=${corpus.size} (relevant=${relevantFound}/${relevantCorpusIds.size}, distractors=${distractorsKept})`);

  // 4) write BEIR files (only queries whose relevant docs survived).
  console.log("[4/4] writing BEIR files");
  const corpusOut: string[] = [];
  for (const [id, { title, text }] of corpus) {
    corpusOut.push(JSON.stringify({ _id: id, title, text }));
  }

  const queriesOut: string[] = [];
  const qrelsOut: string[] = ["query-id\tcorpus-id\trelevance"];
  let evaluable = 0;
  for (const [qid, rels] of qrels) {
    const present = rels.filter((r) => corpus.has(r.corpusId));
    const text = queryText.get(qid);
    if (!text || present.length === 0) continue;
    queriesOut.push(JSON.stringify({ _id: qid, text }));
    for (const r of present) qrelsOut.push(`${qid}\t${r.corpusId}\t${r.score}`);
    evaluable += 1;
  }

  await fs.writeFile(path.join(outDir, "corpus.jsonl"), corpusOut.join("\n") + "\n");
  await fs.writeFile(path.join(outDir, "queries.jsonl"), queriesOut.join("\n") + "\n");
  await fs.writeFile(path.join(qrelsDir, "test.tsv"), qrelsOut.join("\n") + "\n");

  console.log(`\n✓ Wrote BEIR dataset to ${outDir}`);
  console.log(`  corpus.jsonl   ${corpusOut.length} docs`);
  console.log(`  queries.jsonl  ${queriesOut.length} queries`);
  console.log(`  qrels/test.tsv ${qrelsOut.length - 1} judgements (${evaluable} evaluable queries)`);
}

main().catch((e) => {
  console.error("\nfetch-coir-dataset failed:", e);
  process.exit(1);
});
