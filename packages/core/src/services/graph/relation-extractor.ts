/**
 * Relation Extractor
 *
 * Extracts semantic relationships between memories using:
 * 1. Embedding similarity to find candidate pairs
 * 2. Heuristic rules to classify relation types
 *
 * Runs in background after each store_memory call.
 * Uses rule-based extraction (no LLM dependency) for speed,
 * with optional LLM refinement when available.
 */

import { Database } from "bun:sqlite";
import path from "path";
import {
  MemoryRelationType,
  MemoryType,
  ExtractedRelation,
  config,
  logger,
} from "@th0th-ai/shared";
import { EmbeddingService } from "../../data/chromadb/vector-store.js";
import { GraphStore } from "./graph-store.js";
import type { MemoryRowWithEmbedding as MemoryRow } from "./types.js";

interface ExtractionOptions {
  /** Max similar memories to compare against */
  candidateLimit?: number;
  /** Min similarity to consider a relation */
  similarityThreshold?: number;
  /** Min confidence to create an edge */
  confidenceThreshold?: number;
}

const DEFAULT_OPTIONS: Required<ExtractionOptions> = {
  candidateLimit: 5,
  similarityThreshold: 0.65,
  confidenceThreshold: 0.6,
};

// Keywords that indicate contradiction
const CONTRADICTION_SIGNALS = [
  "instead of",
  "no longer",
  "don't use",
  "deprecated",
  "replaced by",
  "wrong approach",
  "should not",
  "avoid",
  "changed from",
  "was incorrect",
  "não usar",
  "substituir",
  "evitar",
  "incorreto",
];

// Keywords that indicate resolution
const RESOLUTION_SIGNALS = [
  "fixed",
  "resolved",
  "solved",
  "workaround",
  "fix for",
  "solution",
  "corrected",
  "patched",
  "resolvido",
  "corrigido",
  "solução",
];

// Keywords that indicate derivation
const DERIVATION_SIGNALS = [
  "based on",
  "derived from",
  "building on",
  "extending",
  "following up",
  "as discussed",
  "per decision",
  "baseado em",
  "derivado de",
  "conforme",
];

// Keywords that indicate support
const SUPPORT_SIGNALS = [
  "confirms",
  "supports",
  "validates",
  "consistent with",
  "aligns with",
  "evidence for",
  "proves",
  "confirma",
  "valida",
  "consistente",
];

export class RelationExtractor {
  private db!: Database;
  private embeddingService: EmbeddingService;
  private graphStore: GraphStore;

  constructor(graphStore?: GraphStore) {
    this.embeddingService = new EmbeddingService();
    this.graphStore = graphStore ?? GraphStore.getInstance();
    this.initDb();
  }

  private initDb(): void {
    const dataDir = config.get("dataDir") as string;
    const dbPath = path.join(dataDir, "memories.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 3000");
  }

  /**
   * Extract relations for a newly stored memory.
   * Called in background after store_memory.
   *
   * Steps:
   * 1. Get embedding of new memory
   * 2. Find top-N similar existing memories
   * 3. For each candidate, classify the relation
   * 4. Create edges for high-confidence relations
   */
  async extractRelations(
    memoryId: string,
    options?: ExtractionOptions,
  ): Promise<number> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    let edgesCreated = 0;

    try {
      // Load the new memory
      const memory = this.loadMemory(memoryId);
      if (!memory) {
        logger.warn("RelationExtractor: memory not found", { memoryId });
        return 0;
      }

      // Get embedding
      const embedding = memory.embedding
        ? Array.from(new Float32Array(memory.embedding.buffer))
        : null;

      if (!embedding || embedding.every((v) => v === 0)) {
        logger.debug("RelationExtractor: no valid embedding", { memoryId });
        return 0;
      }

      // Find similar memories
      const candidates = this.findSimilarMemories(
        memoryId,
        embedding,
        memory.project_id,
        opts.candidateLimit,
        opts.similarityThreshold,
      );

      if (candidates.length === 0) {
        return 0;
      }

      // Classify relation for each candidate
      for (const candidate of candidates) {
        const relation = this.classifyRelation(memory, candidate);

        if (
          relation.relation !== "NONE" &&
          relation.confidence >= opts.confidenceThreshold
        ) {
          const edge = this.graphStore.createEdge(
            memoryId,
            candidate.id,
            relation.relation as MemoryRelationType,
            {
              weight: relation.confidence,
              evidence: relation.evidence,
              autoExtracted: true,
            },
          );

          if (edge) {
            edgesCreated++;
          }
        }
      }

      if (edgesCreated > 0) {
        logger.info("RelationExtractor: edges created", {
          memoryId,
          edgesCreated,
          candidatesEvaluated: candidates.length,
        });
      }
    } catch (error) {
      logger.warn("RelationExtractor: extraction failed", {
        memoryId,
        error: (error as Error).message,
      });
    }

    return edgesCreated;
  }

  /**
   * Find memories with similar embeddings (brute-force cosine similarity).
   */
  private findSimilarMemories(
    excludeId: string,
    queryEmbedding: number[],
    projectId: string | null,
    limit: number,
    threshold: number,
  ): (MemoryRow & { similarity: number })[] {
    // Fetch candidate memories (recent, same project if possible)
    const conditions: string[] = ["id != ?"];
    const params: any[] = [excludeId];

    if (projectId) {
      conditions.push("(project_id = ? OR project_id IS NULL)");
      params.push(projectId);
    }

    conditions.push("embedding IS NOT NULL");

    // Limit scan to recent memories for performance
    params.push(500);

    const rows = this.db
      .prepare(
        `
      SELECT id, content, type, level, importance, tags, embedding, created_at, project_id
      FROM memories
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(...params) as MemoryRow[];

    // Calculate cosine similarity
    const scored: (MemoryRow & { similarity: number })[] = [];

    for (const row of rows) {
      if (!row.embedding) continue;

      const candidateEmbedding = Array.from(
        new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        ),
      );

      if (candidateEmbedding.length !== queryEmbedding.length) continue;
      if (candidateEmbedding.every((v) => v === 0)) continue;

      const similarity = this.cosineSimilarity(
        queryEmbedding,
        candidateEmbedding,
      );

      if (similarity >= threshold) {
        scored.push({ ...row, similarity });
      }
    }

    // Sort by similarity descending
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }

  /**
   * Classify the relation between two memories using heuristic rules.
   *
   * Rules cascade by priority:
   * 1. SUPERSEDES: same type, high similarity, newer contradicts older
   * 2. CONTRADICTS: contradiction signals in newer content
   * 3. RESOLVES: resolution signals + related bug/decision
   * 4. DERIVED_FROM: derivation signals or same topic chain
   * 5. SUPPORTS: support signals or reinforcing pattern
   * 6. RELATES_TO: high similarity but no specific relation
   */
  classifyRelation(
    newMemory: MemoryRow,
    existingMemory: MemoryRow & { similarity: number },
  ): ExtractedRelation {
    const newContent = newMemory.content.toLowerCase();
    const existingContent = existingMemory.content.toLowerCase();
    const similarity = existingMemory.similarity;

    // ── Rule 1: SUPERSEDES ───────────────────────────────────
    // Same type, very high similarity, newer replaces older
    if (
      newMemory.type === existingMemory.type &&
      similarity >= 0.92 &&
      newMemory.created_at > existingMemory.created_at
    ) {
      return {
        relation: MemoryRelationType.SUPERSEDES,
        confidence: Math.min(0.95, similarity),
        evidence: `Very high similarity (${(similarity * 100).toFixed(0)}%) with same type; newer memory likely supersedes older`,
      };
    }

    // ── Rule 2: CONTRADICTS ──────────────────────────────────
    const contradictionMatch = CONTRADICTION_SIGNALS.find(
      (signal) =>
        newContent.includes(signal) &&
        (similarity >= 0.5 || this.sharesTags(newMemory, existingMemory)),
    );
    if (contradictionMatch) {
      return {
        relation: MemoryRelationType.CONTRADICTS,
        confidence: 0.7 + similarity * 0.2,
        evidence: `Contradiction signal "${contradictionMatch}" detected in new memory`,
      };
    }

    // ── Rule 3: RESOLVES ─────────────────────────────────────
    const resolutionMatch = RESOLUTION_SIGNALS.find(
      (signal) => newContent.includes(signal),
    );
    if (
      resolutionMatch &&
      (existingMemory.type === "decision" || existingMemory.type === "pattern")
    ) {
      return {
        relation: MemoryRelationType.RESOLVES,
        confidence: 0.65 + similarity * 0.25,
        evidence: `Resolution signal "${resolutionMatch}" found; existing memory is ${existingMemory.type}`,
      };
    }

    // ── Rule 4: DERIVED_FROM ─────────────────────────────────
    const derivationMatch = DERIVATION_SIGNALS.find(
      (signal) => newContent.includes(signal),
    );
    if (derivationMatch) {
      return {
        relation: MemoryRelationType.DERIVED_FROM,
        confidence: 0.6 + similarity * 0.3,
        evidence: `Derivation signal "${derivationMatch}" detected`,
      };
    }

    // Type-based derivation: code from decision, pattern from code
    if (
      (newMemory.type === "code" && existingMemory.type === "decision") ||
      (newMemory.type === "pattern" && existingMemory.type === "code")
    ) {
      if (similarity >= 0.7) {
        return {
          relation: MemoryRelationType.DERIVED_FROM,
          confidence: 0.55 + similarity * 0.3,
          evidence: `Type derivation chain: ${existingMemory.type} → ${newMemory.type}`,
        };
      }
    }

    // ── Rule 5: SUPPORTS ─────────────────────────────────────
    const supportMatch = SUPPORT_SIGNALS.find(
      (signal) => newContent.includes(signal),
    );
    if (supportMatch) {
      return {
        relation: MemoryRelationType.SUPPORTS,
        confidence: 0.6 + similarity * 0.3,
        evidence: `Support signal "${supportMatch}" detected`,
      };
    }

    // Same type, moderate-high similarity = implicit support
    if (
      newMemory.type === existingMemory.type &&
      similarity >= 0.8 &&
      (newMemory.type === "pattern" || newMemory.type === "decision")
    ) {
      return {
        relation: MemoryRelationType.SUPPORTS,
        confidence: 0.5 + similarity * 0.3,
        evidence: `Same type (${newMemory.type}) with high similarity suggests mutual support`,
      };
    }

    // ── Rule 6: RELATES_TO (fallback for high similarity) ────
    if (similarity >= 0.75) {
      return {
        relation: MemoryRelationType.RELATES_TO,
        confidence: similarity * 0.8,
        evidence: `High semantic similarity (${(similarity * 100).toFixed(0)}%) without specific relation pattern`,
      };
    }

    // No relation detected
    return {
      relation: "NONE",
      confidence: 0,
      evidence: "",
    };
  }

  // ── Helpers ────────────────────────────────────────────────

  private loadMemory(memoryId: string): MemoryRow | null {
    return this.db
      .prepare(
        `
      SELECT id, content, type, level, importance, tags, embedding, created_at, project_id
      FROM memories WHERE id = ?
    `,
      )
      .get(memoryId) as MemoryRow | null;
  }

  private sharesTags(a: MemoryRow, b: MemoryRow): boolean {
    try {
      const tagsA: string[] = a.tags ? JSON.parse(a.tags) : [];
      const tagsB: string[] = b.tags ? JSON.parse(b.tags) : [];
      return tagsA.some((t) => tagsB.includes(t));
    } catch {
      return false;
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Close database connection.
   */
  close(): void {
    this.db?.close();
  }
}
