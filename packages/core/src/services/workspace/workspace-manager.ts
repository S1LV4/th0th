/**
 * Workspace Manager
 *
 * Single source of truth for project registration and indexing status.
 * Persists all state to the `workspaces` table in the symbol SQLite DB
 * (replacing the zero-embedding _metadata docs in the vector store).
 *
 * Subscribes to EventBus to auto-update status on indexing lifecycle events.
 */

import { logger } from "@th0th-ai/shared";
import { getSymbolRepository } from "../../data/sqlite/symbol-repository-factory.js";
import type { WorkspaceRow, WorkspaceStatus } from "../../data/sqlite/symbol-repository.js";
import { eventBus } from "../events/event-bus.js";
import { symbolGraphService } from "../symbol/symbol-graph.service.js";

export type { WorkspaceRow, WorkspaceStatus };

export class WorkspaceManager {
  private static instance: WorkspaceManager | null = null;

  private constructor() {
    this.subscribeToEvents();
  }

  static getInstance(): WorkspaceManager {
    if (!WorkspaceManager.instance) {
      WorkspaceManager.instance = new WorkspaceManager();
    }
    return WorkspaceManager.instance;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Register a workspace as "indexing" (called at the start of ETL).
   * Creates the row if it doesn't exist yet.
   */
  async markIndexing(projectId: string, projectPath: string): Promise<void> {
    const repo = getSymbolRepository();
    const existing = await repo.getWorkspace(projectId);
    await repo.upsertWorkspace({
      project_id: projectId,
      project_path: projectPath,
      display_name: projectPath.split("/").pop(),
      status: "indexing",
      files_count: existing?.files_count ?? 0,
      chunks_count: existing?.chunks_count ?? 0,
      symbols_count: existing?.symbols_count ?? 0,
      created_at: existing?.created_at,
    });

    eventBus.publish("workspace:updated", { projectId, status: "indexing" });
    logger.info("WorkspaceManager: marked as indexing", { projectId });
  }

  /**
   * Called after a successful ETL run.
   * Triggers centrality recomputation in the background.
   */
  async markIndexed(
    projectId: string,
    stats: { filesCount: number; chunksCount: number; symbolsCount: number },
  ): Promise<void> {
    await getSymbolRepository().updateWorkspaceStatus(projectId, "indexed", {
      lastIndexedAt: Date.now(),
      lastError: null,
      filesCount: stats.filesCount,
      chunksCount: stats.chunksCount,
      symbolsCount: stats.symbolsCount,
    });

    eventBus.publish("workspace:updated", {
      projectId,
      status: "indexed",
      filesCount: stats.filesCount,
      symbolsCount: stats.symbolsCount,
    });

    // Background centrality recomputation (non-blocking)
    symbolGraphService
      .recomputeCentrality(projectId)
      .catch((err) =>
        logger.error("WorkspaceManager: centrality recomputation failed", err as Error, { projectId }),
      );

    logger.info("WorkspaceManager: marked as indexed", { projectId, ...stats });
  }

  /**
   * Called on ETL failure.
   */
  async markError(projectId: string, error: string): Promise<void> {
    await getSymbolRepository().updateWorkspaceStatus(projectId, "error", {
      lastError: error,
    });

    eventBus.publish("workspace:updated", { projectId, status: "error" });
    logger.warn("WorkspaceManager: marked as error", { projectId, error });
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async listWorkspaces(statusFilter?: WorkspaceStatus | "all"): Promise<WorkspaceRow[]> {
    const all = await getSymbolRepository().listWorkspaces();
    if (!statusFilter || statusFilter === "all") return all;
    return all.filter((w) => w.status === statusFilter);
  }

  async getWorkspace(projectId: string): Promise<WorkspaceRow | null> {
    return getSymbolRepository().getWorkspace(projectId);
  }

  /**
   * Remove a project: deletes workspace row + all symbol data (CASCADE).
   * Does NOT clear the vector store — caller is responsible for that.
   */
  async removeWorkspace(projectId: string): Promise<void> {
    await getSymbolRepository().clearProject(projectId);
    logger.info("WorkspaceManager: workspace removed", { projectId });
  }

  // ── EventBus integration ──────────────────────────────────────────────────

  private subscribeToEvents(): void {
    eventBus.subscribe("indexing:started", ({ projectId, projectPath }) => {
      this.markIndexing(projectId, projectPath).catch((err) =>
        logger.error("WorkspaceManager: failed to mark indexing", err as Error, { projectId }),
      );
    });

    eventBus.subscribe("indexing:completed", ({ projectId, filesIndexed, chunksIndexed, symbolsIndexed }) => {
      this.markIndexed(projectId, {
        filesCount: filesIndexed,
        chunksCount: chunksIndexed,
        symbolsCount: symbolsIndexed,
      }).catch((err) =>
        logger.error("WorkspaceManager: failed to mark indexed", err as Error, { projectId }),
      );
    });

    eventBus.subscribe("indexing:failed", ({ projectId, error }) => {
      this.markError(projectId, error).catch((err) =>
        logger.error("WorkspaceManager: failed to mark error", err as Error, { projectId }),
      );
    });
  }
}

export const workspaceManager = WorkspaceManager.getInstance();
