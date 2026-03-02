/**
 * Graph module internal types.
 *
 * Shared between GraphStore, GraphQueries, RelationExtractor,
 * and exposed through MemoryGraphService.
 */

import { MemoryEdge } from "@th0th/shared";

/**
 * A row from the memories table (projection without embedding).
 */
export interface MemoryRow {
  id: string;
  content: string;
  type: string;
  level: number;
  importance: number;
  tags: string | null;
  created_at: number;
  updated_at: number;
  access_count: number;
  user_id: string | null;
  session_id: string | null;
  project_id: string | null;
  agent_id: string | null;
}

/**
 * A row from the memories table that also includes the embedding blob.
 * Used by RelationExtractor for similarity computation.
 */
export interface MemoryRowWithEmbedding extends MemoryRow {
  embedding: Buffer | null;
}

/**
 * A memory node returned from graph traversal,
 * including the edge that connects it and its BFS depth.
 */
export interface RelatedMemory {
  memory: MemoryRow;
  edge: MemoryEdge;
  depth: number;
}
