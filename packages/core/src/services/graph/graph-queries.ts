/**
 * Graph Queries
 *
 * Traversal and query operations over the memory knowledge graph.
 * Provides BFS-based traversal with depth limits, path finding,
 * contradiction detection, and hub analysis.
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
} from "@th0th/shared";
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

        // Load memory
        const memory = this.loadMemory(neighborId);
        if (!memory) continue;

        result.push({
          memory,
          edge: opts.includeEvidence
            ? edge
            : { ...edge, evidence: undefined },
          depth: depth + 1,
        });

        // Enqueue for deeper traversal
        if (depth + 1 < opts.maxDepth) {
          queue.push([neighborId, depth + 1]);
        }

        if (result.length >= opts.limit) break;
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

    // Load all memories
    const nodes = nodeIds
      .map((id) => this.loadMemory(id))
      .filter(Boolean) as any[];

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

    const pairs: ContradictionPair[] = [];

    for (const row of rows) {
      const m1 = this.loadMemory(row.source_id);
      const m2 = this.loadMemory(row.target_id);

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
   */
  getHubMemories(
    limit: number = 10,
  ): { memory: MemoryRow; degree: number }[] {
    const hubs = this.graphStore.getHubMemories(limit);
    const result: { memory: MemoryRow; degree: number }[] = [];

    for (const hub of hubs) {
      const memory = this.loadMemory(hub.memoryId);
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
   * Close database connection.
   */
  close(): void {
    this.db?.close();
  }
}
