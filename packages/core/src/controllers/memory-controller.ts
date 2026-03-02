/**
 * Memory Controller
 *
 * Orchestration layer for memory operations.
 * Composes MemoryRepository, MemoryService, MemoryGraphService,
 * and the consolidation job.
 *
 * Tools (store_memory, search_memories) delegate here.
 * This is the single entry point for all memory use cases.
 */

import { logger, MemoryType, MemoryLevel } from "@th0th/shared";
import { MemoryRepository } from "../data/memory/memory-repository.js";
import {
  MemoryService,
  type Memory,
  type ScoredMemory,
} from "../services/memory/memory-service.js";
import { MemoryGraphService } from "../services/graph/memory-graph.service.js";
import { memoryConsolidationJob } from "../services/jobs/memory-consolidation-job.js";

// ── Input / Output types ─────────────────────────────────────

export interface StoreMemoryInput {
  content: string;
  type: MemoryType;
  userId?: string;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  importance?: number;
  tags?: string[];
  linkTo?: string[];
}

export interface StoreMemoryResult {
  memoryId: string;
  stored: "local";
  level: MemoryLevel;
  type: MemoryType;
}

export interface SearchMemoryInput {
  query: string;
  userId?: string;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  types?: MemoryType[];
  minImportance?: number;
  limit?: number;
  includePersistent?: boolean;
  includeRelated?: boolean;
}

export interface SearchMemoryResult {
  memories: ScoredMemory[];
  relatedSummaries: Record<string, string>;
  query: string;
  total: number;
}

// ── Controller ───────────────────────────────────────────────

export class MemoryController {
  private static instance: MemoryController | null = null;

  private readonly repo: MemoryRepository;
  private readonly service: MemoryService;
  private readonly graph: MemoryGraphService;

  private constructor() {
    this.repo = MemoryRepository.getInstance();
    this.service = MemoryService.getInstance();
    this.graph = MemoryGraphService.getInstance();
  }

  static getInstance(): MemoryController {
    if (!MemoryController.instance) {
      MemoryController.instance = new MemoryController();
    }
    return MemoryController.instance;
  }

  // ── Store ──────────────────────────────────────────────────

  async store(input: StoreMemoryInput): Promise<StoreMemoryResult> {
    const {
      content,
      type,
      userId,
      sessionId,
      projectId,
      agentId,
      importance = 0.5,
      tags = [],
      linkTo = [],
    } = input;

    // 1. Domain logic: generate ID and determine level
    const id = this.service.generateId(type, userId);
    const level = this.service.determineLevel(type, {
      userId,
      sessionId,
      projectId,
      agentId,
    });

    // 2. Generate embedding (async)
    const embedding = await this.service.generateEmbedding(content);

    // 3. Persist via repository
    this.repo.insert({
      id,
      content,
      type,
      level,
      userId,
      sessionId,
      projectId,
      agentId,
      importance,
      tags,
      embedding,
      metadata: { type, importance, agentId },
    });

    logger.info("Memory stored", {
      id,
      type,
      level,
      importance,
      hasUserId: !!userId,
      hasSessionId: !!sessionId,
      hasProjectId: !!projectId,
      agentId: agentId || "unknown",
    });

    // 4. Background side-effects (non-blocking)
    memoryConsolidationJob.maybeRun("store");
    void this.graph.onMemoryStored(id, linkTo);

    return { memoryId: id, stored: "local", level, type };
  }

  // ── Search ─────────────────────────────────────────────────

  async search(input: SearchMemoryInput): Promise<SearchMemoryResult> {
    const {
      query,
      userId,
      sessionId,
      projectId,
      agentId,
      types,
      minImportance = 0.3,
      limit = 10,
      includePersistent = true,
      includeRelated = false,
    } = input;

    logger.info("Searching memories", {
      query: query.slice(0, 50),
      hasUserId: !!userId,
      hasSessionId: !!sessionId,
      hasProjectId: !!projectId,
      agentId: agentId || "any",
      limit,
    });

    // 1. Generate query embedding
    const queryEmbedding = await this.service.generateEmbedding(query);

    // 2. FTS pre-filter via repository
    const ftsRows = this.repo.fullTextSearch(query, {
      userId,
      sessionId,
      projectId,
      agentId,
      types,
      minImportance,
      includePersistent,
      limit: limit * 3,
    });

    logger.info("FTS search completed", {
      foundResults: ftsRows.length,
      query: query.slice(0, 30),
    });

    // 3. Map to domain objects
    const memories = ftsRows.map((row) => this.service.rowToMemory(row));

    // 4. Semantic ranking
    const hasValidEmbedding = queryEmbedding.some((v) => v !== 0);
    const rankedResults = hasValidEmbedding
      ? this.service.semanticRank(memories, queryEmbedding, limit)
      : memories
          .slice(0, limit)
          .map((m) => ({ ...m, score: 1.0 }) as ScoredMemory);

    logger.info("Ranking completed", {
      resultsCount: rankedResults.length,
      usedSemanticRanking: hasValidEmbedding,
      firstScore: rankedResults[0]?.score,
    });

    // 5. Update access counts
    this.repo.updateAccessCounts(rankedResults.map((r) => r.id));

    // 6. Background consolidation (non-blocking)
    memoryConsolidationJob.maybeRun("search");

    // 7. Graph enrichment
    let relatedSummaries: Record<string, string> = {};
    if (includeRelated && rankedResults.length > 0) {
      try {
        for (const mem of rankedResults.slice(0, 3)) {
          const summary = this.graph.getNeighborhoodSummary(mem.id);
          if (summary) {
            relatedSummaries[mem.id] = summary;
          }
        }
      } catch (err) {
        logger.warn("Graph enrichment failed", {
          error: (err as Error).message,
        });
      }
    }

    logger.info("Memories found", {
      total: rankedResults.length,
      topScore: rankedResults[0]?.score || 0,
    });

    return {
      memories: rankedResults,
      relatedSummaries,
      query,
      total: rankedResults.length,
    };
  }
}
