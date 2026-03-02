/**
 * Create Checkpoint Tool
 *
 * MCP tool for creating task checkpoints (manual or milestone).
 * Thin layer — delegates to CheckpointManager service.
 */

import { IToolHandler, ToolResponse, TaskState, TaskStatus, CheckpointType } from "@th0th/shared";
import { logger } from "@th0th/shared";
import { encode as toTOON } from "@toon-format/toon";
import { CheckpointManager } from "../services/checkpoint/checkpoint-manager.js";

interface CreateCheckpointParams {
  taskId: string;
  description: string;
  status?: TaskStatus;
  /** Current step name */
  currentStep?: string;
  /** Progress 0-100 */
  progressPercent?: number;
  /** Total steps */
  totalSteps?: number;
  /** Completed steps */
  completedSteps?: number;
  /** Type: manual (default) or milestone */
  checkpointType?: "manual" | "milestone";
  /** Agent ID */
  agentId?: string;
  /** Project ID */
  projectId?: string;
  /** Memory IDs related to this task */
  memoryIds?: string[];
  /** Files modified during this task */
  fileChanges?: string[];
  /** Key decisions made */
  decisions?: string[];
  /** Learnings or insights */
  learnings?: string[];
  /** Next action to take after restore */
  nextAction?: string;
  /** Pending validations */
  pendingValidations?: string[];
  format?: "json" | "toon";
}

export class CreateCheckpointTool implements IToolHandler {
  name = "create_checkpoint";
  description =
    "Create a checkpoint to save current task progress. Useful for long-running tasks to enable resumption.";
  inputSchema = {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Unique identifier for the task being checkpointed",
      },
      description: {
        type: "string",
        description: "Human-readable description of the task",
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "failed", "paused"],
        description: "Current task status",
        default: "in_progress",
      },
      currentStep: {
        type: "string",
        description: "Name of the current step being worked on",
      },
      progressPercent: {
        type: "number",
        description: "Overall progress percentage (0-100)",
        default: 0,
      },
      totalSteps: {
        type: "number",
        description: "Total number of steps in the task",
        default: 0,
      },
      completedSteps: {
        type: "number",
        description: "Number of steps completed so far",
        default: 0,
      },
      checkpointType: {
        type: "string",
        enum: ["manual", "milestone"],
        description: "Type of checkpoint (milestone checkpoints have longer TTL)",
        default: "manual",
      },
      agentId: {
        type: "string",
        description: "Agent creating the checkpoint",
      },
      projectId: {
        type: "string",
        description: "Project ID",
      },
      memoryIds: {
        type: "array",
        items: { type: "string" },
        description: "Memory IDs related to this task",
      },
      fileChanges: {
        type: "array",
        items: { type: "string" },
        description: "File paths modified during this task",
      },
      decisions: {
        type: "array",
        items: { type: "string" },
        description: "Memory IDs of decisions made",
      },
      learnings: {
        type: "array",
        items: { type: "string" },
        description: "Key learnings or insights from the task",
      },
      nextAction: {
        type: "string",
        description: "The next action to take when restoring this checkpoint",
      },
      pendingValidations: {
        type: "array",
        items: { type: "string" },
        description: "Validations still pending",
      },
      format: {
        type: "string",
        enum: ["json", "toon"],
        description: "Output format",
        default: "toon",
      },
    },
    required: ["taskId", "description"],
  };

  private checkpointManager: CheckpointManager;

  constructor() {
    this.checkpointManager = CheckpointManager.getInstance();
  }

  async handle(params: unknown): Promise<ToolResponse> {
    const {
      taskId,
      description,
      status = TaskStatus.IN_PROGRESS,
      currentStep = "",
      progressPercent = 0,
      totalSteps = 0,
      completedSteps = 0,
      checkpointType = "manual",
      agentId,
      projectId,
      memoryIds = [],
      fileChanges = [],
      decisions = [],
      learnings = [],
      nextAction,
      pendingValidations = [],
      format = "toon",
    } = params as CreateCheckpointParams;

    try {
      const state: TaskState = {
        taskId,
        description,
        status: status as TaskStatus,
        progress: {
          total: totalSteps,
          completed: completedSteps,
          currentStep,
          percentage: progressPercent,
        },
        context: {
          decisions,
          filesRead: [],
          filesModified: fileChanges,
          errors: [],
          learnings,
        },
        agentState: {
          lastAction: currentStep || "checkpoint created",
          nextAction,
          pendingValidations,
        },
        startedAt: Date.now(),
        lastCheckpointAt: Date.now(),
        checkpointCount: 0,
      };

      const checkpoint = this.checkpointManager.createCheckpoint(state, {
        agentId,
        projectId,
        checkpointType:
          checkpointType === "milestone"
            ? CheckpointType.MILESTONE
            : CheckpointType.MANUAL,
        memoryIds,
        fileChanges,
      });

      logger.info("Checkpoint tool: created", {
        checkpointId: checkpoint.id,
        taskId,
        type: checkpointType,
      });

      const responseData = {
        checkpointId: checkpoint.id,
        taskId,
        type: checkpointType,
        createdAt: checkpoint.createdAt,
        expiresAt: checkpoint.expiresAt,
      };

      return format === "toon"
        ? { success: true, data: toTOON(responseData) }
        : { success: true, data: responseData };
    } catch (error) {
      logger.error("Failed to create checkpoint", error as Error, { taskId });
      return {
        success: false,
        error: `Failed to create checkpoint: ${(error as Error).message}`,
      };
    }
  }
}
