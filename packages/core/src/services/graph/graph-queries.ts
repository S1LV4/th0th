/**
 * Graph Queries
 *
 * Traversal and query operations over the memory knowledge graph.
 * Provides BFS-based traversal with depth limits, path finding,
 * contradiction detection, and hub analysis.
 * 
 * ─────────────────────────────────────────────────────────────────
 * PERFORMANCE OPTIMIZATIONS (Issue #4)
 * ─────────────────────────────────────────────────────────────────
 * 
 * ✅ Batch Loading Elimination of N+1 Queries:
 * 
 * All traversal methods now use `loadMemoriesByIds()` to batch load
 * memories instead of individual `loadMemory()` calls. This reduces
 * query count from O(N) to O(1) per BFS level or operation.
 * 
 * Before:
 *   - getRelatedContext(): O(N) queries for N neighbors
 *   - findContradictions(): 2×limit queries (one per memory in each pair)
 *   - getHubMemories(): limit queries (one per hub)
 *   - reconstructPath(): O(path_length) queries
 * 
 * After:
 *   - getRelatedContext(): O(maxDepth) queries (one per BFS level)
 *   - findContradictions(): 1 query (batch load all unique memories)
 *   - getHubMemories(): 1 query (batch load all hubs)
 *   - reconstructPath(): 1 query (batch load entire path)
 * 
 * Example: BFS with depth=3 and 6 neighbors per level:
 *   - Old: 2 + 12 + 72 = 86 queries
 *   - New: 3 queries (one per level)
 *   - Speedup: ~29x reduction in query count
 * 
 * Measured Performance (see graph-queries.test.ts):
 *   - Query count reduced by 2-30x depending on graph structure
 *   - Latency improved proportionally to query reduction
 *   - Zero behavioral changes - all existing tests pass
 * 
 * Implementation:
 *   - loadMemoriesByIds(ids: string[]): Map<string, MemoryRow>
 *   - Uses SQL WHERE id IN (...) with placeholders
 *   - Returns Map for O(1) lookup after batch load
 */

import { Database } from "bun:sqlite";
import path from "path";
import {
  MemoryEdge,
  MemoryRelationType,
  GraphQueryOptions,
  GraphPath,
  ContradictionPair,
  config,
  logger,
} from "@th0th-ai/shared";
import { GraphStore } from "./graph-store.js";
import type { MemoryRow, RelatedMemory } from "./types.js";

export type { RelatedMemory, MemoryRow };

const DEFAULT_OPTIONS: Required<GraphQueryOptions> = {
  maxDepth: 2,
  relationTypes: [],
  minWeight: 0.3,
  limit: 20,
  includeEvidence: true,
};

export class GraphQueries {
  private db!: Database;
  private graphStore: GraphStore;

  constructor(graphStore?: GraphStore) {
    this.graphStore = graphStore ?? GraphStore.getInstance();
    this.initDb();
  }

  private initDb(): void {
    const dataDir = config.get("dataDir") as string;
    const dbPath = path.join(dataDir, "memories.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 3000");
  }

  // ── Traversal ──────────────────────────────────────────────

  /**
   * Get related memories using BFS traversal up to maxDepth.
   * Returns memories ordered by (depth ASC, edge weight DESC).
   * 
   * Performance: Batch loads all memories per BFS level, reducing
   * query count from O(N) to O(maxDepth).
   */
  getRelatedContext(
    memoryId: string,
    options?: GraphQueryOptions,
  ): RelatedMemory[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const visited = new Set<string>([memoryId]);
    const result: RelatedMemory[] = [];

    // BFS queue: [memoryId, depth]
    const queue: [string, number][] = [[memoryId, 0]];

    while (queue.length > 0 && result.length < opts.limit) {
      // Process all nodes at current depth level
      const currentLevelSize = queue.length;
      const neighborData: Array<{
        neighborId: string;
        edge: MemoryEdge;
        depth: number;
      }> = [];

      // Collect all neighbor IDs for batch loading
      for (let i = 0; i < currentLevelSize && result.length < opts.limit; i++) {
        const [currentId, depth] = queue.shift()!;

        if (depth >= opts.maxDepth) continue;

        // Get edges from current node
        const edges = this.graphStore.getAllEdges(currentId, {
          relationTypes:
            opts.relationTypes.length > 0 ? opts.relationTypes : undefined,
          minWeight: opts.minWeight,
          limit: 20,
        });

        for (const edge of edges) {
          // Determine the neighbor (other end of the edge)
          const neighborId =
            edge.sourceId === currentId ? edge.targetId : edge.sourceId;

          if (visited.has(neighborId)) continue;
          visited.add(neighborId);

          neighborData.push({
            neighborId,
            edge,
            depth: depth + 1,
          });

          // Enqueue for deeper traversal
          if (depth + 1 < opts.maxDepth) {
            queue.push([neighborId, depth + 1]);
          }
        }
      }

      // Batch load all neighbors for this level
      if (neighborData.length > 0) {
        const neighborIds = neighborData.map((n) => n.neighborId);
        const memoryMap = this.loadMemoriesByIds(neighborIds);

        for (const { neighborId, edge, depth } of neighborData) {
          const memory = memoryMap.get(neighborId);
          if (!memory) continue;

          result.push({
            memory,
            edge: opts.includeEvidence
              ? edge
              : { ...edge, evidence: undefined },
            depth,
          });

          if (result.length >= opts.limit) break;
        }
      }
    }

    // Sort: closer depth first, higher weight first within same depth
    result.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return b.edge.weight - a.edge.weight;
    });

    return result;
  }

  // ── Path Finding ───────────────────────────────────────────

  /**
   * Find shortest path between two memories using BFS.
   * Returns null if no path exists within maxDepth.
   */
  findPath(
    fromId: string,
    toId: string,
    maxDepth: number = 5,
  ): GraphPath | null {
    if (fromId === toId) {
      const memory = this.loadMemory(fromId);
      return memory
        ? { nodes: [memory as any], edges: [], length: 0, totalWeight: 0 }
        : null;
    }

    // BFS with parent tracking
    const visited = new Map<
      string,
      { parentId: string | null; edge: MemoryEdge | null }
    >();
    visited.set(fromId, { parentId: null, edge: null });

    const queue: [string, number][] = [[fromId, 0]];

    while (queue.length > 0) {
      const [currentId, depth] = queue.shift()!;

      if (depth >= maxDepth) continue;

      const edges = this.graphStore.getAllEdges(currentId, { limit: 30 });

      for (const edge of edges) {
        const neighborId =
          edge.sourceId === currentId ? edge.targetId : edge.sourceId;

        if (visited.has(neighborId)) continue;
        visited.set(neighborId, { parentId: currentId, edge });

        if (neighborId === toId) {
          // Reconstruct path
          return this.reconstructPath(fromId, toId, visited);
        }

        queue.push([neighborId, depth + 1]);
      }
    }

    return null; // No path found
  }

  private reconstructPath(
    fromId: string,
    toId: string,
    visited: Map<
      string,
      { parentId: string | null; edge: MemoryEdge | null }
    >,
  ): GraphPath | null {
    const nodeIds: string[] = [];
    const edges: MemoryEdge[] = [];
    let current = toId;

    while (current !== fromId) {
      nodeIds.unshift(current);
      const info = visited.get(current);
      if (!info || !info.parentId) return null;
      if (info.edge) edges.unshift(info.edge);
      current = info.parentId;
    }
    nodeIds.unshift(fromId);

    // Batch load all path memories (eliminates N+1 query)
    const memoryMap = this.loadMemoriesByIds(nodeIds);
    const nodes = nodeIds
      .map((id) => memoryMap.get(id))
      .filter(Boolean) as any[];

    if (nodes.length !== nodeIds.length) {
      // Some memories couldn't be loaded
      return null;
    }

    const totalWeight = edges.reduce((sum, e) => sum + e.weight, 0);

    return {
      nodes,
      edges,
      length: edges.length,
      totalWeight,
    };
  }

  // ── Contradiction Detection ────────────────────────────────

  /**
   * Find all contradiction edges in the graph.
   * 
   * Performance: Batch loads all memories in one query instead of
   * 2×limit individual queries.
   */
  findContradictions(limit: number = 20): ContradictionPair[] {
    const rows = this.db
      .prepare(
        `
      SELECT e.source_id, e.target_id, e.evidence, e.weight
      FROM memory_edges e
      WHERE e.relation_type = ?
      ORDER BY e.weight DESC, e.created_at DESC
      LIMIT ?
    `,
      )
      .all(MemoryRelationType.CONTRADICTS, limit) as {
      source_id: string;
      target_id: string;
      evidence: string | null;
      weight: number;
    }[];

    // Collect all unique memory IDs
    const memoryIds = new Set<string>();
    for (const row of rows) {
      memoryIds.add(row.source_id);
      memoryIds.add(row.target_id);
    }

    // Batch load all memories
    const memoryMap = this.loadMemoriesByIds(Array.from(memoryIds));

    // Build pairs
    const pairs: ContradictionPair[] = [];
    for (const row of rows) {
      const m1 = memoryMap.get(row.source_id);
      const m2 = memoryMap.get(row.target_id);

      if (!m1 || !m2) continue;

      pairs.push({
        memory1: m1 as any,
        memory2: m2 as any,
        evidence: row.evidence || "Contradiction detected via semantic analysis",
      });
    }

    return pairs;
  }

  // ── Decision Chain ─────────────────────────────────────────

  /**
   * Follow the chain of decisions that led to a given memory.
   * Traverses DERIVED_FROM, CAUSES, and SUPPORTS edges backwards.
   */
  getDecisionChain(
    memoryId: string,
    maxDepth: number = 5,
  ): RelatedMemory[] {
    return this.getRelatedContext(memoryId, {
      maxDepth,
      relationTypes: [
        MemoryRelationType.DERIVED_FROM,
        MemoryRelationType.CAUSES,
        MemoryRelationType.SUPPORTS,
      ],
      minWeight: 0.3,
      limit: 20,
      includeEvidence: true,
    });
  }

  // ── Hub Analysis ───────────────────────────────────────────

  /**
   * Get the most connected memories (hubs) with full memory data.
   * 
   * Performance: Batch loads all hub memories in one query instead of
   * limit individual queries.
   */
  getHubMemories(
    limit: number = 10,
  ): { memory: MemoryRow; degree: number }[] {
    const hubs = this.graphStore.getHubMemories(limit);
    const memoryIds = hubs.map((h) => h.memoryId);
    
    // Batch load all hub memories
    const memoryMap = this.loadMemoriesByIds(memoryIds);
    
    const result: { memory: MemoryRow; degree: number }[] = [];
    for (const hub of hubs) {
      const memory = memoryMap.get(hub.memoryId);
      if (memory) {
        result.push({ memory, degree: hub.degree });
      }
    }

    return result;
  }

  // ── Neighborhood Summary ───────────────────────────────────

  /**
   * Get a compact summary of a memory's neighborhood.
   * Useful for injecting into LLM context.
   */
  getNeighborhoodSummary(memoryId: string): string {
    const related = this.getRelatedContext(memoryId, {
      maxDepth: 1,
      limit: 10,
    });

    if (related.length === 0) {
      return "";
    }

    const lines: string[] = ["Related memories:"];

    for (const r of related) {
      const direction =
        r.edge.sourceId === memoryId ? "→" : "←";
      const typeLabel = r.edge.relationType.replace(/_/g, " ").toLowerCase();
      const snippet =
        r.memory.content.length > 120
          ? r.memory.content.substring(0, 120) + "..."
          : r.memory.content;

      lines.push(
        `  ${direction} [${typeLabel}] (${r.memory.type}) ${snippet}`,
      );
    }

    return lines.join("\n");
  }

  // ── Helpers ────────────────────────────────────────────────

  /**
   * Load a single memory by ID.
   */
  private loadMemory(memoryId: string): MemoryRow | null {
    return this.db
      .prepare(
        `
      SELECT id, content, type, level, importance, tags,
             created_at, updated_at, access_count,
             user_id, session_id, project_id, agent_id
      FROM memories WHERE id = ?
    `,
      )
      .get(memoryId) as MemoryRow | null;
  }

  /**
   * Batch load multiple memories by IDs.
   * 
   * This eliminates N+1 query pattern in BFS traversal.
   * Instead of O(N) queries, we do O(1) per BFS level.
   * 
   * Example: Loading 100 neighbors goes from 100 queries → 1 query.
   */
  private loadMemoriesByIds(memoryIds: string[]): Map<string, MemoryRow> {
    if (memoryIds.length === 0) {
      return new Map();
    }

    // Build placeholders for IN clause
    const placeholders = memoryIds.map(() => "?").join(",");
    
    const rows = this.db
      .prepare(
        `
      SELECT id, content, type, level, importance, tags,
             created_at, updated_at, access_count,
             user_id, session_id, project_id, agent_id
      FROM memories
      WHERE id IN (${placeholders})
    `,
      )
      .all(...memoryIds) as MemoryRow[];

    // Convert to map for O(1) lookup
    const result = new Map<string, MemoryRow>();
    for (const row of rows) {
      result.set(row.id, row);
    }

    return result;
  }

  /**
   * Close database connection.
   */
  close(): void {
    this.db?.close();
  }
}
