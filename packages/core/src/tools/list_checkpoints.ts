/**
 * List Checkpoints Tool
 *
 * MCP tool for listing saved task checkpoints.
 * Supports filtering by task, project, type, and expiry.
 *
 * Thin layer — delegates to CheckpointManager service.
 */

import { IToolHandler, ToolResponse, CheckpointType } from "@th0th/shared";
import { logger } from "@th0th/shared";
import { encode as toTOON } from "@toon-format/toon";
import { CheckpointManager } from "../services/checkpoint/checkpoint-manager.js";

interface ListCheckpointsParams {
  taskId?: string;
  projectId?: string;
  checkpointType?: "auto" | "manual" | "milestone";
  includeExpired?: boolean;
  limit?: number;
  format?: "json" | "toon";
}

export class ListCheckpointsTool implements IToolHandler {
  name = "list_checkpoints";
  description =
    "List saved task checkpoints. Filter by task ID, project, or type.";
  inputSchema = {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Filter by task ID",
      },
      projectId: {
        type: "string",
        description: "Filter by project ID",
      },
      checkpointType: {
        type: "string",
        enum: ["auto", "manual", "milestone"],
        description: "Filter by checkpoint type",
      },
      includeExpired: {
        type: "boolean",
        description: "Include expired checkpoints",
        default: false,
      },
      limit: {
        type: "number",
        description: "Max results to return",
        default: 10,
      },
      format: {
        type: "string",
        enum: ["json", "toon"],
        description: "Output format",
        default: "toon",
      },
    },
    required: [],
  };

  private checkpointManager: CheckpointManager;

  constructor() {
    this.checkpointManager = CheckpointManager.getInstance();
  }

  async handle(params: unknown): Promise<ToolResponse> {
    const {
      taskId,
      projectId,
      checkpointType,
      includeExpired = false,
      limit = 10,
      format = "toon",
    } = params as ListCheckpointsParams;

    try {
      const checkpoints = this.checkpointManager.listCheckpoints({
        taskId,
        projectId,
        checkpointType: checkpointType as CheckpointType | undefined,
        includeExpired,
        limit,
      });

      const stats = this.checkpointManager.getStats();

      const items = checkpoints.map((cp) => ({
        id: cp.id,
        taskId: cp.taskId,
        description: cp.state.description,
        status: cp.state.status,
        progress: `${cp.state.progress.percentage}%`,
        currentStep: cp.state.progress.currentStep,
        type: cp.checkpointType,
        agentId: cp.agentId,
        createdAt: cp.createdAt,
        expiresAt: cp.expiresAt,
        memoriesCount: cp.memoryIds.length,
        filesCount: cp.fileChanges.length,
      }));

      logger.info("Checkpoint tool: listed", {
        count: items.length,
        taskId,
        projectId,
      });

      const responseData = {
        checkpoints: items,
        total: stats.totalCheckpoints,
        stats: {
          byType: stats.byType,
          totalSizeBytes: stats.totalSizeBytes,
        },
      };

      return format === "toon"
        ? { success: true, data: toTOON(responseData) }
        : { success: true, data: responseData };
    } catch (error) {
      logger.error("Failed to list checkpoints", error as Error);
      return {
        success: false,
        error: `Failed to list checkpoints: ${(error as Error).message}`,
      };
    }
  }
}
