/**
 * SearchSessionHook
 *
 * Subscribes to "search:completed" events on the EventBus and automatically
 * stores a lightweight session memory for every search that returns results.
 *
 * This creates an "intermediate memory" layer that bridges ephemeral search
 * context (lost on compaction) and explicit persistent memories (th0th_remember).
 *
 * Design decisions:
 *  - Non-blocking: store failures are logged but never surfaced to callers.
 *  - Dedup: same (sessionId, projectId, query) is not stored twice within DEDUP_TTL_MS.
 *  - Low importance (0.3): the temporal score and access reinforcement in
 *    MemoryService naturally elevate memories that are accessed repeatedly.
 *  - Prunes the dedup map when it grows beyond MAX_DEDUP_ENTRIES to avoid leaks.
 */

import { logger, MemoryType } from "@th0th-ai/shared";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/event-bus.js";
import { MemoryController } from "../../controllers/memory-controller.js";

const DEDUP_TTL_MS = 60_000;
const MAX_DEDUP_ENTRIES = 500;

export class SearchSessionHook {
  private static instance: SearchSessionHook | null = null;

  private unsubscribe: (() => void) | null = null;
  /** dedup key → last stored timestamp */
  private readonly recentKeys = new Map<string, number>();

  private constructor() {}

  static getInstance(): SearchSessionHook {
    if (!SearchSessionHook.instance) {
      SearchSessionHook.instance = new SearchSessionHook();
    }
    return SearchSessionHook.instance;
  }

  /** Register the hook. Safe to call multiple times — only registers once. */
  register(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = eventBus.subscribe("search:completed", (payload) => {
      void this.handleSearchCompleted(payload);
    });
    logger.debug("SearchSessionHook registered");
  }

  /** Unregister the hook (useful in tests). */
  unregisterHook(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    logger.debug("SearchSessionHook unregistered");
  }

  /** Reset singleton (test utility). */
  static reset(): void {
    SearchSessionHook.instance?.unregisterHook();
    SearchSessionHook.instance = null;
  }

  private async handleSearchCompleted(
    payload: EventMap["search:completed"],
  ): Promise<void> {
    const { query, projectId, sessionId, results, resultCount } = payload;

    if (resultCount === 0) return;

    // Dedup: skip if same (session, project, query) was stored recently
    const dedupKey = `${sessionId ?? ""}:${projectId}:${query}`;
    const now = Date.now();
    const lastStored = this.recentKeys.get(dedupKey);
    if (lastStored !== undefined && now - lastStored < DEDUP_TTL_MS) return;

    this.recentKeys.set(dedupKey, now);
    this.pruneDedup(now);

    const top3 = results
      .slice(0, 3)
      .map((r) => r.filePath)
      .join(", ");

    const content = `Search[${projectId}]: "${query}" → ${top3}`;

    try {
      const stored = await MemoryController.getInstance().store({
        content,
        type: MemoryType.CONVERSATION,
        projectId,
        sessionId,
        importance: 0.3,
        tags: ["auto:search-session", "auto:search"],
      });

      logger.debug("SearchSessionHook: memory stored", {
        projectId,
        query: query.slice(0, 60),
        resultCount,
      });

      eventBus.publish("memory:session-stored", {
        memoryId: stored.memoryId,
        projectId,
        sessionId,
        query,
      });
    } catch (err) {
      logger.warn("SearchSessionHook: store failed (best-effort)", {
        error: (err as Error).message,
        projectId,
        query: query.slice(0, 60),
      });
    }
  }

  private pruneDedup(now: number): void {
    if (this.recentKeys.size <= MAX_DEDUP_ENTRIES) return;

    // First pass: remove expired entries
    for (const [k, ts] of this.recentKeys) {
      if (now - ts > DEDUP_TTL_MS) this.recentKeys.delete(k);
    }

    // Hard cap: if still over limit, evict oldest entries (insertion order)
    if (this.recentKeys.size > MAX_DEDUP_ENTRIES) {
      const excess = this.recentKeys.size - MAX_DEDUP_ENTRIES;
      let evicted = 0;
      for (const k of this.recentKeys.keys()) {
        this.recentKeys.delete(k);
        if (++evicted >= excess) break;
      }
    }
  }
}

export const searchSessionHook = SearchSessionHook.getInstance();
