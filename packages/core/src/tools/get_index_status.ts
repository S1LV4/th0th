/**
 * Get Index Status Tool
 *
 * Queries the status and progress of an async indexing job.
 */

import { IToolHandler } from "@th0th-ai/shared";
import { ToolResponse } from "@th0th-ai/shared";
import { indexJobTracker } from "../services/jobs/index-job-tracker.js";
import { logger } from "@th0th-ai/shared";

interface GetIndexStatusParams {
  jobId: string;
}

export class GetIndexStatusTool implements IToolHandler {
  name = "get_index_status";
  description =
    "Get the status and progress of an async indexing job started with th0th_index";
  inputSchema = {
    type: "object",
    properties: {
      jobId: {
        type: "string",
        description: "Job ID returned by th0th_index",
      },
    },
    required: ["jobId"],
  };

  async handle(params: unknown): Promise<ToolResponse> {
    const { jobId } = params as GetIndexStatusParams;

    try {
      const job = indexJobTracker.getJob(jobId);

      if (!job) {
        return {
          success: false,
          error: `Job not found: ${jobId}`,
        };
      }

      // Calcula elapsed time
      const elapsed = job.completedAt
        ? job.completedAt.getTime() - job.createdAt.getTime()
        : Date.now() - job.createdAt.getTime();

      return {
        success: true,
        data: {
          jobId: job.jobId,
          projectId: job.projectId,
          projectPath: job.projectPath,
          status: job.status,
          progress: job.progress,
          result: job.result,
          error: job.error,
          elapsedMs: elapsed,
          createdAt: job.createdAt.toISOString(),
          startedAt: job.startedAt?.toISOString(),
          completedAt: job.completedAt?.toISOString(),
        },
      };
    } catch (error) {
      logger.error("Failed to get index status", error as Error, { jobId });

      return {
        success: false,
        error: `Failed to get status: ${(error as Error).message}`,
      };
    }
  }
}
