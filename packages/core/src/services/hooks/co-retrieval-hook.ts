/**
 * CoRetrievalHook — Hebbian co-retrieval reinforcement
 *
 * When two session memories are stored in the same search session, they
 * co-occur semantically. This hook creates or strengthens a RELATES_TO
 * edge between them in the GraphStore, making those memories surface
 * together in future neighborhood queries (th0th_optimized_context).
 *
 * Architecture decisions vs. the original spec:
 *  - Uses GraphStore (SQLite) not Prisma — edges already live there.
 *  - Uses MemoryRelationType.RELATES_TO — no new edge type/migration.
 *  - Weights in [0, 1] — consistent with GraphStore design.
 *  - Only the "retrieved" signal — richer signals (used_in_answer,
 *    task_succeeded) have no emitter in the current system.
 *  - No decay job — out of scope for MVP; edges are bounded by the
 *    saturation cap instead.
 *  - Opt-in via TH0TH_CO_RETRIEVAL_HOOK=true — safe rollout.
 *
 * Timing:
 *  SearchSessionHook stores Memory(B), then emits "memory:session-stored".
 *  At that point Memory(B) is already in the DB. This hook receives the
 *  event, queries recent session memories → finds Memory(A), links A↔B.
 */

import { logger, MemoryRelationType } from "@th0th-ai/shared";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/event-bus.js";
import { GraphStore } from "../graph/graph-store.js";
import { getMemoryRepository } from "../../data/memory/memory-repository-factory.js";
import type { MemoryRepositoryPg } from "../../data/memory/memory-repository-pg.js";

const INITIAL_WEIGHT = 0.15;
const DELTA = 0.1;
const MAX_WEIGHT = 0.85;
const SESSION_WINDOW_MS = 10 * 60 * 1000; // 10-minute co-session window
const MAX_PEERS = 5;                        // limit combinatorial pairs
const AUTO_SEARCH_TAG = "auto:search-session";

/** Subset of GraphStore used by CoRetrievalHook — injectable for testing. */
export interface IGraphStoreEdges {
  getEdge(sourceId: string, targetId: string, relationType: MemoryRelationType): any;
  createEdge(sourceId: string, targetId: string, relationType: MemoryRelationType, opts?: any): any;
  incrementEdgeWeight(sourceId: string, targetId: string, relationType: MemoryRelationType, delta: number, maxWeight?: number): boolean;
}

export class CoRetrievalHook {
  private static instance: CoRetrievalHook | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly graphStore: IGraphStoreEdges;

  private constructor(graphStore?: IGraphStoreEdges) {
    this.graphStore = graphStore ?? GraphStore.getInstance();
  }

  static getInstance(): CoRetrievalHook {
    if (!CoRetrievalHook.instance) {
      CoRetrievalHook.instance = new CoRetrievalHook();
    }
    return CoRetrievalHook.instance;
  }

  /** Create an isolated instance with injected dependencies — for testing only. */
  static createForTest(
    graphStore: IGraphStoreEdges,
    repo?: { findRecentByTag: MemoryRepositoryPg["findRecentByTag"] },
  ): CoRetrievalHook {
    const hook = new CoRetrievalHook(graphStore);
    if (repo) (hook as any)._testRepo = repo;
    return hook;
  }

  /** Register the hook. Safe to call multiple times — only registers once. */
  register(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.subscribe("memory:session-stored", (payload) => {
      void this.handleMemoryStored(payload);
    });
    logger.debug("CoRetrievalHook registered");
  }

  /** Unregister the hook (useful in tests). */
  unregisterHook(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    logger.debug("CoRetrievalHook unregistered");
  }

  /** Reset singleton (test utility). */
  static reset(): void {
    CoRetrievalHook.instance?.unregisterHook();
    CoRetrievalHook.instance = null;
  }

  private async handleMemoryStored(
    payload: EventMap["memory:session-stored"],
  ): Promise<void> {
    // Feature flag — opt-in only; any value other than "true" keeps it off
    if (process.env.TH0TH_CO_RETRIEVAL_HOOK !== "true") return;

    const { memoryId, projectId, sessionId } = payload;

    let peers: Array<{ id: string }>;
    try {
      peers = await this.findPeers(memoryId, projectId, sessionId);
    } catch (err) {
      logger.warn("CoRetrievalHook: peer lookup failed", {
        error: (err as Error).message,
        memoryId,
      });
      return;
    }

    if (peers.length === 0) return;

    let created = 0;
    let reinforced = 0;

    for (const peer of peers.slice(0, MAX_PEERS)) {
      // Deterministic pair ordering prevents duplicate edges (A↔B == B↔A)
      const [from, to] = [memoryId, peer.id].sort();

      const existing = this.graphStore.getEdge(from, to, MemoryRelationType.RELATES_TO);

      if (existing) {
        const ok = this.graphStore.incrementEdgeWeight(
          from,
          to,
          MemoryRelationType.RELATES_TO,
          DELTA,
          MAX_WEIGHT,
        );
        if (ok) reinforced++;
      } else {
        const edge = this.graphStore.createEdge(from, to, MemoryRelationType.RELATES_TO, {
          weight: INITIAL_WEIGHT,
          evidence: "co-retrieved in session",
          autoExtracted: true,
        });
        if (edge) created++;
      }
    }

    if (created > 0 || reinforced > 0) {
      logger.debug("CoRetrievalHook: edges updated", {
        memoryId,
        created,
        reinforced,
        peers: peers.length,
      });
    }
  }

  private async findPeers(
    memoryId: string,
    projectId: string | undefined,
    sessionId: string | undefined,
  ): Promise<Array<{ id: string }>> {
    // Allow test injection via createForTest
    const repo: any = (this as any)._testRepo ?? (getMemoryRepository() as MemoryRepositoryPg);

    // The method is only available on the Pg implementation.
    // If running against SQLite repo in tests, skip gracefully.
    if (typeof repo.findRecentByTag !== "function") return [];

    return repo.findRecentByTag(AUTO_SEARCH_TAG, {
      sessionId,
      projectId,
      excludeId: memoryId,
      sinceMs: Date.now() - SESSION_WINDOW_MS,
      limit: MAX_PEERS,
    });
  }
}

export const coRetrievalHook = CoRetrievalHook.getInstance();
