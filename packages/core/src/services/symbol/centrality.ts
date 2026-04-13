/**
 * PageRank-based Centrality for Symbol Graph
 *
 * Computes an importance score for each file in a project based on
 * the import dependency graph. Files that are imported by many others
 * receive higher scores (core utilities, services, types).
 *
 * Used for:
 *   - Prioritizing file processing order in ETL (most central first)
 *   - Boosting search result ranking
 *   - Surfacing the most relevant files in go_to_definition ambiguity
 */

const DAMPING = 0.85;
const ITERATIONS = 20;
const MIN_SCORE = 1e-6;

/**
 * Compute simplified PageRank over the file import graph.
 *
 * @param nodes - All file paths in the project
 * @param edges - Directed [from, to] import edges (from imports to)
 * @returns Map of file_path → normalized score (0–1)
 */
export function computePageRank(
  nodes: string[],
  edges: Array<{ from_file: string; to_file: string }>,
): Map<string, number> {
  if (nodes.length === 0) return new Map();

  const N = nodes.length;
  const nodeIndex = new Map(nodes.map((n, i) => [n, i]));

  // Adjacency: inLinks[i] = list of node indices that link INTO i
  const inLinks: number[][] = Array.from({ length: N }, () => []);
  // Out-degree: how many links go OUT from node i
  const outDegree: number[] = new Array(N).fill(0);

  for (const { from_file, to_file } of edges) {
    const from = nodeIndex.get(from_file);
    const to = nodeIndex.get(to_file);
    if (from === undefined || to === undefined) continue;
    if (from === to) continue; // skip self-loops
    inLinks[to].push(from);
    outDegree[from]++;
  }

  // Initialize uniform scores
  let scores = new Array(N).fill(1 / N);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const newScores = new Array(N).fill((1 - DAMPING) / N);

    for (let i = 0; i < N; i++) {
      let rank = 0;
      for (const j of inLinks[i]) {
        rank += scores[j] / (outDegree[j] || 1);
      }
      newScores[i] += DAMPING * rank;
    }

    // Convergence check
    let delta = 0;
    for (let i = 0; i < N; i++) {
      delta += Math.abs(newScores[i] - scores[i]);
    }
    scores = newScores;
    if (delta < MIN_SCORE) break;
  }

  // Normalize to [0, 1]
  const max = Math.max(...scores);
  const result = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    result.set(nodes[i], max > 0 ? scores[i] / max : 0);
  }

  return result;
}
