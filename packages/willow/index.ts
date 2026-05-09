/**
 * packages/willow/index.ts — Willow SOIL adapter for th0th.
 *
 * Contribution to S1LV4/th0th.
 *
 * th0th currently stores memories in SQLite (GraphStore) or PostgreSQL
 * (GraphStorePg).  This adapter writes memory edges to Willow's SOIL store
 * instead, making th0th memories first-class citizens of the Willow agent
 * fleet.
 *
 * What SOIL is:
 *   SOIL is Willow's structured local record store.  It holds named JSON
 *   records under a collection/id hierarchy and is accessible to all agents
 *   in the fleet via the `store_put` / `store_get` MCP tools.  Writing th0th
 *   memories to SOIL means they are visible in the Willow dashboard, can be
 *   queried by other agents, and survive th0th container restarts.
 *
 * SOIL wire protocol:
 *   POST  /store/put     { collection, id, data }    → { ok: true }
 *   GET   /store/get     ?collection=&id=            → { record } | null
 *   POST  /store/delete  { collection, id }          → { ok: true }
 *   GET   /store/list    ?collection=                → { records: [] }
 *
 *   The Willow MCP server exposes these at http://localhost:8080 by default.
 *   Override with WILLOW_SOIL_URL environment variable.
 *
 * Usage — replace GraphStore in your memory service:
 *
 *   import { WillowGraphStore } from "@th0th-ai/willow";
 *   const store = WillowGraphStore.getInstance();
 *   await store.createEdge({ sourceId, targetId, relationType, weight });
 *
 * Collection naming:
 *   Memory edges    → th0th/edges/<sourceId>/<targetId>/<relationType>
 *   Edge index      → th0th/edge-index/<sourceId>   (list of edge ids)
 *
 * Graceful degradation:
 *   If WILLOW_SOIL_URL is not set or the server is unreachable, operations
 *   log a warning and return safe defaults rather than throwing.  th0th
 *   continues to function; memories just don't replicate to Willow.
 */

import type { MemoryEdge, MemoryRelationType } from "@th0th-ai/shared";

// ── Config ────────────────────────────────────────────────────────────────────

const SOIL_URL =
  process.env.WILLOW_SOIL_URL ?? "http://localhost:8080";

const COLLECTION_EDGES = "th0th/edges";
const COLLECTION_INDEX = "th0th/edge-index";

// ── SOIL HTTP helpers ─────────────────────────────────────────────────────────

interface SoilPutBody {
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

interface SoilDeleteBody {
  collection: string;
  id: string;
}

async function soilPut(body: SoilPutBody): Promise<boolean> {
  try {
    const res = await fetch(`${SOIL_URL}/store/put`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[WillowGraphStore] soilPut failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[WillowGraphStore] soilPut error:", (err as Error).message);
    return false;
  }
}

async function soilGet(
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL(`${SOIL_URL}/store/get`);
    url.searchParams.set("collection", collection);
    url.searchParams.set("id", id);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json() as { record?: Record<string, unknown> };
    return data.record ?? null;
  } catch {
    return null;
  }
}

async function soilDelete(body: SoilDeleteBody): Promise<boolean> {
  try {
    const res = await fetch(`${SOIL_URL}/store/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function soilList(
  collection: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const url = new URL(`${SOIL_URL}/store/list`);
    url.searchParams.set("collection", collection);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json() as { records?: Array<Record<string, unknown>> };
    return data.records ?? [];
  } catch {
    return [];
  }
}

// ── Edge ID helpers ───────────────────────────────────────────────────────────

function edgeId(
  sourceId: string,
  targetId: string,
  relationType: string,
): string {
  return `${sourceId}__${targetId}__${relationType}`;
}

function rowToEdge(row: Record<string, unknown>): MemoryEdge {
  return {
    id: String(row.id ?? ""),
    sourceId: String(row.sourceId ?? ""),
    targetId: String(row.targetId ?? ""),
    relationType: row.relationType as MemoryRelationType,
    weight: Number(row.weight ?? 1.0),
    evidence: row.evidence != null ? String(row.evidence) : undefined,
    autoExtracted: Boolean(row.autoExtracted ?? false),
    createdAt: row.createdAt != null ? new Date(String(row.createdAt)) : new Date(),
  };
}

// ── WillowGraphStore ──────────────────────────────────────────────────────────

export interface EdgeFilter {
  sourceId?: string;
  targetId?: string;
  relationTypes?: MemoryRelationType[];
  minWeight?: number;
  autoExtractedOnly?: boolean;
  limit?: number;
}

/**
 * WillowGraphStore — SOIL-backed memory edge store for th0th.
 *
 * Implements the same interface as GraphStore and GraphStorePg so it can
 * be substituted in MemoryGraphService without touching any other code.
 */
export class WillowGraphStore {
  private static instance: WillowGraphStore | null = null;

  static getInstance(): WillowGraphStore {
    if (!WillowGraphStore.instance) {
      WillowGraphStore.instance = new WillowGraphStore();
    }
    return WillowGraphStore.instance;
  }

  constructor() {
    if (!process.env.WILLOW_SOIL_URL) {
      console.warn(
        "[WillowGraphStore] WILLOW_SOIL_URL not set — " +
        "th0th memories will not replicate to Willow. " +
        "Set WILLOW_SOIL_URL=http://localhost:8080 to enable.",
      );
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async createEdge(
    edge: Omit<MemoryEdge, "id" | "createdAt">,
  ): Promise<MemoryEdge> {
    const id = edgeId(edge.sourceId, edge.targetId, edge.relationType);
    const createdAt = new Date().toISOString();

    const record: Record<string, unknown> = {
      id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relationType: edge.relationType,
      weight: edge.weight ?? 1.0,
      evidence: edge.evidence ?? null,
      autoExtracted: edge.autoExtracted ?? false,
      createdAt,
    };

    await soilPut({
      collection: COLLECTION_EDGES,
      id,
      data: record,
    });

    // Update edge index for sourceId (list of edge ids originating from this memory)
    await this._addToIndex(edge.sourceId, id);

    return { ...record, createdAt: new Date(createdAt) } as MemoryEdge;
  }

  async getEdge(id: string): Promise<MemoryEdge | null> {
    const row = await soilGet(COLLECTION_EDGES, id);
    if (!row) return null;
    return rowToEdge(row);
  }

  async getEdgesForMemory(memoryId: string): Promise<MemoryEdge[]> {
    return this.queryEdges({ sourceId: memoryId });
  }

  async getIncomingEdges(memoryId: string): Promise<MemoryEdge[]> {
    return this.queryEdges({ targetId: memoryId });
  }

  async queryEdges(filter: EdgeFilter): Promise<MemoryEdge[]> {
    // SOIL doesn't support server-side filtering — fetch candidate set and
    // filter in-process.
    let candidates: Array<Record<string, unknown>>;

    if (filter.sourceId) {
      // Use the edge index to avoid a full collection scan
      const indexId = `source__${filter.sourceId}`;
      const indexRow = await soilGet(COLLECTION_INDEX, indexId);
      const edgeIds: string[] = indexRow?.edgeIds as string[] ?? [];

      candidates = (
        await Promise.all(edgeIds.map((eid) => soilGet(COLLECTION_EDGES, eid)))
      ).filter((r): r is Record<string, unknown> => r !== null);
    } else {
      // Full scan (used for targetId queries and unfiltered listing)
      candidates = await soilList(COLLECTION_EDGES);
    }

    let edges = candidates.map(rowToEdge);

    if (filter.targetId) {
      edges = edges.filter((e) => e.targetId === filter.targetId);
    }
    if (filter.relationTypes?.length) {
      edges = edges.filter((e) =>
        filter.relationTypes!.includes(e.relationType),
      );
    }
    if (filter.minWeight !== undefined) {
      edges = edges.filter((e) => (e.weight ?? 1) >= filter.minWeight!);
    }
    if (filter.autoExtractedOnly) {
      edges = edges.filter((e) => e.autoExtracted);
    }
    if (filter.limit) {
      edges = edges.slice(0, filter.limit);
    }

    return edges;
  }

  async deleteEdge(edgeId: string): Promise<boolean> {
    return soilDelete({ collection: COLLECTION_EDGES, id: edgeId });
  }

  async deleteEdgesForMemory(memoryId: string): Promise<number> {
    const edges = await this.getEdgesForMemory(memoryId);
    const results = await Promise.all(
      edges.map((e) => this.deleteEdge(e.id)),
    );
    // Also remove from edge index
    await soilDelete({
      collection: COLLECTION_INDEX,
      id: `source__${memoryId}`,
    });
    return results.filter(Boolean).length;
  }

  // ── Index helpers ─────────────────────────────────────────────────────────

  private async _addToIndex(sourceId: string, newEdgeId: string): Promise<void> {
    const indexId = `source__${sourceId}`;
    const existing = await soilGet(COLLECTION_INDEX, indexId);
    const edgeIds: string[] = (existing?.edgeIds as string[] ?? []).filter(
      (id) => id !== newEdgeId,
    );
    edgeIds.push(newEdgeId);
    await soilPut({
      collection: COLLECTION_INDEX,
      id: indexId,
      data: { edgeIds },
    });
  }
}

// ── Convenience exports ───────────────────────────────────────────────────────

export { WillowGraphStore as default };
