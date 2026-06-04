#!/usr/bin/env bun
/**
 * Isolated embedding-quality eval harness for code retrieval.
 *
 * Unlike bench:beir (which runs the full th0th search pipeline), this measures
 * the RAW embedding model on a BEIR dataset: embed corpus + queries directly via
 * Ollama, brute-force cosine rank, compute Recall/MRR/nDCG@k. It exists to A/B
 * embedding-side levers fast — query instructions (asymmetric encoding), models,
 * and dimensions — without re-running indexing or the reranking layers.
 *
 * Corpus embeddings are cached to disk per model so iterating on query-side
 * variants is near-instant.
 *
 * Usage:
 *   bun scripts/embed-eval.ts --datasetDir benchmarks/datasets/cosqa-mini \
 *     --model qwen3-embedding:0.6b --k 10
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";

const OLLAMA = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const CACHE_DIR = path.join(os.tmpdir(), "th0th-embed-eval-cache");

interface Args {
  datasetDir: string;
  model: string;
  k: number;
  batch: number;
  noCache: boolean;
  docMode: string; // raw | filectx (mimic th0th smart-chunker addFileContext)
}

function parseArgs(argv: string[]): Args {
  const m = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) m.set(key.slice(2), "true");
    else { m.set(key.slice(2), next); i += 1; }
  }
  if (!m.get("datasetDir")) throw new Error("Missing --datasetDir");
  return {
    datasetDir: m.get("datasetDir")!,
    model: m.get("model") || "qwen3-embedding:0.6b",
    k: Number(m.get("k") || "10"),
    batch: Number(m.get("batch") || "16"),
    noCache: m.get("noCache") === "true",
    docMode: m.get("docMode") || "raw",
  };
}

async function readJsonl<T>(p: string): Promise<T[]> {
  const raw = await fs.readFile(p, "utf-8");
  return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as T);
}

async function readQrels(p: string): Promise<Map<string, Set<string>>> {
  const raw = await fs.readFile(p, "utf-8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const data = lines[0].toLowerCase().includes("query-id") ? lines.slice(1) : lines;
  const qrels = new Map<string, Set<string>>();
  for (const line of data) {
    const [qid, cid, scoreRaw] = line.split("\t");
    if (!qid || !cid) continue;
    if (Number(scoreRaw) <= 0) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Set());
    qrels.get(qid)!.add(cid);
  }
  return qrels;
}

/** L2-normalize in place so cosine == dot product. */
function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n;
  return out;
}

async function embedBatch(model: string, texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { embeddings?: number[][] };
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error(`Bad embedding response (${data.embeddings?.length} != ${texts.length})`);
  }
  return data.embeddings;
}

/** Embed many texts with batching + progress; returns normalized vectors aligned to input. */
async function embedAll(model: string, texts: string[], batch: number, label: string): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const vecs = await embedBatch(model, slice);
    for (const v of vecs) out.push(normalize(v));
    process.stdout.write(`\r  ${label}: ${Math.min(i + batch, texts.length)}/${texts.length}   `);
  }
  process.stdout.write("\n");
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

interface Metrics { recall: number; mrr: number; ndcg: number }

function evalRanking(
  queryVecs: Float32Array[],
  queryIds: string[],
  corpusVecs: Float32Array[],
  corpusIds: string[],
  qrels: Map<string, Set<string>>,
  k: number,
): Metrics {
  let recallSum = 0, mrrSum = 0, ndcgSum = 0, n = 0;
  for (let qi = 0; qi < queryVecs.length; qi += 1) {
    const rel = qrels.get(queryIds[qi]);
    if (!rel || rel.size === 0) continue;
    n += 1;

    // top-k by cosine (normalized dot)
    const scored: Array<{ id: string; s: number }> = new Array(corpusVecs.length);
    const qv = queryVecs[qi];
    for (let ci = 0; ci < corpusVecs.length; ci += 1) {
      scored[ci] = { id: corpusIds[ci], s: dot(qv, corpusVecs[ci]) };
    }
    scored.sort((a, b) => b.s - a.s);
    const topK = scored.slice(0, k);

    const hits = topK.filter((r) => rel.has(r.id)).length;
    recallSum += hits / rel.size;

    let mrr = 0;
    for (let i = 0; i < topK.length; i += 1) {
      if (rel.has(topK[i].id)) { mrr = 1 / (i + 1); break; }
    }
    mrrSum += mrr;

    let dcg = 0;
    for (let i = 0; i < topK.length; i += 1) if (rel.has(topK[i].id)) dcg += 1 / Math.log2(i + 2);
    let idcg = 0;
    for (let i = 0; i < Math.min(k, rel.size); i += 1) idcg += 1 / Math.log2(i + 2);
    ndcgSum += idcg === 0 ? 0 : dcg / idcg;
  }
  return { recall: recallSum / n, mrr: mrrSum / n, ndcg: ndcgSum / n };
}

/** Query-side encoding variants to A/B. Documents always go in raw (asymmetric). */
const QUERY_VARIANTS: Array<{ name: string; render: (q: string) => string }> = [
  { name: "raw (symmetric baseline)", render: (q) => q },
  {
    name: "qwen-instruct: web-search",
    render: (q) => `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:${q}`,
  },
  {
    name: "qwen-instruct: code-search",
    render: (q) => `Instruct: Given a natural-language question, retrieve the code snippet that answers it\nQuery:${q}`,
  },
  { name: "bge-style: query: prefix", render: (q) => `query: ${q}` },
];

async function loadCorpusVecs(model: string, docMode: string, corpusIds: string[], corpusTexts: string[], batch: number, noCache: boolean): Promise<Float32Array[]> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${model.replace(/[^a-z0-9]/gi, "_")}-corpus-${docMode}-${corpusIds.length}.bin`);
  const metaPath = cachePath + ".ids";
  if (!noCache && fsSync.existsSync(cachePath) && fsSync.existsSync(metaPath)) {
    const ids = (await fs.readFile(metaPath, "utf-8")).split("\n");
    if (ids.length === corpusIds.length && ids.every((id, i) => id === corpusIds[i])) {
      const buf = await fs.readFile(cachePath);
      const dims = buf.byteLength / 4 / corpusIds.length;
      const out: Float32Array[] = [];
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      for (let i = 0; i < corpusIds.length; i += 1) out.push(f32.subarray(i * dims, (i + 1) * dims));
      console.log(`  corpus: loaded ${corpusIds.length} cached vectors (${dims}D)`);
      return out;
    }
  }
  const vecs = await embedAll(model, corpusTexts, batch, "corpus");
  const dims = vecs[0].length;
  const flat = new Float32Array(vecs.length * dims);
  vecs.forEach((v, i) => flat.set(v, i * dims));
  await fs.writeFile(cachePath, Buffer.from(flat.buffer));
  await fs.writeFile(metaPath, corpusIds.join("\n"));
  return vecs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const dir = path.resolve(args.datasetDir);
  const corpus = await readJsonl<{ _id: string; title?: string; text: string }>(path.join(dir, "corpus.jsonl"));
  const queries = await readJsonl<{ _id: string; text: string }>(path.join(dir, "queries.jsonl"));
  const qrels = await readQrels(path.join(dir, "qrels", "test.tsv"));

  console.log(`embed-eval  model=${args.model}  k=${args.k}`);
  console.log(`  corpus=${corpus.length}  queries=${queries.length}  judged=${qrels.size}\n`);

  const corpusIds = corpus.map((c) => c._id);
  const renderDoc = (c: { _id: string; title?: string; text: string }) => {
    const body = c.title ? `${c.title}\n\n${c.text}` : c.text;
    // filectx mimics th0th smart-chunker addFileContext: prepend the (here opaque) file path.
    return args.docMode === "filectx"
      ? `// File: docs/${encodeURIComponent(c._id)}.md\n\n${body}`
      : body;
  };
  const corpusTexts = corpus.map(renderDoc);
  console.log(`  docMode=${args.docMode}`);
  const corpusVecs = await loadCorpusVecs(args.model, args.docMode, corpusIds, corpusTexts, args.batch, args.noCache);

  const queryIds = queries.map((q) => q._id);
  const results: Array<{ name: string } & Metrics> = [];
  for (const variant of QUERY_VARIANTS) {
    const qTexts = queries.map((q) => variant.render(q.text));
    const qVecs = await embedAll(args.model, qTexts, args.batch, `query[${variant.name}]`);
    const m = evalRanking(qVecs, queryIds, corpusVecs, corpusIds, qrels, args.k);
    results.push({ name: variant.name, ...m });
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`\n=== EMBED-EVAL RESULTS (model=${args.model}) ===`);
  console.log(`${pad("query encoding", 36)} ${pad(`Recall@${args.k}`, 11)} ${pad(`nDCG@${args.k}`, 10)} MRR@${args.k}`);
  for (const r of results) {
    console.log(`${pad(r.name, 36)} ${pad(r.recall.toFixed(4), 11)} ${pad(r.ndcg.toFixed(4), 10)} ${r.mrr.toFixed(4)}`);
  }
  const best = [...results].sort((a, b) => b.ndcg - a.ndcg)[0];
  console.log(`\nbest by nDCG: "${best.name}"  (nDCG=${best.ndcg.toFixed(4)})`);
}

main().catch((e) => { console.error("\nembed-eval failed:", e); process.exit(1); });
