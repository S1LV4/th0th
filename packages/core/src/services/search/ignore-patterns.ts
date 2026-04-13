/**
 * Shared ignore patterns for project file scanning.
 * Single source of truth used by DiscoverStage, ContextualSearchRLM, and IndexManager.
 */

import fs from "fs/promises";
import path from "path";
import ignoreModule, { type Ignore } from "ignore";
import { logger } from "@th0th-ai/shared";

const ignore = (ignoreModule as unknown as { default: typeof ignoreModule }).default ?? ignoreModule;

export const DEFAULT_EXTENSIONS = [".ts", ".js", ".tsx", ".jsx", ".dart", ".py"];

export const DEFAULT_IGNORES = [
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

/**
 * Load .gitignore rules merged with default ignores.
 */
export async function loadProjectIgnore(projectPath: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(DEFAULT_IGNORES);

  try {
    const gitignorePath = path.join(projectPath, ".gitignore");
    const gitignoreContent = await fs.readFile(gitignorePath, "utf8");

    const rules = gitignoreContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    ig.add(rules);

    logger.debug("Loaded .gitignore", {
      projectPath,
      rulesCount: rules.length,
    });
  } catch {
    logger.debug("No .gitignore found, using defaults only", { projectPath });
  }

  return ig;
}
