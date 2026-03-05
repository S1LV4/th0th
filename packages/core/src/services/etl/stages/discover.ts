/**
 * ETL Stage 1 — Discover
 *
 * Scans the project directory for indexable files.
 * Computes SHA-256 content hashes and compares against stored hashes
 * to skip files that haven't changed (fingerprint cache).
 *
 * Output order: high-centrality + recently-modified files first,
 * so the Load stage populates the most important context earliest.
 */

import { glob } from "glob";
import ignoreModule, { type Ignore } from "ignore";
import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { config, logger } from "@th0th-ai/shared";
import { symbolRepository } from "../../../data/sqlite/symbol-repository.js";
import type { EtlStageContext, DiscoveredFile } from "../stage-context.js";

const ignore = (ignoreModule as unknown as { default: typeof ignoreModule }).default ?? ignoreModule;

const DEFAULT_EXTENSIONS = [".ts", ".js", ".tsx", ".jsx", ".dart", ".py"];

const DEFAULT_IGNORES = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  "coverage/**",
  "*.db",
  "*.db-shm",
  "*.db-wal",
  ".env",
  ".env.*",
  "**/generated/**",
  "**/*.generated.*",
  "**/*.d.ts",
  "**/*.wasm*",
  "**/*.min.*",
  "**/*.map",
  "**/lock.yaml",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/bun.lockb",
  "**/yarn.lock",
];

export class DiscoverStage {
  /**
   * Run the discovery stage.
   *
   * @param ctx - Stage execution context (projectId, projectPath, jobId, emit)
   * @param opts.forceReindex - When true, marks all files as needsReparse=true
   * @param opts.filesToProcess - Explicit list of relative paths for incremental reindex
   */
  async run(
    ctx: EtlStageContext,
    opts: {
      forceReindex?: boolean;
      filesToProcess?: string[];
    } = {},
  ): Promise<DiscoveredFile[]> {
    const t0 = performance.now();

    ctx.emit({
      type: "stage_start",
      stage: "discover",
      payload: { projectId: ctx.projectId, projectPath: ctx.projectPath },
      timestamp: Date.now(),
    });

    const ig = await this.loadIgnore(ctx.projectPath);
    const allowedExts: string[] =
      (config.get("security") as Record<string, unknown>).allowedExtensions as string[] ??
      DEFAULT_EXTENSIONS;

    let relPaths: string[];

    if (opts.filesToProcess && opts.filesToProcess.length > 0) {
      relPaths = opts.filesToProcess;
    } else {
      const pattern = `**/*{${allowedExts.join(",")}}`;
      const found = await glob(pattern, {
        cwd: ctx.projectPath,
        nodir: true,
        dot: false,
        absolute: false,
      });
      relPaths = found.filter((p) => !ig.ignores(p));
    }

    // Load stored centrality scores for priority ordering
    const centralityMap = symbolRepository.getCentrality(ctx.projectId);

    // Process files and compute fingerprints in parallel (batches of 30)
    const discovered: DiscoveredFile[] = [];
    const BATCH = 30;

    for (let i = 0; i < relPaths.length; i += BATCH) {
      const batch = relPaths.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map((rel) => this.processFile(ctx, rel, opts.forceReindex ?? false)),
      );
      for (const f of results) {
        if (f) discovered.push(f);
      }

      ctx.emit({
        type: "progress",
        stage: "discover",
        payload: {
          current: Math.min(i + BATCH, relPaths.length),
          total: relPaths.length,
          percentage: Math.round((Math.min(i + BATCH, relPaths.length) / relPaths.length) * 100),
        },
        timestamp: Date.now(),
      });
    }

    // Sort: centrality desc → mtime desc → path asc
    discovered.sort((a, b) => {
      const ca = centralityMap.get(a.relativePath) ?? 0;
      const cb = centralityMap.get(b.relativePath) ?? 0;
      if (cb !== ca) return cb - ca;
      if (b.mtime !== a.mtime) return b.mtime - a.mtime;
      return a.relativePath.localeCompare(b.relativePath);
    });

    const durationMs = Math.round(performance.now() - t0);

    ctx.emit({
      type: "stage_end",
      stage: "discover",
      payload: {
        total: discovered.length,
        needsReparse: discovered.filter((f) => f.needsReparse).length,
        skipped: discovered.filter((f) => !f.needsReparse).length,
        durationMs,
      },
      timestamp: Date.now(),
    });

    logger.info("ETL Discover complete", {
      projectId: ctx.projectId,
      total: discovered.length,
      needsReparse: discovered.filter((f) => f.needsReparse).length,
      durationMs,
    });

    return discovered;
  }

  private async processFile(
    ctx: EtlStageContext,
    relativePath: string,
    forceReindex: boolean,
  ): Promise<DiscoveredFile | null> {
    const absolutePath = path.join(ctx.projectPath, relativePath);

    try {
      const stat = await fs.stat(absolutePath);
      const content = await fs.readFile(absolutePath, "utf-8");
      const contentHash = createHash("sha256").update(content).digest("hex");

      let needsReparse = forceReindex;

      if (!forceReindex) {
        const stored = symbolRepository.getFile(ctx.projectId, relativePath);
        needsReparse = !stored || stored.content_hash !== contentHash;
      }

      return {
        absolutePath,
        relativePath,
        mtime: stat.mtimeMs,
        size: stat.size,
        contentHash,
        needsReparse,
      };
    } catch (err) {
      logger.warn("DiscoverStage: failed to stat/read file", {
        relativePath,
        error: (err as Error).message,
      });
      return null;
    }
  }

  private async loadIgnore(projectPath: string): Promise<Ignore> {
    const ig = ignore();
    ig.add(DEFAULT_IGNORES);

    try {
      const content = await fs.readFile(path.join(projectPath, ".gitignore"), "utf-8");
      const rules = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      ig.add(rules);
    } catch {
      // no .gitignore — use defaults only
    }

    return ig;
  }
}
