/**
 * Memory Clustering
 *
 * Groups memories into semantic clusters using simplified K-means
 * over embedding vectors. Each cluster gets a human-readable label
 * derived from the most representative member keywords.
 *
 * Use-cases:
 * - Identify recurring themes across stored knowledge
 * - Compress old clusters into summaries
 * - Power "show me everything about topic X" queries
 *
 * Performance: Runs on demand or during consolidation. The scan is
 * bounded to `maxMemories` to keep wall-time reasonable.
 */

import { Database } from "bun:sqlite";
import path from "path";
import { config, logger } from "@th0th-ai/shared";
import type { MemoryRowWithEmbedding } from "../graph/types.js";

// ── Public types ─────────────────────────────────────────────

export interface MemoryCluster {
  id: string;
  centroid: number[];
  memberIds: string[];
  label: string;
  /** Average importance of members */
  importance: number;
  /** Total access count of members */
  totalAccess: number;
  /** Most common type in the cluster */
  dominantType: string;
}

export interface ClusteringResult {
  clusters: MemoryCluster[];
  unclustered: number;
  durationMs: number;
}

// ── Implementation ───────────────────────────────────────────

export class MemoryClustering {
  private db!: Database;
  private static instance: MemoryClustering | null = null;

  static getInstance(): MemoryClustering {
    if (!MemoryClustering.instance) {
      MemoryClustering.instance = new MemoryClustering();
    }
    return MemoryClustering.instance;
  }

  constructor() {
    this.initDb();
  }

  private initDb(): void {
    const dataDir = config.get("dataDir") as string;
    const dbPath = path.join(dataDir, "memories.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 3000");
  }

  // ── Core API ─────────────────────────────────────────────

  /**
   * Cluster memories using K-means.
   *
   * @param k          Number of clusters (auto-tuned if omitted)
   * @param maxIter    Max K-means iterations
   * @param maxMemories Max memories to consider (most recent)
   */
  clusterMemories(
    k?: number,
    maxIter: number = 20,
    maxMemories: number = 500,
  ): ClusteringResult {
    const start = Date.now();

    // Load memories with valid embeddings
    const rows = this.db
      .prepare(
        `
        SELECT id, content, type, level, importance, tags,
               embedding, created_at, updated_at, access_count,
               user_id, session_id, project_id, agent_id
        FROM memories
        WHERE embedding IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(maxMemories) as MemoryRowWithEmbedding[];

    const items: { row: MemoryRowWithEmbedding; vec: number[] }[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const buf =
        row.embedding instanceof Buffer
          ? row.embedding
          : Buffer.from(row.embedding);
      const vec = Array.from(
        new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
      );
      if (vec.every((v) => v === 0)) continue;
      items.push({ row, vec });
    }

    if (items.length < 3) {
      return { clusters: [], unclustered: items.length, durationMs: Date.now() - start };
    }

    // Auto-tune k: sqrt(n/2) is a common heuristic
    const effectiveK = k ?? Math.max(2, Math.min(20, Math.round(Math.sqrt(items.length / 2))));
    const dim = items[0].vec.length;

    // ── K-means ────────────────────────────────────────────
    // 1. Initialize centroids with K-means++ (first = random, rest = weighted distance)
    let centroids = this.kMeansPlusPlusInit(items.map((i) => i.vec), effectiveK);

    let assignments = new Int32Array(items.length);

    for (let iter = 0; iter < maxIter; iter++) {
      // Assign each item to nearest centroid
      const newAssignments = new Int32Array(items.length);
      for (let i = 0; i < items.length; i++) {
        let bestDist = Infinity;
        let bestCluster = 0;
        for (let c = 0; c < centroids.length; c++) {
          const dist = this.euclideanDistanceSq(items[i].vec, centroids[c]);
          if (dist < bestDist) {
            bestDist = dist;
            bestCluster = c;
          }
        }
        newAssignments[i] = bestCluster;
      }

      // Check convergence
      let changed = false;
      for (let i = 0; i < items.length; i++) {
        if (newAssignments[i] !== assignments[i]) {
          changed = true;
          break;
        }
      }
      assignments = newAssignments;
      if (!changed) break;

      // Recompute centroids
      const newCentroids: number[][] = [];
      const counts: number[] = [];
      for (let c = 0; c < centroids.length; c++) {
        newCentroids.push(new Array(dim).fill(0));
        counts.push(0);
      }
      for (let i = 0; i < items.length; i++) {
        const c = assignments[i];
        counts[c]++;
        for (let d = 0; d < dim; d++) {
          newCentroids[c][d] += items[i].vec[d];
        }
      }
      for (let c = 0; c < centroids.length; c++) {
        if (counts[c] === 0) continue;
        for (let d = 0; d < dim; d++) {
          newCentroids[c][d] /= counts[c];
        }
      }
      centroids = newCentroids;
    }

    // ── Build cluster objects ──────────────────────────────
    const clusterMap = new Map<number, MemoryRowWithEmbedding[]>();
    for (let i = 0; i < items.length; i++) {
      const c = assignments[i];
      if (!clusterMap.has(c)) clusterMap.set(c, []);
      clusterMap.get(c)!.push(items[i].row);
    }

    const clusters: MemoryCluster[] = [];
    let unclustered = 0;

    for (const [cIdx, members] of clusterMap) {
      // Skip singleton clusters — these are "unclustered"
      if (members.length < 2) {
        unclustered += members.length;
        continue;
      }

      const label = this.generateLabel(members);
      const avgImportance =
        members.reduce((sum, m) => sum + m.importance, 0) / members.length;
      const totalAccess = members.reduce(
        (sum, m) => sum + m.access_count,
        0,
      );
      const dominantType = this.getDominantType(members);

      clusters.push({
        id: `cluster_${Date.now()}_${cIdx}`,
        centroid: centroids[cIdx],
        memberIds: members.map((m) => m.id),
        label,
        importance: Math.round(avgImportance * 100) / 100,
        totalAccess,
        dominantType,
      });
    }

    // Sort by importance descending
    clusters.sort((a, b) => b.importance - a.importance);

    logger.info("MemoryClustering: complete", {
      inputMemories: items.length,
      clusters: clusters.length,
      unclustered,
      k: effectiveK,
    });

    return { clusters, unclustered, durationMs: Date.now() - start };
  }

  /**
   * Find which cluster a memory belongs to.
   * Re-runs clustering if needed (lightweight for small sets).
   */
  findCluster(memoryId: string, cached?: ClusteringResult): MemoryCluster | null {
    const result = cached ?? this.clusterMemories();
    for (const cluster of result.clusters) {
      if (cluster.memberIds.includes(memoryId)) {
        return cluster;
      }
    }
    return null;
  }

  /**
   * Generate a short summary of a cluster from member content.
   * Uses keyword extraction (no LLM dependency).
   */
  summarizeCluster(cluster: MemoryCluster): string {
    const members = this.db
      .prepare(
        `
        SELECT content, type, importance
        FROM memories
        WHERE id IN (${cluster.memberIds.map(() => "?").join(",")})
        ORDER BY importance DESC
        LIMIT 5
      `,
      )
      .all(...cluster.memberIds) as Array<{
      content: string;
      type: string;
      importance: number;
    }>;

    if (members.length === 0) return cluster.label;

    // Take the most important memory's first sentence as the summary lead
    const lead = members[0].content.split(/[.!?\n]/)[0].trim();
    const typeCount = members.length;
    const types = [...new Set(members.map((m) => m.type))].join(", ");

    return `[${cluster.label}] ${lead} (${typeCount} memories, types: ${types})`;
  }

  // ── K-means++ initialization ────────────────────────────

  private kMeansPlusPlusInit(vectors: number[][], k: number): number[][] {
    const centroids: number[][] = [];

    // First centroid: random
    const firstIdx = Math.floor(Math.random() * vectors.length);
    centroids.push([...vectors[firstIdx]]);

    // Remaining centroids: weighted by distance to nearest existing centroid
    for (let c = 1; c < k; c++) {
      const distances: number[] = [];
      let totalDist = 0;

      for (const vec of vectors) {
        let minDist = Infinity;
        for (const centroid of centroids) {
          const d = this.euclideanDistanceSq(vec, centroid);
          if (d < minDist) minDist = d;
        }
        distances.push(minDist);
        totalDist += minDist;
      }

      // Weighted random selection
      if (totalDist === 0) {
        // All points are on existing centroids; pick random
        centroids.push([...vectors[Math.floor(Math.random() * vectors.length)]]);
        continue;
      }

      let r = Math.random() * totalDist;
      for (let i = 0; i < distances.length; i++) {
        r -= distances[i];
        if (r <= 0) {
          centroids.push([...vectors[i]]);
          break;
        }
      }

      // Safety: if floating-point imprecision prevented selection
      if (centroids.length <= c) {
        centroids.push([...vectors[vectors.length - 1]]);
      }
    }

    return centroids;
  }

  // ── Label generation ────────────────────────────────────

  /**
   * Generate a human-readable label from cluster members.
   * Extracts the most frequent significant words across member content.
   */
  private generateLabel(members: MemoryRowWithEmbedding[]): string {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "shall", "can", "need", "dare", "ought",
      "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
      "as", "into", "through", "during", "before", "after", "above", "below",
      "between", "out", "off", "over", "under", "again", "further", "then",
      "once", "here", "there", "when", "where", "why", "how", "all", "both",
      "each", "few", "more", "most", "other", "some", "such", "no", "nor",
      "not", "only", "own", "same", "so", "than", "too", "very", "just",
      "don", "should", "now", "and", "but", "or", "if", "while", "that",
      "this", "it", "its", "what", "which", "who", "whom", "these", "those",
      "i", "me", "my", "myself", "we", "our", "ours", "you", "your",
      "he", "him", "his", "she", "her", "they", "them", "their",
      // Portuguese stop words
      "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
      "um", "uma", "uns", "umas", "para", "com", "por", "que", "se",
      "como", "mas", "ou", "quando", "mais", "também", "já", "ainda",
      "sobre", "entre", "até", "sem", "sob", "esse", "essa", "este",
      "esta", "aquele", "aquela", "ele", "ela", "eles", "elas", "nós",
      "eu", "tu", "você", "vocês", "meu", "minha", "seu", "sua",
    ]);

    const wordFreq = new Map<string, number>();

    for (const member of members) {
      const words = member.content
        .toLowerCase()
        .replace(/[^a-záàâãéèêíïóôõúüç\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stopWords.has(w));

      const seen = new Set<string>();
      for (const word of words) {
        if (seen.has(word)) continue;
        seen.add(word);
        wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
      }
    }

    // Top 3 most frequent words across documents
    const sorted = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([word]) => word);

    return sorted.length > 0 ? sorted.join(", ") : "misc";
  }

  private getDominantType(members: MemoryRowWithEmbedding[]): string {
    const typeCounts = new Map<string, number>();
    for (const m of members) {
      typeCounts.set(m.type, (typeCounts.get(m.type) ?? 0) + 1);
    }
    let dominant = "unknown";
    let maxCount = 0;
    for (const [type, count] of typeCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominant = type;
      }
    }
    return dominant;
  }

  // ── Math helpers ────────────────────────────────────────

  private euclideanDistanceSq(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return sum;
  }

  close(): void {
    this.db?.close();
    MemoryClustering.instance = null;
  }
}
