/**
 * Unit tests for CheckpointManager and AutoCheckpointer
 *
 * Uses a real in-memory-like SQLite (via temp dir) to test
 * checkpoint CRUD, compression, restore logic, and auto-checkpointing.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import {
  CheckpointType,
  TaskStatus,
  type TaskState,
} from "@th0th-ai/shared";
import fs from "fs";
import path from "path";
import os from "os";

// ── Mock config and logger ────────────────────────────────────
let tmpDir: string;

mock.module("@th0th-ai/shared", () => {
  const actual = require("@th0th-ai/shared");
  return {
    ...actual,
    CheckpointType: actual.CheckpointType,
    TaskStatus: actual.TaskStatus,
    config: {
      get: (key: string) => {
        if (key === "dataDir") return tmpDir;
        const defaults: Record<string, any> = {
          vectorStore: { type: "sqlite", dbPath: "/tmp/th0th-test-vs.db", collectionName: "test", embeddingModel: "default" },
          keywordSearch: { dbPath: "/tmp/th0th-test-kw.db", ftsVersion: "fts5" },
          cache: { l1: { maxSize: 1024, defaultTTL: 60 }, l2: { dbPath: "/tmp/th0th-test-cache.db", maxSize: 1024, defaultTTL: 60 }, embedding: { dbPath: "/tmp/th0th-test-emb-cache.db", maxAgeHours: 1 } },
          security: { maxInputLength: 10000, sanitizeInputs: true, maxIndexSize: 1000, maxFileSize: 1048576, allowedExtensions: [".ts"], excludePatterns: [] },
        };
        return defaults[key];
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      metric: () => {},
    },
  };
});

import { CheckpointManager } from "../services/checkpoint/checkpoint-manager.js";
import { AutoCheckpointer } from "../services/checkpoint/auto-checkpointer.js";

// ── Helper: create a valid TaskState ──────────────────────────
function makeTaskState(overrides?: Partial<TaskState>): TaskState {
  return {
    taskId: "task_test_1",
    description: "Test task",
    status: TaskStatus.IN_PROGRESS,
    progress: {
      total: 10,
      completed: 3,
      currentStep: "step 3",
      percentage: 30,
    },
    context: {
      decisions: ["mem_dec_1"],
      filesRead: ["/src/foo.ts"],
      filesModified: [],
      errors: [],
      learnings: ["learned something"],
    },
    agentState: {
      lastAction: "search",
      nextAction: "implement",
      pendingValidations: [],
    },
    startedAt: Date.now() - 60000,
    lastCheckpointAt: 0,
    checkpointCount: 0,
    ...overrides,
  };
}

// ── CheckpointManager tests ──────────────────────────────────

describe("CheckpointManager", () => {
  let manager: CheckpointManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "th0th-test-ckpt-"));
    (CheckpointManager as any).instance = null;
    manager = new CheckpointManager();
  });

  afterEach(() => {
    manager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createCheckpoint", () => {
    test("creates a checkpoint and returns it", () => {
      const state = makeTaskState();
      const ckpt = manager.createCheckpoint(state, {
        agentId: "architect",
        projectId: "proj1",
        checkpointType: CheckpointType.MANUAL,
        memoryIds: ["mem1"],
        fileChanges: ["/src/a.ts"],
      });

      expect(ckpt.id).toStartWith("ckpt_manual_");
      expect(ckpt.taskId).toBe("task_test_1");
      expect(ckpt.agentId).toBe("architect");
      expect(ckpt.projectId).toBe("proj1");
      expect(ckpt.state.description).toBe("Test task");
      expect(ckpt.memoryIds).toEqual(["mem1"]);
      expect(ckpt.fileChanges).toEqual(["/src/a.ts"]);
      expect(ckpt.checkpointType).toBe(CheckpointType.MANUAL);
      expect(ckpt.expiresAt).toBeGreaterThan(Date.now());
    });

    test("compresses state (stored size < JSON size)", () => {
      const state = makeTaskState({
        description: "A".repeat(5000), // Large content
      });
      const ckpt = manager.createCheckpoint(state);

      // Retrieve it to verify decompression works
      const retrieved = manager.getCheckpoint(ckpt.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.state.description).toBe("A".repeat(5000));
    });
  });

  describe("getCheckpoint", () => {
    test("retrieves existing checkpoint", () => {
      const state = makeTaskState();
      const ckpt = manager.createCheckpoint(state);

      const retrieved = manager.getCheckpoint(ckpt.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(ckpt.id);
      expect(retrieved!.state.taskId).toBe("task_test_1");
    });

    test("returns null for non-existent", () => {
      expect(manager.getCheckpoint("nonexistent")).toBeNull();
    });
  });

  describe("listCheckpoints", () => {
    test("lists checkpoints with filters", () => {
      const state1 = makeTaskState({ taskId: "task_A" });
      const state2 = makeTaskState({ taskId: "task_B" });

      manager.createCheckpoint(state1, {
        checkpointType: CheckpointType.AUTO,
      });
      manager.createCheckpoint(state2, {
        checkpointType: CheckpointType.MILESTONE,
      });
      manager.createCheckpoint(state1, {
        checkpointType: CheckpointType.MANUAL,
      });

      // All checkpoints
      const all = manager.listCheckpoints();
      expect(all.length).toBe(3);

      // Filter by taskId
      const taskA = manager.listCheckpoints({ taskId: "task_A" });
      expect(taskA.length).toBe(2);

      // Filter by type
      const milestones = manager.listCheckpoints({
        checkpointType: CheckpointType.MILESTONE,
      });
      expect(milestones.length).toBe(1);
      expect(milestones[0].state.taskId).toBe("task_B");
    });

    test("excludes expired by default", () => {
      const state = makeTaskState();
      manager.createCheckpoint(state, { ttlMs: -1000 }); // Already expired

      const list = manager.listCheckpoints();
      expect(list.length).toBe(0);

      const withExpired = manager.listCheckpoints({ includeExpired: true });
      expect(withExpired.length).toBe(1);
    });
  });

  describe("getLatestCheckpoint", () => {
    test("returns most recent checkpoint for task", async () => {
      const state = makeTaskState();

      manager.createCheckpoint(state, {
        checkpointType: CheckpointType.AUTO,
      });

      // Small delay to ensure different created_at timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const state2 = makeTaskState({
        progress: { ...state.progress, completed: 5, percentage: 50 },
      });
      const latest = manager.createCheckpoint(state2, {
        checkpointType: CheckpointType.MANUAL,
      });

      const retrieved = manager.getLatestCheckpoint("task_test_1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(latest.id);
    });

    test("returns null when no checkpoints exist", () => {
      expect(manager.getLatestCheckpoint("nonexistent")).toBeNull();
    });
  });

  describe("restoreCheckpoint", () => {
    test("restores checkpoint with integrity info", () => {
      // We need to create a memories table for the restore to check
      const { Database } = require("bun:sqlite");
      const db = new Database(path.join(tmpDir, "memories.db"));
      db.exec(
        "CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY)",
      );
      db.prepare("INSERT INTO memories (id) VALUES (?)").run("mem_dec_1");
      db.close();

      const state = makeTaskState();
      const ckpt = manager.createCheckpoint(state, {
        memoryIds: ["mem_dec_1", "mem_missing"],
      });

      const result = manager.restoreCheckpoint(ckpt.id);
      expect(result).not.toBeNull();
      expect(result!.checkpoint.id).toBe(ckpt.id);
      expect(result!.validMemoryIds).toContain("mem_dec_1");
      expect(result!.missingMemoryIds).toContain("mem_missing");
      expect(result!.restoreInstructions).toContain("Test task");
    });

    test("returns null for non-existent checkpoint", () => {
      expect(manager.restoreCheckpoint("nonexistent")).toBeNull();
    });
  });

  describe("deleteCheckpoint", () => {
    test("deletes existing checkpoint", () => {
      const ckpt = manager.createCheckpoint(makeTaskState());
      expect(manager.deleteCheckpoint(ckpt.id)).toBe(true);
      expect(manager.getCheckpoint(ckpt.id)).toBeNull();
    });

    test("returns false for non-existent", () => {
      expect(manager.deleteCheckpoint("nonexistent")).toBe(false);
    });
  });

  describe("purgeExpired", () => {
    test("removes expired checkpoints", () => {
      // Create one expired
      manager.createCheckpoint(makeTaskState(), { ttlMs: -1000 });
      // Create one active
      manager.createCheckpoint(makeTaskState({ taskId: "active" }), {
        ttlMs: 999999999,
      });

      const purged = manager.purgeExpired();
      expect(purged).toBe(1);

      const all = manager.listCheckpoints({ includeExpired: true });
      expect(all.length).toBe(1);
      expect(all[0].state.taskId).toBe("active");
    });
  });

  describe("getStats", () => {
    test("returns correct statistics", () => {
      manager.createCheckpoint(makeTaskState(), {
        checkpointType: CheckpointType.AUTO,
      });
      manager.createCheckpoint(makeTaskState(), {
        checkpointType: CheckpointType.AUTO,
      });
      manager.createCheckpoint(makeTaskState(), {
        checkpointType: CheckpointType.MILESTONE,
      });

      const stats = manager.getStats();
      expect(stats.totalCheckpoints).toBe(3);
      expect(stats.byType[CheckpointType.AUTO]).toBe(2);
      expect(stats.byType[CheckpointType.MILESTONE]).toBe(1);
      expect(stats.totalSizeBytes).toBeGreaterThan(0);
      expect(stats.oldestCheckpointAge).toBeDefined();
    });
  });
});

// ── AutoCheckpointer tests ───────────────────────────────────

describe("AutoCheckpointer", () => {
  let autoCheckpointer: AutoCheckpointer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "th0th-test-autocp-"));
    (CheckpointManager as any).instance = null;
    (AutoCheckpointer as any).instance = null;
    autoCheckpointer = new AutoCheckpointer({
      operationInterval: 3,
      agentId: "test-agent",
    });
  });

  afterEach(() => {
    autoCheckpointer.close();
    (CheckpointManager as any).instance?.close();
    (CheckpointManager as any).instance = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("does not checkpoint below interval", () => {
    const state = makeTaskState();
    const result = autoCheckpointer.recordOperation(state);
    expect(result).toBeNull();
    expect(autoCheckpointer.getOperationCount()).toBe(1);
  });

  test("checkpoints at interval threshold", () => {
    const state = makeTaskState();
    autoCheckpointer.recordOperation(state); // 1
    autoCheckpointer.recordOperation(state); // 2
    const result = autoCheckpointer.recordOperation(state); // 3 = interval

    expect(result).not.toBeNull();
    expect(result!.checkpointType).toBe(CheckpointType.AUTO);
    expect(autoCheckpointer.getOperationCount()).toBe(0); // reset
  });

  test("milestone always creates checkpoint", () => {
    const state = makeTaskState();
    const result = autoCheckpointer.markMilestone(state);

    expect(result).not.toBeNull();
    expect(result!.checkpointType).toBe(CheckpointType.MILESTONE);
  });

  test("error always creates checkpoint with error in state", () => {
    const state = makeTaskState();
    const error = new Error("Something broke");
    const result = autoCheckpointer.markError(state, error);

    expect(result).not.toBeNull();
    // Error checkpoints use MANUAL type for longer TTL
    expect(result!.checkpointType).toBe(CheckpointType.MANUAL);
    expect(result!.state.context.errors).toHaveLength(1);
    expect(result!.state.context.errors[0].message).toBe("Something broke");
  });

  test("getLastCheckpointId tracks latest", () => {
    expect(autoCheckpointer.getLastCheckpointId()).toBeNull();

    const state = makeTaskState();
    const ckpt = autoCheckpointer.markMilestone(state);

    expect(autoCheckpointer.getLastCheckpointId()).toBe(ckpt.id);
  });

  test("resetCounter resets operation count", () => {
    const state = makeTaskState();
    autoCheckpointer.recordOperation(state);
    autoCheckpointer.recordOperation(state);
    expect(autoCheckpointer.getOperationCount()).toBe(2);

    autoCheckpointer.resetCounter();
    expect(autoCheckpointer.getOperationCount()).toBe(0);
  });

  test("error trigger creates checkpoint immediately (ignores interval)", () => {
    const state = makeTaskState();
    const result = autoCheckpointer.recordOperation(state, "error");

    expect(result).not.toBeNull();
    expect(autoCheckpointer.getOperationCount()).toBe(0);
  });

  test("parent checkpoint ID chains", () => {
    const state = makeTaskState();
    const first = autoCheckpointer.markMilestone(state);
    const second = autoCheckpointer.markMilestone(state);

    expect(second.parentCheckpointId).toBe(first.id);
  });
});
