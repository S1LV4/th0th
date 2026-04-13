/**
 * Memory Service
 *
 * Pure domain logic for the memory subsystem.
 * Owns ID generation, level determination, scoring/ranking algorithms,
 * and embedding coordination. No DB calls — those live in MemoryRepository.
 */

import { MemoryType, MemoryLevel } from "@th0th-ai/shared";
import { EmbeddingService } from "../../data/chromadb/vector-store.js";
import type { MemoryRow } from "../../data/memory/memory-repository.js";

// ── Public types ─────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  level: MemoryLevel;
  userId: string | null;
  sessionId: string | null;
  projectId: string | null;
  agentId: string | null;
  importance: number;
  tags: string[];
  createdAt: number;
  accessCount: number;
  lastAccessed: number | null;
  score?: number;
  embedding?: any;
}

export interface ScoredMemory extends Memory {
  score: number;
}

// ── Service ──────────────────────────────────────────────────

export class MemoryService {
  private static instance: MemoryService | null = null;
  private embeddingService: EmbeddingService;

  private constructor() {
    this.embeddingService = new EmbeddingService();
  }

  static getInstance(): MemoryService {
    if (!MemoryService.instance) {
      MemoryService.instance = new MemoryService();
    }
    return MemoryService.instance;
  }

  // ── Embedding ──────────────────────────────────────────────

  async generateEmbedding(text: string): Promise<number[]> {
    return this.embeddingService.embed(text);
  }

  // ── ID Generation ──────────────────────────────────────────

  generateId(type: MemoryType, userId?: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const prefix = type.substring(0, 3);
    const userPart = userId ? `_${userId.substring(0, 4)}` : "";
    return `${prefix}_${timestamp}_${random}${userPart}`;
  }

  // ── Level Determination ────────────────────────────────────

  /**
   * Determine the memory level (L0–L4) using agent hierarchy rules.
   */
  determineLevel(
    type: MemoryType,
    opts: {
      userId?: string;
      sessionId?: string;
      projectId?: string;
      agentId?: string;
    },
  ): MemoryLevel {
    const { userId, sessionId, projectId, agentId } = opts;

    // Agent hierarchy overrides
    if (agentId === "orchestrator" && (type === "decision" || type === "critical")) {
      return MemoryLevel.PERSISTENT; // L0
    }
    if (agentId === "architect" && (type === "pattern" || type === "code" || type === "critical")) {
      return MemoryLevel.PROJECT; // L1
    }
    if (agentId === "optimizer" && type === "critical") {
      return MemoryLevel.USER; // L2
    }

    // Scope-based defaults
    if (projectId) return MemoryLevel.PROJECT;
    if (userId && !sessionId) return MemoryLevel.USER;
    if (sessionId) return MemoryLevel.SESSION;

    // Type-based defaults
    switch (type) {
      case "critical":
        return MemoryLevel.USER;
      case "conversation":
        return MemoryLevel.SESSION;
      case "code":
      case "pattern":
        return MemoryLevel.PROJECT;
      case "decision":
        return MemoryLevel.PERSISTENT;
      default:
        return MemoryLevel.SESSION;
    }
  }

  // ── Row → Domain Object ────────────────────────────────────

  rowToMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      content: row.content,
      type: row.type as MemoryType,
      level: row.level as MemoryLevel,
      userId: row.user_id,
      sessionId: row.session_id,
      projectId: row.project_id,
      agentId: row.agent_id,
      importance: row.importance,
      tags: row.tags ? JSON.parse(row.tags) : [],
      createdAt: row.created_at,
      accessCount: row.access_count || 0,
      lastAccessed: row.last_accessed || null,
      embedding: row.embedding,
    };
  }

  // ── Scoring / Ranking ──────────────────────────────────────

  /**
   * Rank memories by semantic similarity + temporal + access + type priors.
   * Stability–plasticity balance:
   *   semantic 65%, temporal 20%, access 10%, type 5%
   */
  semanticRank(
    memories: Memory[],
    queryEmbedding: number[],
    limit: number,
  ): ScoredMemory[] {
    const scored = memories.map((memory) => {
      const embeddingBuffer = (memory as any).embedding;
      const embedding = embeddingBuffer
        ? Array.from(new Float32Array(embeddingBuffer.buffer))
        : null;

      const isValid = embedding && embedding.some((v) => v !== 0);
      const canCalc =
        isValid && embedding!.length === queryEmbedding.length;

      const semanticScore = canCalc
        ? this.cosineSimilarity(queryEmbedding, embedding!)
        : 0.5;

      const temporalScore = this.temporalScore(memory);
      const accessBoost = this.accessBoost(memory.accessCount || 0);
      const typeBoost = this.typeBoost(memory.type);

      const score =
        semanticScore * 0.65 +
        temporalScore * 0.2 +
        accessBoost * 0.1 +
        typeBoost * 0.05;

      return { ...memory, score } as ScoredMemory;
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ── Private helpers ────────────────────────────────────────

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Ebbinghaus-inspired forgetting curve. Half-life ~72 h.
   */
  private temporalScore(memory: Memory): number {
    const now = Date.now();
    const reference = memory.lastAccessed || memory.createdAt;
    const ageHours = Math.max(0, (now - reference) / (1000 * 60 * 60));
    const decay = Math.pow(0.5, ageHours / 72);
    return Math.max(0.1, Math.min(1, decay));
  }

  /**
   * Log-curve access reinforcement with saturation.
   */
  private accessBoost(accessCount: number): number {
    const normalized =
      Math.log1p(Math.max(0, accessCount)) / Math.log(20);
    return Math.max(0.1, Math.min(1, normalized));
  }

  /**
   * Small priors for reusable memory types.
   */
  private typeBoost(type: MemoryType): number {
    switch (type) {
      case MemoryType.DECISION:
        return 1.0;
      case MemoryType.PATTERN:
        return 0.9;
      case MemoryType.CRITICAL:
        return 0.85;
      case MemoryType.CODE:
        return 0.8;
      case MemoryType.CONVERSATION:
      default:
        return 0.7;
    }
  }
}
