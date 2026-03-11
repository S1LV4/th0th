/**
 * Session File Cache
 *
 * Tracks which file chunks have already been delivered to an LLM in the
 * current conversation session.  Enables diff-only context delivery:
 *
 *   • "new"       → first time this chunk is seen; deliver full content.
 *   • "unchanged" → already delivered, content identical; deliver a compact
 *                   reference token instead (~8 tokens vs hundreds).
 *   • "changed"   → already delivered, content differs; deliver a line-level
 *                   diff block instead of the full new content.
 *
 * Lifecycle:  purely in-memory (no persistence).  Sessions are evicted by
 * LRU after MAX_SESSIONS entries or after SESSION_TTL_MS inactivity.
 */

import { createHash } from "crypto";
import { logger, estimateTokens } from "@th0th-ai/shared";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Approximate token cost of a single reference tag `[CACHED: path:L1-L2]`. */
export const REFERENCE_TOKEN_COST = 8;

/** Maximum number of concurrent sessions kept in memory. */
const MAX_SESSIONS = 200;

/** Evict sessions that have been idle for more than this duration. */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 h

// ── Public Types ──────────────────────────────────────────────────────────────

export type ChunkStatus = "new" | "unchanged" | "changed";

export interface ChunkCheckResult {
  status: ChunkStatus;
  /**
   * Only set when status === "changed".
   * Contains a compact "+/-" line-level diff between the previous and
   * current content of the chunk.
   */
  diff?: string;
  /**
   * Approximate tokens saved by NOT delivering full content.
   * 0 when status === "new".
   */
  tokensSaved: number;
}

export interface SessionCacheStats {
  trackedSessions: number;
  totalChecks: number;
  cacheHits: number;
  unchangedHits: number;
  changedHits: number;
  totalTokensSaved: number;
}

// ── Internal Types ────────────────────────────────────────────────────────────

interface ChunkRecord {
  hash: string;
  content: string;
  deliveredAt: number;
}

// ── Diff Helpers ──────────────────────────────────────────────────────────────

/**
 * Compute a compact, positional line-level diff.
 *
 * Lines are compared by position.  A line pair that differs produces a
 * `- old` / `+ new` entry.  Extra lines at the end of either side are
 * emitted as pure additions or removals.  Identical runs are omitted to
 * keep the diff minimal.
 */
function computeDiff(oldContent: string, newContent: string): string {
  if (oldContent === newContent) return "";

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diffLines: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i];
    const n = newLines[i];

    if (o === undefined) {
      diffLines.push(`+ ${n}`);
    } else if (n === undefined) {
      diffLines.push(`- ${o}`);
    } else if (o !== n) {
      diffLines.push(`- ${o}`);
      diffLines.push(`+ ${n}`);
    }
    // identical lines: intentionally omitted (context-free diff)
  }

  return diffLines.length > 0 ? diffLines.join("\n") : "";
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Singleton session-scoped file chunk cache.
 */
export class SessionFileCache {
  private static instance: SessionFileCache | null = null;

  /** sessionId  →  chunkKey  →  ChunkRecord */
  private readonly sessions = new Map<string, Map<string, ChunkRecord>>();

  /** sessionId → last-access timestamp (ms) — used for LRU eviction */
  private readonly lastAccess = new Map<string, number>();

  private readonly stats = {
    totalChecks: 0,
    cacheHits: 0,
    unchangedHits: 0,
    changedHits: 0,
    totalTokensSaved: 0,
  };

  private constructor() {}

  static getInstance(): SessionFileCache {
    if (!SessionFileCache.instance) {
      SessionFileCache.instance = new SessionFileCache();
    }
    return SessionFileCache.instance;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Build the canonical chunk key from file metadata.
   *
   * @param filePath   Relative or absolute path of the file.
   * @param lineStart  First line of the chunk (1-based).
   * @param lineEnd    Last line of the chunk (1-based, inclusive).
   */
  chunkKey(filePath: string, lineStart: number, lineEnd: number): string {
    return `${filePath}:${lineStart}-${lineEnd}`;
  }

  /**
   * Check whether a chunk should be delivered in full, as a reference token,
   * or as a diff block.
   *
   * Call this once per chunk per `getOptimizedContext` invocation.  The cache
   * is updated automatically: on a cache miss the chunk is stored; on a
   * "changed" hit the record is updated with the new content.
   *
   * @param sessionId  Conversation / session identifier.
   * @param key        Chunk key produced by `chunkKey()`.
   * @param content    Current full text content of the chunk.
   */
  check(sessionId: string, key: string, content: string): ChunkCheckResult {
    this.touch(sessionId);
    this.stats.totalChecks++;

    const hash = this.hashContent(content);
    const sessionMap = this.sessions.get(sessionId)!;
    const existing = sessionMap.get(key);

    // ── First delivery ──────────────────────────────────────────────────────
    if (!existing) {
      sessionMap.set(key, { hash, content, deliveredAt: Date.now() });
      return { status: "new", tokensSaved: 0 };
    }

    // ── Content identical ───────────────────────────────────────────────────
    if (existing.hash === hash) {
      this.stats.cacheHits++;
      this.stats.unchangedHits++;
      const saved = Math.max(
        0,
        estimateTokens(content, "code") - REFERENCE_TOKEN_COST,
      );
      this.stats.totalTokensSaved += saved;
      logger.debug("Session file cache: unchanged chunk", {
        sessionId,
        key,
        tokensSaved: saved,
      });
      return { status: "unchanged", tokensSaved: saved };
    }

    // ── Content changed ─────────────────────────────────────────────────────
    const diff = computeDiff(existing.content, content);
    // Update the cached record to the latest content
    sessionMap.set(key, { hash, content, deliveredAt: Date.now() });

    this.stats.cacheHits++;
    this.stats.changedHits++;
    // Tokens saved = full content – diff (diff is usually much smaller)
    const diffTokens = estimateTokens(diff, "code");
    const fullTokens = estimateTokens(content, "code");
    const saved = Math.max(0, fullTokens - diffTokens);
    this.stats.totalTokensSaved += saved;

    logger.debug("Session file cache: changed chunk", {
      sessionId,
      key,
      fullTokens,
      diffTokens,
      tokensSaved: saved,
    });

    return { status: "changed", diff: diff || "(binary change)", tokensSaved: saved };
  }

  /**
   * Invalidate all tracked chunks for a session.
   * Useful when the caller explicitly requests a fresh context.
   */
  invalidateSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.lastAccess.delete(sessionId);
    logger.info("Session file cache invalidated", { sessionId });
  }

  /** Global statistics across all sessions. */
  getStats(): SessionCacheStats {
    return {
      trackedSessions: this.sessions.size,
      ...this.stats,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private hashContent(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  /** Ensure the session map exists and refresh its LRU timestamp. */
  private touch(sessionId: string): void {
    this.lastAccess.set(sessionId, Date.now());
    if (!this.sessions.has(sessionId)) {
      this.evictIfNeeded();
      this.sessions.set(sessionId, new Map());
      logger.debug("Session file cache: new session", { sessionId });
    }
  }

  /** LRU + TTL eviction when we exceed MAX_SESSIONS. */
  private evictIfNeeded(): void {
    if (this.sessions.size < MAX_SESSIONS) return;

    const now = Date.now();

    // Phase 1: remove stale sessions (idle > TTL)
    for (const [id, ts] of this.lastAccess) {
      if (now - ts > SESSION_TTL_MS) {
        this.sessions.delete(id);
        this.lastAccess.delete(id);
      }
    }

    // Phase 2: if still at capacity, evict the least-recently-used session
    if (this.sessions.size >= MAX_SESSIONS) {
      let lruId: string | null = null;
      let lruTs = Infinity;
      for (const [id, ts] of this.lastAccess) {
        if (ts < lruTs) {
          lruTs = ts;
          lruId = id;
        }
      }
      if (lruId) {
        this.sessions.delete(lruId);
        this.lastAccess.delete(lruId);
        logger.debug("Session file cache: LRU eviction", { evictedSession: lruId });
      }
    }
  }
}
