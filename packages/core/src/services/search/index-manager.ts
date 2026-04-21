/**
 * Index Manager
 *
 * Manages project index lifecycle with:
 * - Staleness detection (checks file mtimes)
 * - Incremental reindexing (only modified files)
 * - Automatic reindexing on search
 */

import fs from "fs";
import path from "path";
import { glob } from "glob";
import { logger, config } from "@th0th-ai/shared";
import type { IVectorStore } from "@th0th-ai/shared";
import { loadProjectIgnore } from "./ignore-patterns.js";

const globAsync = glob;

interface IndexMetadata {
  projectId: string;
  projectPath: string;
  lastIndexed: number; // timestamp
  fileCount: number;
  totalSize: number;
  files: Record<string, FileMetadata>;
}

interface FileMetadata {
  path: string;
  mtime: number;
  size: number;
  hash?: string;
}

interface StaleCheckResult {
  isStale: boolean;
  reason?: string;
  modifiedFiles?: string[];
  newFiles?: string[];
  deletedFiles?: string[];
}

export class IndexManager {
  private metadataCache: Map<string, IndexMetadata> = new Map();
  private vectorStore: IVectorStore;

  constructor(vectorStore: IVectorStore) {
    this.vectorStore = vectorStore;
  }

  /**
   * Check if project index is stale
   */
  async isIndexStale(
    projectId: string,
    projectPath: string,
  ): Promise<StaleCheckResult> {
    try {
      // Get stored metadata
      const metadata = await this.getIndexMetadata(projectId);

      if (!metadata) {
        return {
          isStale: true,
          reason: "no_index",
        };
      }

      if (metadata.projectPath !== projectPath) {
        return {
          isStale: true,
          reason: "path_mismatch",
        };
      }

      // Scan current files
      const currentFiles = await this.scanProjectFiles(projectPath);

      // Compare file lists
      const modifiedFiles: string[] = [];
      const newFiles: string[] = [];
      const deletedFiles: string[] = [];

      // Check for modified and deleted files
      for (const [filePath, oldMeta] of Object.entries(metadata.files)) {
        const currentMeta = currentFiles.get(filePath);

        if (!currentMeta) {
          deletedFiles.push(filePath);
        } else if (
          currentMeta.mtime > oldMeta.mtime ||
          currentMeta.size !== oldMeta.size
        ) {
          modifiedFiles.push(filePath);
        }
      }

      // Check for new files
      for (const filePath of currentFiles.keys()) {
        if (!metadata.files[filePath]) {
          newFiles.push(filePath);
        }
      }

      // Determine staleness
      const hasChanges =
        modifiedFiles.length > 0 ||
        newFiles.length > 0 ||
        deletedFiles.length > 0;

      if (hasChanges) {
        return {
          isStale: true,
          reason: "files_changed",
          modifiedFiles,
          newFiles,
          deletedFiles,
        };
      }

      // Check age (24h threshold)
      const ageHours = (Date.now() - metadata.lastIndexed) / (1000 * 60 * 60);
      if (ageHours > 24) {
        return {
          isStale: true,
          reason: "age_threshold",
        };
      }

      return { isStale: false };
    } catch (error) {
      logger.error("Failed to check index staleness", error as Error, {
        projectId,
        projectPath,
      });

      return {
        isStale: true,
        reason: "check_failed",
      };
    }
  }

  /**
   * Get files that need reindexing
   */
  async getFilesToReindex(
    projectId: string,
    projectPath: string,
    previousStaleCheck?: StaleCheckResult,
  ): Promise<string[]> {
    // Reuse previous stale check if provided to avoid double filesystem scan
    const staleCheck = previousStaleCheck ?? await this.isIndexStale(projectId, projectPath);

    if (!staleCheck.isStale) {
      return [];
    }

    if (
      staleCheck.reason === "no_index" ||
      staleCheck.reason === "path_mismatch"
    ) {
      // Full reindex needed
      const currentFiles = await this.scanProjectFiles(projectPath);
      return Array.from(currentFiles.keys());
    }

    // Incremental reindex
    const filesToReindex: string[] = [];

    if (staleCheck.modifiedFiles) {
      filesToReindex.push(...staleCheck.modifiedFiles);
    }

    if (staleCheck.newFiles) {
      filesToReindex.push(...staleCheck.newFiles);
    }

    return filesToReindex;
  }

  /**
   * Update index metadata after indexing
   */
  async updateIndexMetadata(
    projectId: string,
    projectPath: string,
    indexedFiles: string[],
  ): Promise<void> {
    try {
      const fileMetadata: Record<string, FileMetadata> = {};
      let totalSize = 0;

      for (const filePath of indexedFiles) {
        const fullPath = path.join(projectPath, filePath);
        try {
          const stat = await fs.promises.stat(fullPath);
          fileMetadata[filePath] = {
            path: filePath,
            mtime: stat.mtimeMs,
            size: stat.size,
          };
          totalSize += stat.size;
        } catch (error) {
          logger.warn("Failed to stat file", { filePath, error });
        }
      }

      const metadata: IndexMetadata = {
        projectId,
        projectPath,
        lastIndexed: Date.now(),
        fileCount: indexedFiles.length,
        totalSize,
        files: fileMetadata,
      };

      await this.saveIndexMetadata(metadata);
      this.metadataCache.set(projectId, metadata);

      logger.info("Updated index metadata", {
        projectId,
        fileCount: indexedFiles.length,
        totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
      });
    } catch (error) {
      logger.error("Failed to update index metadata", error as Error, {
        projectId,
      });
    }
  }

  /**
   * Load and parse .gitignore file (delegates to shared ignore-patterns module)
   */
  private loadGitignore(projectPath: string) {
    return loadProjectIgnore(projectPath);
  }

  /**
   * Scan project files and get current state
   */
  private async scanProjectFiles(
    projectPath: string,
  ): Promise<Map<string, FileMetadata>> {
    const files = new Map<string, FileMetadata>();

    try {
      // Use same extensions as indexProject() to avoid false staleness
      const securityConfig = config.get("security");
      const allowedExtensions = securityConfig.allowedExtensions || [
        ".ts",
        ".js",
        ".tsx",
        ".jsx",
        ".dart",
        ".py",
      ];

      // Single combined glob pattern (avoids N separate directory traversals)
      const combinedPattern = `**/*{${allowedExtensions.join(",")}}`;

      // Load .gitignore rules
      const ig = await this.loadGitignore(projectPath);

      const matches = await globAsync(combinedPattern, {
        cwd: projectPath,
        nodir: true,
        dot: false,
      });

      for (const match of matches) {
        if (ig.ignores(match)) {
          continue;
        }

        const fullPath = path.join(projectPath, match);
        try {
          const stat = await fs.promises.stat(fullPath);
          files.set(match, {
            path: match,
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        } catch (error) {
          logger.warn("Failed to stat file during scan", { filePath: match });
        }
      }

      logger.info("Scanned project files", {
        projectPath,
        totalFiles: files.size,
      });
    } catch (error) {
      logger.error("Failed to scan project files", error as Error, {
        projectPath,
      });
    }

    return files;
  }

  /**
   * Get index metadata from vector store
   */
  private async getIndexMetadata(
    projectId: string,
  ): Promise<IndexMetadata | null> {
    // Check cache first
    if (this.metadataCache.has(projectId)) {
      return this.metadataCache.get(projectId)!;
    }

    try {
      // Query vector store for metadata document
      const collection = await this.vectorStore.getCollection(projectId);
      const results = await collection.query({
        queryTexts: ["_metadata"],
        nResults: 1,
        where: { id: `_metadata:${projectId}` },
      });

      if (results.length > 0 && results[0].content) {
        // Metadata is stored in the content field as JSON
        const metadata = JSON.parse(results[0].content) as IndexMetadata;
        this.metadataCache.set(projectId, metadata);
        return metadata;
      }
    } catch (error) {
      logger.debug("No metadata found for project", { projectId });
    }

    return null;
  }

  /**
   * Save index metadata to vector store
   */
  private async saveIndexMetadata(metadata: IndexMetadata): Promise<void> {
    try {
      const collection = await this.vectorStore.getCollection(
        metadata.projectId,
      );

      // Store as special metadata document with JSON in content
      await collection.add([
        {
          id: `_metadata:${metadata.projectId}`,
          content: JSON.stringify(metadata),
          embedding: new Array(1024).fill(0), // Zero vector for metadata docs
          metadata: {
            type: "_metadata",
            projectId: metadata.projectId,
          },
        },
      ]);

      logger.debug("Saved index metadata", { projectId: metadata.projectId });
    } catch (error) {
      logger.error("Failed to save index metadata", error as Error, {
        projectId: metadata.projectId,
      });
      throw error;
    }
  }

  /**
   * Clear metadata cache
   */
  clearCache(projectId?: string): void {
    if (projectId) {
      this.metadataCache.delete(projectId);
    } else {
      this.metadataCache.clear();
    }
  }
}
