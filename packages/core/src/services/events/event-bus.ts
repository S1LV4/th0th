/**
 * Event Bus
 *
 * Typed EventEmitter singleton for broadcasting ETL progress events
 * to SSE subscribers and internal listeners (WorkspaceManager, etc.).
 */

import { EventEmitter } from "events";

// ─── Event map ────────────────────────────────────────────────────────────────

export interface EventMap {
  "indexing:started": {
    jobId: string;
    projectId: string;
    projectPath: string;
    totalFiles?: number;
  };
  "indexing:progress": {
    jobId: string;
    projectId: string;
    stage: string;
    current: number;
    total: number;
    percentage: number;
  };
  "indexing:file": {
    jobId: string;
    projectId: string;
    filePath: string;
    stage: string;
    status: "ok" | "error";
    error?: string;
  };
  "indexing:completed": {
    jobId: string;
    projectId: string;
    filesIndexed: number;
    chunksIndexed: number;
    symbolsIndexed: number;
    durationMs: number;
  };
  "indexing:failed": {
    jobId: string;
    projectId: string;
    error: string;
    durationMs: number;
  };
  "workspace:updated": {
    projectId: string;
    status: "pending" | "indexing" | "indexed" | "error";
    filesCount?: number;
    symbolsCount?: number;
  };
}

export type EventName = keyof EventMap;

// ─── Typed EventBus ───────────────────────────────────────────────────────────

class TypedEventBus extends EventEmitter {
  private static instance: TypedEventBus | null = null;

  private constructor() {
    super();
    // Increase listener limit for SSE — many concurrent clients
    this.setMaxListeners(200);
  }

  static getInstance(): TypedEventBus {
    if (!TypedEventBus.instance) {
      TypedEventBus.instance = new TypedEventBus();
    }
    return TypedEventBus.instance;
  }

  publish<K extends EventName>(event: K, payload: EventMap[K]): void {
    this.emit(event, payload);
  }

  subscribe<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): () => void {
    this.on(event, listener as (payload: unknown) => void);
    return () => this.off(event, listener as (payload: unknown) => void);
  }
}

export const eventBus = TypedEventBus.getInstance();
export { TypedEventBus as EventBus };
