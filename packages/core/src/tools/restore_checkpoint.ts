/**
 * Restore Checkpoint Tool
 *
 * MCP tool for restoring a previously saved task checkpoint.
 * Returns the saved state along with integrity checks
 * (missing memories, file conflicts).
 *
 * Thin layer — delegates to CheckpointManager service.
 */

import { IToolHandler, ToolResponse } from "@th0th/shared";
import { logger } from "@th0th/shared";
import { encode as toTOON } from "@toon-format/toon";
import { CheckpointManager } from "../services/checkpoint/checkpoint-manager.js";

interface RestoreCheckpointParams {
  /** Checkpoint ID to restore */
  checkpointId?: string;
  /** Or restore the latest checkpoint for a task */
  taskId?: string;
  format?: "json" | "toon";
}

export class RestoreCheckpointTool implements IToolHandler {
  name = "restore_checkpoint";
  description =
    "Restore a saved task checkpoint. Returns the full task state, " +
    "integrity checks for referenced memories and files, and " +
    "instructions for resuming the task.";
  inputSchema = {
    type: "object",
    properties: {
      checkpointId: {
        type: "string",
        description: "The checkpoint ID to restore. If omitted, taskId is required.",
      },
      taskId: {
        type: "string",
        description:
          "Task ID to restore the latest checkpoint for. Used when checkpointId is not provided.",
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
      checkpointId,
      taskId,
      format = "toon",
    } = params as RestoreCheckpointParams;

    try {
      if (!checkpointId && !taskId) {
        return {
          success: false,
          error: "Either checkpointId or taskId must be provided",
        };
      }

      // Resolve checkpoint ID
      let resolvedId = checkpointId;
      if (!resolvedId && taskId) {
        const latest = this.checkpointManager.getLatestCheckpoint(taskId);
        if (!latest) {
          return {
            success: false,
            error: `No checkpoints found for task: ${taskId}`,
          };
        }
        resolvedId = latest.id;
      }

      const result = this.checkpointManager.restoreCheckpoint(resolvedId!);
      if (!result) {
        return {
          success: false,
          error: `Checkpoint not found: ${resolvedId}`,
        };
      }

      logger.info("Checkpoint tool: restored", {
        checkpointId: resolvedId,
        taskId: result.checkpoint.taskId,
        validMemories: result.validMemoryIds.length,
        missingMemories: result.missingMemoryIds.length,
        fileConflicts: result.fileConflicts.length,
      });

      const responseData = {
        checkpointId: result.checkpoint.id,
        taskId: result.checkpoint.taskId,
        description: result.checkpoint.state.description,
        status: result.checkpoint.state.status,
        progress: result.checkpoint.state.progress,
        context: result.checkpoint.state.context,
        agentState: result.checkpoint.state.agentState,
        integrity: {
          validMemories: result.validMemoryIds.length,
          missingMemories: result.missingMemoryIds.length,
          fileConflicts: result.fileConflicts,
        },
        restoreInstructions: result.restoreInstructions,
        createdAt: result.checkpoint.createdAt,
      };

      return format === "toon"
        ? { success: true, data: toTOON(responseData) }
        : { success: true, data: responseData };
    } catch (error) {
      logger.error("Failed to restore checkpoint", error as Error, {
        checkpointId,
        taskId,
      });
      return {
        success: false,
        error: `Failed to restore checkpoint: ${(error as Error).message}`,
      };
    }
  }
}
