/**
 * ETL Pipeline Orchestrator
 *
 * Runs the 4 stages in sequence: discover → parse → resolve → load
 *
 * Integrates with:
 * - IndexJobTracker (in-memory job status polling)
 * - EventBus (real-time SSE broadcast)
 * - SymbolRepository (centrality-based priority ordering in discover)
 * - ContextualSearchRLM (vector clear on forceReindex)
 *
 * Usage:
 *   const pipeline = EtlPipeline.getInstance();
 *   const result = await pipeline.run({ projectId, projectPath, jobId });
 */

import { logger } from "@th0th-ai/shared";
import { DiscoverStage } from "./stages/discover.js";
import { ParseStage } from "./stages/parse.js";
import { ResolveStage } from "./stages/resolve.js";
import { LoadStage } from "./stages/load.js";
import { eventBus } from "../events/event-bus.js";
import { symbolRepository } from "../../data/sqlite/symbol-repository.js";
import { indexJobTracker } from "../jobs/index-job-tracker.js";
import type { EtlStageContext, EtlEvent, EtlResult, EtlStage } from "./stage-context.js";

export interface PipelineInput {
  projectId: string;
  projectPath: string;
  jobId: string;
  forceReindex?: boolean;
  /** If provided, only process these relative paths (incremental mode). */
  filesToProcess?: string[];
}

export class EtlPipeline {
  private static instance: EtlPipeline | null = null;

  private readonly discover = new DiscoverStage();
  private readonly parse = new ParseStage();
  private readonly resolve = new ResolveStage();
  private readonly load = new LoadStage();

  private constructor() {}

  static getInstance(): EtlPipeline {
    if (!EtlPipeline.instance) {
      EtlPipeline.instance = new EtlPipeline();
    }
    return EtlPipeline.instance;
  }

  async run(input: PipelineInput): Promise<EtlResult> {
    const { projectId, projectPath, jobId, forceReindex = false, filesToProcess } = input;
    const t0 = performance.now();
    const stageTimings: Record<EtlStage, number> = {
      discover: 0,
      parse: 0,
      resolve: 0,
      load: 0,
    };

    // If force, wipe all symbol data for this project
    if (forceReindex) {
      symbolRepository.clearProject(projectId);
      logger.info("EtlPipeline: cleared symbol data for full reindex", { projectId });
    }

    // Build stage context with event emission
    const ctx: EtlStageContext = {
      projectId,
      projectPath,
      jobId,
      emit: (event: EtlEvent) => {
        // Forward ETL events to the global EventBus for SSE + job tracker
        if (event.type === "progress") {
          const p = event.payload as { current: number; total: number; percentage: number };
          indexJobTracker.updateProgress(jobId, p.current, p.total);
          eventBus.publish("indexing:progress", {
            jobId,
            projectId,
            stage: event.stage,
            current: p.current,
            total: p.total,
            percentage: p.percentage,
          });
        } else if (event.type === "file_error") {
          const p = event.payload as { filePath: string; error: string };
          eventBus.publish("indexing:file", {
            jobId,
            projectId,
            filePath: p.filePath,
            stage: event.stage,
            status: "error",
            error: p.error,
          });
        } else if (event.type === "file_processed") {
          const p = event.payload as { filePath: string };
          eventBus.publish("indexing:file", {
            jobId,
            projectId,
            filePath: p.filePath,
            stage: event.stage,
            status: "ok",
          });
        }
      },
    };

    eventBus.publish("indexing:started", { jobId, projectId, projectPath });

    try {
      // ── Stage 1: Discover ─────────────────────────────────────────────────
      const st1 = performance.now();
      const discovered = await this.discover.run(ctx, { forceReindex, filesToProcess });
      stageTimings.discover = Math.round(performance.now() - st1);

      eventBus.publish("indexing:started", {
        jobId,
        projectId,
        projectPath,
        totalFiles: discovered.filter((f) => f.needsReparse).length,
      });

      // ── Stage 2: Parse ────────────────────────────────────────────────────
      const st2 = performance.now();
      const parsed = await this.parse.run(ctx, discovered);
      stageTimings.parse = Math.round(performance.now() - st2);

      // ── Stage 3: Resolve ──────────────────────────────────────────────────
      const st3 = performance.now();
      const resolved = await this.resolve.run(ctx, parsed);
      stageTimings.resolve = Math.round(performance.now() - st3);

      // ── Stage 4: Load ─────────────────────────────────────────────────────
      const st4 = performance.now();
      const loadResult = await this.load.run(ctx, resolved);
      stageTimings.load = Math.round(performance.now() - st4);

      const durationMs = Math.round(performance.now() - t0);

      const result: EtlResult = {
        filesDiscovered: discovered.length,
        filesIndexed: loadResult.filesLoaded,
        filesSkipped: discovered.filter((f) => !f.needsReparse).length,
        chunksIndexed: loadResult.chunksLoaded,
        symbolsIndexed: loadResult.symbolsLoaded,
        errors: loadResult.errors,
        durationMs,
        stageTimings,
      };

      eventBus.publish("indexing:completed", {
        jobId,
        projectId,
        filesIndexed: result.filesIndexed,
        chunksIndexed: result.chunksIndexed,
        symbolsIndexed: result.symbolsIndexed,
        durationMs,
      });

      logger.info("EtlPipeline: run completed", { projectId, jobId, ...result });
      return result;
    } catch (err) {
      const durationMs = Math.round(performance.now() - t0);
      const error = (err as Error).message;

      eventBus.publish("indexing:failed", { jobId, projectId, error, durationMs });
      logger.error("EtlPipeline: run failed", err as Error, { projectId, jobId, durationMs });
      throw err;
    }
  }
}

export const etlPipeline = EtlPipeline.getInstance();
