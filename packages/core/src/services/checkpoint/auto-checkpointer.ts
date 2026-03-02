/**
 * Auto Checkpointer
 *
 * Tracks operation count and automatically creates checkpoints
 * at configurable intervals, on errors, or on milestones.
 *
 * Agents call `recordOperation()` after each significant action.
 * The checkpointer decides when to snapshot based on:
 * - Operation count threshold (default: every 10 ops)
 * - Error events (immediate checkpoint on failure)
 * - Milestone markers (explicit "save now" signal)
 *
 * This is a thin coordination layer over CheckpointManager.
 */

import {
  TaskState,
  TaskCheckpoint,
  CheckpointType,
  TaskStatus,
  logger,
} from "@th0th/shared";
import { CheckpointManager } from "./checkpoint-manager.js";

export type CheckpointTrigger = "operation" | "error" | "milestone";

export interface AutoCheckpointerOptions {
  /** Create checkpoint every N operations (default: 10) */
  operationInterval?: number;
  /** Agent ID for labeling checkpoints */
  agentId?: string;
  /** Project ID for labeling checkpoints */
  projectId?: string;
  /** TTL for auto-checkpoints in ms (default: 3 days) */
  autoTtlMs?: number;
  /** TTL for milestone checkpoints in ms (default: 14 days) */
  milestoneTtlMs?: number;
}

const DEFAULT_OPTIONS: Required<AutoCheckpointerOptions> = {
  operationInterval: 10,
  agentId: "",
  projectId: "",
  autoTtlMs: 3 * 24 * 60 * 60 * 1000, // 3 days
  milestoneTtlMs: 14 * 24 * 60 * 60 * 1000, // 14 days
};

export class AutoCheckpointer {
  private operationCount = 0;
  private lastCheckpointId: string | null = null;
  private checkpointManager: CheckpointManager;
  private options: Required<AutoCheckpointerOptions>;
  private static instance: AutoCheckpointer | null = null;

  static getInstance(
    options?: AutoCheckpointerOptions,
  ): AutoCheckpointer {
    if (!AutoCheckpointer.instance) {
      AutoCheckpointer.instance = new AutoCheckpointer(options);
    }
    return AutoCheckpointer.instance;
  }

  constructor(options?: AutoCheckpointerOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.checkpointManager = CheckpointManager.getInstance();
  }

  /**
   * Record an operation and maybe create a checkpoint.
   *
   * Call this from tools (store_memory, search_memories, etc.)
   * after each significant action.
   *
   * @returns The checkpoint if one was created, null otherwise.
   */
  recordOperation(
    state: TaskState,
    trigger: CheckpointTrigger = "operation",
  ): TaskCheckpoint | null {
    this.operationCount++;

    const shouldCheckpoint =
      trigger === "milestone" ||
      trigger === "error" ||
      (trigger === "operation" &&
        this.operationCount >= this.options.operationInterval);

    if (!shouldCheckpoint) return null;

    return this.createCheckpoint(state, trigger);
  }

  /**
   * Force-create a milestone checkpoint.
   */
  markMilestone(state: TaskState): TaskCheckpoint {
    return this.createCheckpoint(state, "milestone");
  }

  /**
   * Force-create an error checkpoint.
   */
  markError(state: TaskState, error: Error): TaskCheckpoint {
    // Record the error in state context
    const updatedState: TaskState = {
      ...state,
      context: {
        ...state.context,
        errors: [
          ...state.context.errors,
          {
            message: error.message,
            timestamp: Date.now(),
            step: state.progress.currentStep,
          },
        ],
      },
    };

    return this.createCheckpoint(updatedState, "error");
  }

  /**
   * Get the ID of the last created checkpoint.
   */
  getLastCheckpointId(): string | null {
    return this.lastCheckpointId;
  }

  /**
   * Get current operation count since last checkpoint.
   */
  getOperationCount(): number {
    return this.operationCount;
  }

  /**
   * Reset the operation counter (called after manual checkpoint).
   */
  resetCounter(): void {
    this.operationCount = 0;
  }

  // ── Private ──────────────────────────────────────────────

  private createCheckpoint(
    state: TaskState,
    trigger: CheckpointTrigger,
  ): TaskCheckpoint {
    this.operationCount = 0;

    const checkpointType =
      trigger === "milestone"
        ? CheckpointType.MILESTONE
        : trigger === "error"
          ? CheckpointType.MANUAL // errors get manual type for longer TTL
          : CheckpointType.AUTO;

    const ttlMs =
      checkpointType === CheckpointType.AUTO
        ? this.options.autoTtlMs
        : this.options.milestoneTtlMs;

    // Update state's checkpoint metadata
    const finalState: TaskState = {
      ...state,
      lastCheckpointAt: Date.now(),
      checkpointCount: state.checkpointCount + 1,
    };

    const checkpoint = this.checkpointManager.createCheckpoint(finalState, {
      agentId: this.options.agentId || undefined,
      projectId: this.options.projectId || undefined,
      checkpointType,
      memoryIds: state.context.decisions,
      fileChanges: state.context.filesModified,
      parentCheckpointId: this.lastCheckpointId ?? undefined,
      ttlMs,
    });

    this.lastCheckpointId = checkpoint.id;

    logger.info("AutoCheckpointer: checkpoint created", {
      checkpointId: checkpoint.id,
      trigger,
      type: checkpointType,
      taskId: state.taskId,
      operationsSinceLastCheckpoint: this.operationCount,
    });

    return checkpoint;
  }

  close(): void {
    AutoCheckpointer.instance = null;
  }
}
