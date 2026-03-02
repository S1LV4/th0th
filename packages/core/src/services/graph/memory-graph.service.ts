/**
 * Memory Graph Service
 *
 * Orchestration layer that coordinates graph operations triggered
 * by memory lifecycle events (store, search, delete).
 *
 * This service owns the composition of GraphStore, RelationExtractor,
 * and GraphQueries. Tools and other services interact with the graph
 * exclusively through this service, keeping them decoupled from
 * graph internals.
 */

import {
  MemoryRelationType,
  MemoryEdge,
  GraphQueryOptions,
  ContradictionPair,
  logger,
} from "@th0th/shared";
import { GraphStore } from "./graph-store.js";
import { RelationExtractor } from "./relation-extractor.js";
import { GraphQueries } from "./graph-queries.js";
import type { RelatedMemory, MemoryRow } from "./types.js";

// Re-export for consumers
export type { GraphQueryOptions, ContradictionPair, RelatedMemory, MemoryRow };

export class MemoryGraphService {
  private static instance: MemoryGraphService | null = null;

  private readonly store: GraphStore;
  private readonly extractor: RelationExtractor;
  private readonly queries: GraphQueries;

  private constructor() {
    this.store = GraphStore.getInstance();
    this.extractor = new RelationExtractor(this.store);
    this.queries = new GraphQueries(this.store);
  }

  static getInstance(): MemoryGraphService {
    if (!MemoryGraphService.instance) {
      MemoryGraphService.instance = new MemoryGraphService();
    }
    return MemoryGraphService.instance;
  }

  // ── Lifecycle hooks (called by tools) ──────────────────────

  /**
   * Called after a memory is successfully stored.
   * Creates explicit links and triggers background relation extraction.
   */
  async onMemoryStored(
    memoryId: string,
    linkTo: string[] = [],
  ): Promise<void> {
    try {
      // 1. Create explicit edges requested by the caller
      for (const targetId of linkTo) {
        this.store.createEdge(
          memoryId,
          targetId,
          MemoryRelationType.RELATES_TO,
          { weight: 0.8, evidence: "Explicit link by user/agent" },
        );
      }

      // 2. Extract automatic relations (non-blocking)
      const edgesCreated = await this.extractor.extractRelations(memoryId);

      if (edgesCreated > 0 || linkTo.length > 0) {
        logger.info("Graph updated after memory store", {
          memoryId,
          explicitLinks: linkTo.length,
          autoExtracted: edgesCreated,
        });
      }
    } catch (error) {
      // Graph operations are best-effort; never fail the store
      logger.warn("Graph update failed after memory store", {
        memoryId,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Called when a memory is deleted.
   * Cleans up all connected edges.
   */
  onMemoryDeleted(memoryId: string): void {
    try {
      const removed = this.store.deleteEdgesForMemory(memoryId);
      if (removed > 0) {
        logger.info("Graph edges cleaned after memory delete", {
          memoryId,
          edgesRemoved: removed,
        });
      }
    } catch (error) {
      logger.warn("Graph cleanup failed after memory delete", {
        memoryId,
        error: (error as Error).message,
      });
    }
  }

  // ── Query operations (called by tools and services) ────────

  /**
   * Get memories related to a given memory via graph traversal.
   */
  getRelatedContext(memoryId: string, options?: GraphQueryOptions) {
    return this.queries.getRelatedContext(memoryId, options);
  }

  /**
   * Find the shortest path between two memories.
   */
  findPath(fromId: string, toId: string, maxDepth?: number) {
    return this.queries.findPath(fromId, toId, maxDepth);
  }

  /**
   * Detect contradictions in the memory graph.
   */
  findContradictions(limit?: number): ContradictionPair[] {
    return this.queries.findContradictions(limit);
  }

  /**
   * Follow the decision chain leading to a memory.
   */
  getDecisionChain(memoryId: string, maxDepth?: number) {
    return this.queries.getDecisionChain(memoryId, maxDepth);
  }

  /**
   * Get hub memories (most connected nodes).
   */
  getHubMemories(limit?: number) {
    return this.queries.getHubMemories(limit);
  }

  /**
   * Get a human-readable summary of a memory's neighborhood.
   * Useful for injecting into LLM context alongside search results.
   */
  getNeighborhoodSummary(memoryId: string): string {
    return this.queries.getNeighborhoodSummary(memoryId);
  }

  // ── Direct edge operations ─────────────────────────────────

  /**
   * Create a manual edge between two memories.
   */
  linkMemories(
    sourceId: string,
    targetId: string,
    relationType: MemoryRelationType,
    options?: { weight?: number; evidence?: string },
  ): MemoryEdge | null {
    return this.store.createEdge(sourceId, targetId, relationType, {
      ...options,
      autoExtracted: false,
    });
  }

  /**
   * Remove an edge by ID.
   */
  unlinkMemories(edgeId: string): boolean {
    return this.store.deleteEdge(edgeId);
  }

  /**
   * Get all edges for a memory.
   */
  getEdges(memoryId: string) {
    return this.store.getAllEdges(memoryId);
  }

  // ── Analytics ──────────────────────────────────────────────

  /**
   * Get graph-level statistics.
   */
  getStats() {
    return this.store.getStats();
  }

  /**
   * Get degree centrality for a specific memory.
   */
  getDegree(memoryId: string) {
    return this.store.getDegree(memoryId);
  }
}
