/**
 * Index Project Tool
 *
 * Indexes an entire project for optimized contextual search (ASYNC).
 * Creates embeddings and FTS5 indexes for all relevant files.
 *
 * Returns a jobId immediately and processes indexing in background.
 * Use th0th_get_index_status(jobId) to check progress.
 *
 * Now powered by the 4-stage ETL Pipeline:
 *   discover → parse → resolve → load
 */

import { IToolHandler } from "@th0th-ai/shared";
import { ToolResponse } from "@th0th-ai/shared";
import { ContextualSearchRLM } from "../services/search/contextual-search-rlm.js";
import { logger } from "@th0th-ai/shared";
import { indexJobTracker } from "../services/jobs/index-job-tracker.js";
import { etlPipeline } from "../services/etl/pipeline.js";
import path from "path";

interface IndexProjectParams {
  projectPath: string;
  projectId?: string;
  forceReindex?: boolean;
  warmCache?: boolean;
  warmupQueries?: string[];
}

export class IndexProjectTool implements IToolHandler {
  name = "index_project";
  description =
    "Index a project directory for contextual code search with semantic embeddings";
  inputSchema = {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Absolute path to the project directory to index",
      },
      projectId: {
        type: "string",
        description:
          "Unique identifier for the project (defaults to directory name)",
      },
      forceReindex: {
        type: "boolean",
        description: "Force reindex even if project already exists",
        default: false,
      },
      warmCache: {
        type: "boolean",
        description: "Pre-cache common queries after indexing for faster initial searches",
        default: false,
      },
      warmupQueries: {
        type: "array",
        items: { type: "string" },
        description: "Custom queries to pre-cache (uses defaults if not provided)",
      },
    },
    required: ["projectPath"],
  };

  private contextualSearch: ContextualSearchRLM;

  constructor() {
    this.contextualSearch = new ContextualSearchRLM();
  }

  async handle(params: unknown): Promise<ToolResponse> {
    const {
      projectPath,
      projectId,
      forceReindex = false,
      warmCache = false,
      warmupQueries,
    } = params as IndexProjectParams;

    try {
      // Gera projectId se não fornecido
      const finalProjectId =
        projectId || path.basename(projectPath) || "default";

      // Cria job de indexação
      const job = indexJobTracker.createJob(finalProjectId, projectPath);

      logger.info("Indexing job created", {
        jobId: job.jobId,
        projectPath,
        projectId: finalProjectId,
      });

      // Executa indexação em background (não await)
      this.executeIndexing(
        job.jobId,
        finalProjectId,
        projectPath,
        forceReindex,
        warmCache,
        warmupQueries
      ).catch((error) => {
        logger.error("Background indexing failed", error as Error, {
          jobId: job.jobId,
        });
      });

      // Return immediately with jobId
      return {
        success: true,
        data: {
          jobId: job.jobId,
          projectId: finalProjectId,
          projectPath,
          status: "started",
          message:
            "Indexing started in background. Use th0th_get_index_status(jobId) to check progress.",
        },
      };
    } catch (error) {
      logger.error("Failed to start indexing job", error as Error, {
        projectPath,
        projectId,
      });

      return {
        success: false,
        error: `Failed to start indexing: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Executa indexação em background usando o ETL Pipeline de 4 estágios.
   *
   * O pipeline substitui o monobloco contextualSearch.indexProject() anterior:
   *   discover → parse → resolve → load
   *
   * Mantém compatibilidade: warmCache continua funcionando via contextualSearch.
   */
  private async executeIndexing(
    jobId: string,
    projectId: string,
    projectPath: string,
    forceReindex: boolean,
    warmCache: boolean,
    warmupQueries?: string[]
  ): Promise<void> {
    const startTime = Date.now();

    try {
      indexJobTracker.updateStatus(jobId, "running");

      logger.info("Starting project indexing via ETL Pipeline", {
        jobId,
        projectPath,
        projectId,
        forceReindex,
        warmCache,
      });

      // ETL Pipeline: discover → parse → resolve → load
      // EventBus integration handles progress updates and WorkspaceManager status
      const etlResult = await etlPipeline.run({
        projectId,
        projectPath,
        jobId,
        forceReindex,
      });

      const duration = Date.now() - startTime;

      logger.info("ETL Pipeline completed", {
        jobId,
        projectId,
        duration,
        filesIndexed: etlResult.filesIndexed,
        filesSkipped: etlResult.filesSkipped,
        chunksIndexed: etlResult.chunksIndexed,
        symbolsIndexed: etlResult.symbolsIndexed,
        errors: etlResult.errors,
        stageTimings: etlResult.stageTimings,
      });

      // Warmup semantic search cache if requested (unchanged from before)
      if (warmCache) {
        logger.info("Starting cache warmup", { jobId, projectId });
        const warmupStats = await this.contextualSearch.warmupCache(
          projectId,
          projectPath,
          warmupQueries
        );
        logger.info("Cache warmup completed", { jobId, projectId, ...warmupStats });
      }

      // Mark job complete
      indexJobTracker.setResult(jobId, {
        filesIndexed: etlResult.filesIndexed,
        chunksIndexed: etlResult.chunksIndexed,
        errors: etlResult.errors,
        duration,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error("Project indexing failed", error as Error, {
        jobId,
        projectPath,
        projectId,
        duration,
      });

      indexJobTracker.setResult(
        jobId,
        {
          filesIndexed: 0,
          chunksIndexed: 0,
          errors: 1,
          duration,
        },
        (error as Error).message
      );
    }
  }
}
