/**
 * Checkpoint Manager
 *
 * CRUD operations for task checkpoints in SQLite.
 * Serializes task state as gzip-compressed JSON blobs.
 *
 * Follows the same singleton + raw-SQLite pattern as GraphStore.
 */

import { Database } from "bun:sqlite";
import path from "path";
import fs from "fs";
import {
  TaskCheckpoint,
  TaskState,
  CheckpointType,
  RestoreResult,
  config,
  logger,
} from "@th0th/shared";

// ── Internal row type ────────────────────────────────────────

interface CheckpointRow {
  id: string;
  task_id: string;
  task_description: string | null;
  agent_id: string | null;
  project_id: string | null;
  state: Buffer;
  state_schema_version: number;
  memory_ids: string | null;
  file_changes: string | null;
  checkpoint_type: string;
  parent_checkpoint_id: string | null;
  created_at: number;
  expires_at: number | null;
}

// ── Implementation ───────────────────────────────────────────

export class CheckpointManager {
  private db!: Database;
  private static instance: CheckpointManager | null = null;

  static getInstance(): CheckpointManager {
    if (!CheckpointManager.instance) {
      CheckpointManager.instance = new CheckpointManager();
    }
    return CheckpointManager.instance;
  }

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    const dataDir = config.get("dataDir") as string;
    const dbPath = path.join(dataDir, "memories.db");

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec("PRAGMA journal_mode = WAL");

    this.createSchema();
    logger.info("CheckpointManager initialized");
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_description TEXT,
        agent_id TEXT,
        project_id TEXT,
        state BLOB NOT NULL,
        state_schema_version INTEGER DEFAULT 1,
        memory_ids TEXT,
        file_changes TEXT,
        checkpoint_type TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON task_checkpoints(task_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON task_checkpoints(project_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_created ON task_checkpoints(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_type ON task_checkpoints(checkpoint_type);
    `);
  }

  // ── Create ───────────────────────────────────────────────

  /**
   * Create a new checkpoint.
   *
   * State is gzip-compressed to minimize storage. Typical compression
   * ratios are 5-10x for JSON task state.
   */
  createCheckpoint(
    state: TaskState,
    options: {
      agentId?: string;
      projectId?: string;
      checkpointType?: CheckpointType;
      memoryIds?: string[];
      fileChanges?: string[];
      parentCheckpointId?: string;
      /** TTL in milliseconds (default: 7 days) */
      ttlMs?: number;
    } = {},
  ): TaskCheckpoint {
    const {
      agentId,
      projectId,
      checkpointType = CheckpointType.MANUAL,
      memoryIds = [],
      fileChanges = [],
      parentCheckpointId,
      ttlMs = 7 * 24 * 60 * 60 * 1000, // 7 days
    } = options;

    const id = this.generateId(checkpointType);
    const now = Date.now();
    const expiresAt = now + ttlMs;

    // Serialize and compress state
    const stateJson = JSON.stringify(state);
    const compressed = this.compress(stateJson);

    this.db
      .prepare(
        `
        INSERT INTO task_checkpoints (
          id, task_id, task_description, agent_id, project_id,
          state, state_schema_version,
          memory_ids, file_changes,
          checkpoint_type, parent_checkpoint_id,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        state.taskId,
        state.description || null,
        agentId || null,
        projectId || null,
        compressed,
        1,
        JSON.stringify(memoryIds),
        JSON.stringify(fileChanges),
        checkpointType,
        parentCheckpointId || null,
        now,
        expiresAt,
      );

    const checkpoint: TaskCheckpoint = {
      id,
      taskId: state.taskId,
      taskDescription: state.description,
      agentId,
      projectId,
      state,
      memoryIds,
      fileChanges,
      checkpointType,
      parentCheckpointId,
      createdAt: now,
      expiresAt,
    };

    logger.info("Checkpoint created", {
      id,
      taskId: state.taskId,
      type: checkpointType,
      compressedBytes: compressed.byteLength,
      originalBytes: stateJson.length,
    });

    return checkpoint;
  }

  // ── Read ─────────────────────────────────────────────────

  /**
   * Get a checkpoint by ID.
   */
  getCheckpoint(checkpointId: string): TaskCheckpoint | null {
    const row = this.db
      .prepare("SELECT * FROM task_checkpoints WHERE id = ?")
      .get(checkpointId) as CheckpointRow | null;

    return row ? this.rowToCheckpoint(row) : null;
  }

  /**
   * List checkpoints with optional filters.
   */
  listCheckpoints(options: {
    taskId?: string;
    projectId?: string;
    checkpointType?: CheckpointType;
    includeExpired?: boolean;
    limit?: number;
    offset?: number;
  } = {}): TaskCheckpoint[] {
    const {
      taskId,
      projectId,
      checkpointType,
      includeExpired = false,
      limit = 20,
      offset = 0,
    } = options;

    const conditions: string[] = [];
    const params: any[] = [];

    if (taskId) {
      conditions.push("task_id = ?");
      params.push(taskId);
    }

    if (projectId) {
      conditions.push("project_id = ?");
      params.push(projectId);
    }

    if (checkpointType) {
      conditions.push("checkpoint_type = ?");
      params.push(checkpointType);
    }

    if (!includeExpired) {
      conditions.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(Date.now());
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    params.push(limit, offset);

    const rows = this.db
      .prepare(
        `
        SELECT * FROM task_checkpoints
        ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params) as CheckpointRow[];

    return rows.map((r) => this.rowToCheckpoint(r));
  }

  /**
   * Get the latest checkpoint for a task.
   */
  getLatestCheckpoint(taskId: string): TaskCheckpoint | null {
    const row = this.db
      .prepare(
        `
        SELECT * FROM task_checkpoints
        WHERE task_id = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC
        LIMIT 1
      `,
      )
      .get(taskId, Date.now()) as CheckpointRow | null;

    return row ? this.rowToCheckpoint(row) : null;
  }

  // ── Restore ──────────────────────────────────────────────

  /**
   * Restore a checkpoint, verifying memory and file integrity.
   */
  restoreCheckpoint(checkpointId: string): RestoreResult | null {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) return null;

    // Check which referenced memories still exist
    const validMemoryIds: string[] = [];
    const missingMemoryIds: string[] = [];

    if (checkpoint.memoryIds.length > 0) {
      const placeholders = checkpoint.memoryIds.map(() => "?").join(",");
      const existingRows = this.db
        .prepare(
          `SELECT id FROM memories WHERE id IN (${placeholders})`,
        )
        .all(...checkpoint.memoryIds) as Array<{ id: string }>;

      const existingSet = new Set(existingRows.map((r) => r.id));
      for (const mid of checkpoint.memoryIds) {
        if (existingSet.has(mid)) {
          validMemoryIds.push(mid);
        } else {
          missingMemoryIds.push(mid);
        }
      }
    }

    // Check for file conflicts (files that changed since checkpoint)
    const fileConflicts: string[] = [];
    for (const filePath of checkpoint.fileChanges) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > checkpoint.createdAt) {
          fileConflicts.push(filePath);
        }
      } catch {
        // File no longer exists — also a conflict
        fileConflicts.push(filePath);
      }
    }

    // Generate restore instructions
    const restoreInstructions = this.generateRestoreInstructions(
      checkpoint,
      validMemoryIds,
      missingMemoryIds,
      fileConflicts,
    );

    logger.info("Checkpoint restored", {
      checkpointId,
      taskId: checkpoint.taskId,
      validMemories: validMemoryIds.length,
      missingMemories: missingMemoryIds.length,
      fileConflicts: fileConflicts.length,
    });

    return {
      checkpoint,
      validMemoryIds,
      missingMemoryIds,
      fileConflicts,
      restoreInstructions,
    };
  }

  // ── Delete / Cleanup ─────────────────────────────────────

  /**
   * Delete a checkpoint by ID.
   */
  deleteCheckpoint(checkpointId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM task_checkpoints WHERE id = ?")
      .run(checkpointId);
    return (result as any).changes > 0;
  }

  /**
   * Purge expired checkpoints.
   */
  purgeExpired(): number {
    const result = this.db
      .prepare(
        "DELETE FROM task_checkpoints WHERE expires_at IS NOT NULL AND expires_at < ?",
      )
      .run(Date.now());
    const count = (result as any).changes ?? 0;

    if (count > 0) {
      logger.info("Expired checkpoints purged", { count });
    }

    return count;
  }

  // ── Stats ────────────────────────────────────────────────

  getStats(): {
    totalCheckpoints: number;
    byType: Record<string, number>;
    totalSizeBytes: number;
    oldestCheckpointAge?: number;
  } {
    const total = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM task_checkpoints")
        .get() as { count: number }
    ).count;

    const byType = this.db
      .prepare(
        "SELECT checkpoint_type, COUNT(*) as count FROM task_checkpoints GROUP BY checkpoint_type",
      )
      .all() as Array<{ checkpoint_type: string; count: number }>;

    const sizeRow = this.db
      .prepare(
        "SELECT SUM(LENGTH(state)) as total_size FROM task_checkpoints",
      )
      .get() as { total_size: number | null };

    const oldestRow = this.db
      .prepare(
        "SELECT MIN(created_at) as oldest FROM task_checkpoints",
      )
      .get() as { oldest: number | null };

    const typeMap: Record<string, number> = {};
    for (const row of byType) {
      typeMap[row.checkpoint_type] = row.count;
    }

    return {
      totalCheckpoints: total,
      byType: typeMap,
      totalSizeBytes: sizeRow.total_size ?? 0,
      oldestCheckpointAge: oldestRow.oldest
        ? Date.now() - oldestRow.oldest
        : undefined,
    };
  }

  // ── Private helpers ──────────────────────────────────────

  private compress(json: string): Buffer {
    const input = Buffer.from(json, "utf-8");
    const deflated = Bun.deflateSync(input);
    return Buffer.from(deflated);
  }

  private decompress(data: Buffer): string {
    const inflated = Bun.inflateSync(new Uint8Array(data));
    return Buffer.from(inflated).toString("utf-8");
  }

  private rowToCheckpoint(row: CheckpointRow): TaskCheckpoint {
    const stateJson = this.decompress(
      row.state instanceof Buffer ? row.state : Buffer.from(row.state),
    );
    const state: TaskState = JSON.parse(stateJson);

    return {
      id: row.id,
      taskId: row.task_id,
      taskDescription: row.task_description ?? undefined,
      agentId: row.agent_id ?? undefined,
      projectId: row.project_id ?? undefined,
      state,
      memoryIds: row.memory_ids ? JSON.parse(row.memory_ids) : [],
      fileChanges: row.file_changes ? JSON.parse(row.file_changes) : [],
      checkpointType: row.checkpoint_type as CheckpointType,
      parentCheckpointId: row.parent_checkpoint_id ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  private generateRestoreInstructions(
    checkpoint: TaskCheckpoint,
    validMemoryIds: string[],
    missingMemoryIds: string[],
    fileConflicts: string[],
  ): string {
    const lines: string[] = [];
    const state = checkpoint.state;

    lines.push(`## Checkpoint Restore: ${state.description}`);
    lines.push(`Task ID: ${state.taskId}`);
    lines.push(
      `Status at checkpoint: ${state.status} (${state.progress.percentage}% complete)`,
    );
    lines.push(`Current step: ${state.progress.currentStep}`);

    if (state.agentState.nextAction) {
      lines.push(`\n### Next Action\n${state.agentState.nextAction}`);
    }

    if (state.agentState.pendingValidations.length > 0) {
      lines.push(`\n### Pending Validations`);
      for (const v of state.agentState.pendingValidations) {
        lines.push(`- ${v}`);
      }
    }

    if (state.context.decisions.length > 0) {
      lines.push(
        `\n### Decisions Made (${validMemoryIds.length}/${state.context.decisions.length} memories available)`,
      );
    }

    if (missingMemoryIds.length > 0) {
      lines.push(
        `\n### Warning: ${missingMemoryIds.length} referenced memories no longer exist`,
      );
    }

    if (fileConflicts.length > 0) {
      lines.push(
        `\n### File Conflicts (${fileConflicts.length} files changed since checkpoint)`,
      );
      for (const f of fileConflicts) {
        lines.push(`- ${f}`);
      }
    }

    if (state.context.errors.length > 0) {
      lines.push(`\n### Previous Errors (${state.context.errors.length})`);
      for (const err of state.context.errors.slice(-3)) {
        lines.push(`- ${err.message} (step: ${err.step ?? "unknown"})`);
      }
    }

    if (state.context.learnings.length > 0) {
      lines.push(`\n### Learnings`);
      for (const l of state.context.learnings) {
        lines.push(`- ${l}`);
      }
    }

    return lines.join("\n");
  }

  private generateId(type: CheckpointType): string {
    return `ckpt_${type}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  close(): void {
    this.db?.close();
    CheckpointManager.instance = null;
  }
}
