/**
 * ContextualSearchRLM - Optimized Contextual Search Service
 *
 * Implementation inspired by parallel search patterns,
 * adapted for the RLM ecosystem with:
 *
 * Features:
 * - Automatic project indexing with per-projectId namespace
 * - Hybrid search (vector + keyword) with RRF (Reciprocal Rank Fusion)
 * - Parallel search across multiple files
 * - Returns only relevant excerpts with context
 * - Multi-level intelligent cache
 * - Integration with existing embedding service
 *
 * Architecture:
 * - Uses SQLite as single backend (vector + keyword + cache)
 * - Per-projectId namespace for isolation
 * - Embedding reuse across projects
 */

import {
  SearchResult,
  SearchSource,
  RetrievalOptions,
  VectorDocument,
} from "@th0th-ai/shared";
import { logger } from "@th0th-ai/shared";
import { getKeywordSearch } from "../../data/sqlite/keyword-search-factory.js";
import { getVectorStore } from "../../data/vector/vector-store-factory.js";
import { estimateTokens } from "@th0th-ai/shared";
import { config } from "@th0th-ai/shared";
import { IndexManager } from "./index-manager.js";
import { getSearchCache } from "./cache-factory.js";
import { getSearchAnalytics } from "./analytics-factory.js";
import { SearchAnalytics } from "./search-analytics.js";
import type { SearchAnalyticsPg } from "./search-analytics-pg.js";
import { getSymbolRepository } from "../../data/sqlite/symbol-repository-factory.js";
import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import { minimatch } from "minimatch";
import { FileFilterCache } from "./file-filter-cache.js";
import { smartChunk } from "./smart-chunker.js";
import { loadProjectIgnore } from "./ignore-patterns.js";

const globAsync = glob;

/**
 * ContextualSearchRLM - Main contextual search service
 */
export class ContextualSearchRLM {
  private keywordSearch!: Awaited<ReturnType<typeof getKeywordSearch>>;
  private vectorStore!: Awaited<ReturnType<typeof getVectorStore>>;
  private indexManager!: IndexManager;
  private searchCache!: Awaited<ReturnType<typeof getSearchCache>>;
  private analytics!: Awaited<ReturnType<typeof getSearchAnalytics>>;
  private symbolRepo!: Awaited<ReturnType<typeof getSymbolRepository>>;
  private fileFilterCache: FileFilterCache;
  private readonly RRF_K = 60; // Constant for Reciprocal Rank Fusion
  private initialized = false;

  // Per-project mutex to prevent concurrent indexing
  private static indexingLocks = new Map<string, Promise<void>>();

  constructor() {
    this.fileFilterCache = new FileFilterCache();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    
    [
      this.keywordSearch,
      this.vectorStore,
      this.searchCache,
      this.analytics,
      this.symbolRepo,
    ] = await Promise.all([
      getKeywordSearch(),
      getVectorStore(),
      getSearchCache(),
      getSearchAnalytics(),
      getSymbolRepository(),
    ]);
    
    this.indexManager = new IndexManager(this.vectorStore);
    this.initialized = true;
    logger.info("ContextualSearchRLM initialized");
  }

  /**
   * Load and parse .gitignore file (delegates to shared ignore-patterns module)
   */
  private loadGitignore(projectPath: string) {
    return loadProjectIgnore(projectPath);
  }

  /**
   * Index an entire project
   *
   * @param projectPath - Path to the project
   * @param projectId - Unique project ID (namespace)
   * @returns Indexing statistics
   */
  async indexProject(
    projectPath: string,
    projectId: string,
    options: {
      onProgress?: (current: number, total: number) => void;
    } = {},
  ): Promise<{
    filesIndexed: number;
    chunksIndexed: number;
    errors: number;
  }> {
    // Per-project queue mutex: serializes concurrent indexing for the same project.
    //
    // Pattern: each caller chains its lock after the current tail, then waits
    // for the previous lock before proceeding. This guarantees correct ordering
    // for any number of concurrent callers (3+), unlike a simple check-and-set.
    //
    //   A sets map[proj] = lock_A, awaits null  → starts immediately
    //   B sets map[proj] = lock_B, awaits lock_A → waits for A
    //   C sets map[proj] = lock_C, awaits lock_B → waits for B
    //   A finishes → releases lock_A → B starts
    //   B finishes → releases lock_B → C starts
    //   C finishes → map[proj] === lock_C, so we clean up the entry
    const prevLock = ContextualSearchRLM.indexingLocks.get(projectId);
    const isQueued = prevLock !== undefined;

    let releaseLock!: () => void;
    const myLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    ContextualSearchRLM.indexingLocks.set(projectId, myLock);

    if (isQueued) {
      logger.info("Waiting for existing indexing to complete", { projectId });
      await prevLock;
    }

    try {
      return await this._indexProjectInternal(projectPath, projectId, options);
    } finally {
      // Only remove the map entry if we are still the tail (no new waiter after us)
      if (ContextualSearchRLM.indexingLocks.get(projectId) === myLock) {
        ContextualSearchRLM.indexingLocks.delete(projectId);
      }
      releaseLock();
    }
  }

  private async _indexProjectInternal(
    projectPath: string,
    projectId: string,
    options: {
      onProgress?: (current: number, total: number) => void;
    } = {},
  ): Promise<{
    filesIndexed: number;
    chunksIndexed: number;
    errors: number;
  }> {
    await this.ensureInitialized();
    logger.info("Starting project indexing", { projectPath, projectId });

    const securityConfig = config.get("security");
    const allowedExtensions = securityConfig.allowedExtensions || [
      ".ts",
      ".js",
      ".tsx",
      ".jsx",
      ".dart",
      ".py",
    ];

    try {
      // Load .gitignore rules
      const ig = await this.loadGitignore(projectPath);

      // Find all relevant files
      const files = await globAsync(`**/*{${allowedExtensions.join(",")}}`, {
        cwd: projectPath,
        absolute: true,
        nodir: true,
        dot: false,
      });

      // Filter files using .gitignore rules
      const filteredFiles = files.filter((file) => {
        const relativePath = path.relative(projectPath, file);
        const shouldIgnore = ig.ignores(relativePath);

        if (shouldIgnore) {
          logger.debug("Ignoring file per .gitignore during indexing", {
            filePath: relativePath,
          });
        }

        return !shouldIgnore;
      });

      logger.info(
        `Found ${filteredFiles.length} files to index (${files.length - filteredFiles.length} ignored)`,
        {
          projectId,
        },
      );

      options.onProgress?.(0, filteredFiles.length);

      // Load centrality map once for the whole project so each chunk
      // carries its file's PageRank score in metadata.
      const centralityMap = await this.symbolRepo.getCentrality(projectId);

      let filesIndexed = 0;
      let chunksIndexed = 0;
      let errors = 0;

      // Process files in batches to avoid overloading
      const BATCH_SIZE = 10;
      let processedFiles = 0;
      for (let i = 0; i < filteredFiles.length; i += BATCH_SIZE) {
        const batch = filteredFiles.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (file) => {
            try {
              const result = await this.indexFile(file, projectId, projectPath, centralityMap);
              filesIndexed++;
              chunksIndexed += result.chunks;
            } catch (error) {
              logger.error("Failed to index file", error as Error, { file });
              errors++;
            } finally {
              processedFiles++;
              options.onProgress?.(processedFiles, filteredFiles.length);
            }
          }),
        );

        // Log progress
        if (i % 50 === 0) {
          logger.info(
            `Progress: ${i}/${filteredFiles.length} files processed`,
            {
              projectId,
            },
          );
        }
      }

      // Update index metadata after successful indexing
      const indexedFilesList = filteredFiles.map((f) =>
        path.relative(projectPath, f),
      );
      await this.indexManager.updateIndexMetadata(
        projectId,
        projectPath,
        indexedFilesList,
      );

      logger.info("Project indexing completed", {
        projectId,
        filesIndexed,
        chunksIndexed,
        errors,
      });

      return { filesIndexed, chunksIndexed, errors };
    } catch (error) {
      logger.error("Project indexing failed", error as Error, { projectId });
      throw error;
    }
  }

  /**
   * Check if index is stale and optionally trigger reindexing
   */
  async ensureFreshIndex(
    projectId: string,
    projectPath: string,
    options: {
      allowFullReindex?: boolean;
      maxSyncFiles?: number;
    } = {},
  ): Promise<{
    wasStale: boolean;
    reindexed: boolean;
    reason?: string;
    deferred?: boolean;
    filesPending?: number;
  }> {
    await this.ensureInitialized();
    const allowFullReindex = options.allowFullReindex ?? false;
    const maxSyncFiles = options.maxSyncFiles ?? 100;

    const staleCheck = await this.indexManager.isIndexStale(
      projectId,
      projectPath,
    );

    if (!staleCheck.isStale) {
      return { wasStale: false, reindexed: false };
    }

    logger.info("Index is stale, performing incremental reindex", {
      projectId,
      reason: staleCheck.reason,
      modifiedFiles: staleCheck.modifiedFiles?.length,
      newFiles: staleCheck.newFiles?.length,
      deletedFiles: staleCheck.deletedFiles?.length,
    });

    // Get files that need reindexing (pass staleCheck to avoid double filesystem scan)
    const filesToReindex = await this.indexManager.getFilesToReindex(
      projectId,
      projectPath,
      staleCheck,
    );

    if (filesToReindex.length > maxSyncFiles) {
      logger.warn("Skipping sync reindex due to file limit", {
        projectId,
        reason: staleCheck.reason,
        filesToReindex: filesToReindex.length,
        maxSyncFiles,
      });

      return {
        wasStale: true,
        reindexed: false,
        deferred: true,
        reason: staleCheck.reason || "files_changed",
        filesPending: filesToReindex.length,
      };
    }

    if (filesToReindex.length === 0) {
      return {
        wasStale: true,
        reindexed: false,
        reason: "no_files_to_reindex",
      };
    }

    // For full reindex or many changes, clear and reindex
    const needsFullReindex =
      staleCheck.reason === "no_index" ||
      staleCheck.reason === "path_mismatch" ||
      filesToReindex.length > 100;

    if (needsFullReindex && !allowFullReindex) {
      logger.warn("Deferring full reindex in latency-sensitive path", {
        projectId,
        reason: staleCheck.reason,
        filesToReindex: filesToReindex.length,
      });

      return {
        wasStale: true,
        reindexed: false,
        deferred: true,
        reason: staleCheck.reason || "full_reindex_needed",
        filesPending: filesToReindex.length,
      };
    }

    if (needsFullReindex) {
      logger.info("Performing full reindex", { projectId });
      await this.indexProject(projectPath, projectId);

      // Invalidate cache after reindex
      await this.searchCache.invalidateProject(projectId);

      return {
        wasStale: true,
        reindexed: true,
        reason: "full_reindex",
      };
    }

    // Incremental reindex
    logger.info("Performing incremental reindex", {
      projectId,
      fileCount: filesToReindex.length,
    });

    // Load centrality map so chunks carry PageRank scores
    const centralityMap = await this.symbolRepo.getCentrality(projectId);

    let filesIndexed = 0;
    let chunksIndexed = 0;
    let errors = 0;

    for (const relativeFilePath of filesToReindex) {
      try {
        const fullPath = path.join(projectPath, relativeFilePath);
        const result = await this.indexFile(fullPath, projectId, projectPath, centralityMap);
        filesIndexed++;
        chunksIndexed += result.chunks;
      } catch (error) {
        logger.error("Failed to reindex file", error as Error, {
          file: relativeFilePath,
        });
        errors++;
      }
    }

    // Update metadata
    await this.indexManager.updateIndexMetadata(
      projectId,
      projectPath,
      filesToReindex,
    );

    // Invalidate cache after incremental reindex
    await this.searchCache.invalidateProject(projectId);

    logger.info("Incremental reindex completed", {
      projectId,
      filesIndexed,
      chunksIndexed,
      errors,
    });

    return {
      wasStale: true,
      reindexed: true,
      reason: "incremental_reindex",
    };
  }

  /**
   * Index a single file, splitting it into semantic chunks
   *
   * Uses the smart chunker which is language-aware:
   * - Markdown: splits by headings with hierarchy context
   * - JSON: splits by top-level keys
   * - YAML: splits by document separators or top-level keys
   * - Code: splits by functions/classes with preceding comments
   */
  private async indexFile(
    filePath: string,
    projectId: string,
    projectRoot: string,
    centralityMap?: Map<string, number>,
  ): Promise<{ chunks: number }> {
    const content = await fs.readFile(filePath, "utf-8");
    const relativePath = path.relative(projectRoot, filePath);

    // Check maximum file size
    const maxFileSize = config.get("security").maxFileSize || 1024 * 1024;
    if (content.length > maxFileSize) {
      logger.warn("File too large, skipping", {
        filePath,
        size: content.length,
      });
      return { chunks: 0 };
    }

    // Smart chunking: language/format-aware splitting
    const chunks = smartChunk(content, relativePath);

    // Look up the file's PageRank centrality score (0 if unavailable)
    const centralityScore = centralityMap?.get(relativePath) ?? 0;

    const documents: VectorDocument[] = chunks.map((chunk, i) => ({
      id: `${projectId}:${relativePath}:${i}`,
      content: chunk.content,
      metadata: {
        projectId,
        filePath: relativePath,
        chunkIndex: i,
        totalChunks: chunks.length,
        type: chunk.type,
        language: path.extname(filePath).slice(1),
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        label: chunk.label,
        centralityScore,
      },
    }));

    // Run vector and keyword indexing in parallel (I/O optimization)
    // Since embeddings are generated during addDocuments(), we can run
    // FTS5 keyword indexing concurrently to save ~30% total time
    await Promise.all([
      // Vector store: sub-batched embedding + insert
      this.vectorStore.addDocuments(documents),
      
      // Keyword search: parallel FTS5 inserts
      Promise.all(
        documents.map((doc) =>
          this.keywordSearch.index(doc.id, doc.content, doc.metadata),
        ),
      ),
    ]);

    return { chunks: chunks.length };
  }

  /**
   * Hybrid search (vector + keyword) with projectId filter
   */
  async search(
    query: string,
    projectId: string,
    options: {
      maxResults?: number;
      minScore?: number;
      explainScores?: boolean;
      includeFilters?: string[];
      excludeFilters?: string[];
    } = {},
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();
    const maxResults = options.maxResults || 10;
    const minScore = options.minScore ?? 0.3;
    const explainScores = options.explainScores || false;
    const includeFilters = options.includeFilters;
    const excludeFilters = options.excludeFilters;
    const startTime = performance.now(); // Use performance.now() for sub-millisecond precision

    logger.debug("Starting contextual search", {
      query,
      projectId,
      maxResults,
      explainScores,
      includeFilters,
      excludeFilters,
      startTime, // Add startTime to logging
    });

    // Check cache first
    const cacheOptions = { maxResults, minScore, explainScores };
    const cachedResults = await this.searchCache.get(
      query,
      projectId,
      cacheOptions,
    );

    if (cachedResults) {
      const endTime = performance.now();
      const duration = Math.max(1, Math.round(endTime - startTime)); // Minimum 1ms to avoid 0ms for sub-ms operations

      // DEBUG: Log all timing values to diagnose the issue
      logger.debug("Cache hit timing details", {
        startTime,
        endTime,
        duration,
        calculatedDuration: endTime - startTime,
        preciseMs: (endTime - startTime).toFixed(3),
      });

      // Track cache hit
      this.analytics.trackSearch({
        timestamp: Date.now(),
        projectId,
        query,
        resultCount: cachedResults.length,
        duration,
        cacheHit: true,
        score: this.calculateAvgScore(cachedResults),
      });

      logger.info("Cache hit - returning cached results", {
        projectId,
        resultCount: cachedResults.length,
        duration,
        durationMs: `${duration}ms`,
        preciseMs: `${(endTime - startTime).toFixed(3)}ms`,
      });
      return cachedResults;
    }

    try {
      // Parallel search across vector store and keyword search
      const [vectorResults, keywordResults] = await Promise.all([
        this.vectorStore.search(query, maxResults * 2, projectId),
        this.keywordSearch.searchWithFilter(
          query,
          { projectId },
          maxResults * 2,
        ),
      ]);

      logger.debug("Search results retrieved", {
        vectorCount: vectorResults.length,
        keywordCount: keywordResults.length,
      });

      // Combine results using RRF (with score explanation if requested)
      const fusedResults = this.fuseResults(
        [vectorResults, keywordResults],
        query,
        explainScores,
      );

      // Apply file pattern filters if provided
      // Note: For maximum efficiency, filters could be applied DURING vector/keyword search
      // by pre-computing valid files. For now, we apply post-search but cache the filter computation.
      let filteredByPattern = fusedResults;
      if (includeFilters || excludeFilters) {
        const filterStartTime = performance.now();
        filteredByPattern = this.filterByPatterns(
          fusedResults,
          includeFilters,
          excludeFilters,
        );
        const filterDuration = performance.now() - filterStartTime;

        logger.debug("Applied file pattern filters", {
          beforeFilter: fusedResults.length,
          afterFilter: filteredByPattern.length,
          includePatterns: includeFilters,
          excludePatterns: excludeFilters,
          filterDurationMs: filterDuration.toFixed(2),
        });
      }

      // Filter by minimum score and limit results.
      //
      // minScore is applied to the RAW vector similarity (cosine distance from
      // the embedding model), not the normalized RRF score.  RRF normalization
      // divides by the max score, so the top result always gets ~1.0 regardless
      // of actual semantic relevance — making a score-based filter useless for
      // noise rejection.  The raw vectorScore is an absolute measure (0–1) that
      // is meaningful across queries.
      //
      // Keyword-only results (no vectorScore) fall back to the normalized score
      // so they are still subject to some threshold.
      const filtered = filteredByPattern
        .filter((result) => {
          const meta = result.metadata as Record<string, unknown>;
          const rawVs = meta?._rrfRawVectorScore as number | undefined;
          return rawVs !== undefined ? rawVs >= minScore : result.score >= minScore;
        })
        .map((result) => {
          // Strip the internal field before caching / returning to callers.
          const { _rrfRawVectorScore, ...cleanMeta } = result.metadata as Record<string, unknown>;
          return { ...result, metadata: cleanMeta };
        })
        .slice(0, maxResults);

      // Add context to results
      const withContext = await this.addContextToResults(filtered, projectId);

      // Cache the results
      await this.searchCache.set(query, projectId, withContext, cacheOptions);

      const duration = Math.round(performance.now() - startTime); // Use performance.now() for consistency

      // Track cache miss
      this.analytics.trackSearch({
        timestamp: Date.now(),
        projectId,
        query,
        resultCount: withContext.length,
        duration,
        cacheHit: false,
        score: this.calculateAvgScore(withContext),
      });

      logger.info("Contextual search completed", {
        projectId,
        totalResults: withContext.length,
        avgScore: this.calculateAvgScore(withContext),
        duration,
      });

      return withContext;
    } catch (error) {
      logger.error("Contextual search failed", error as Error, {
        query,
        projectId,
      });
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion (RRF) - Combines multiple result lists
   *
   * Now includes intelligent boosting:
   * - Keywords get higher weight when query contains function/class names
   * - Exact matches in keyword results get additional boost
   */
  private fuseResults(
    resultSets: SearchResult[][],
    query: string,
    explainScores: boolean = false,
  ): SearchResult[] {
    const scoreMap = new Map<
      string,
      {
        result: SearchResult;
        rrfScore: number;
        vectorRank?: number;
        keywordRank?: number;
        vectorScore?: number;
        keywordScore?: number;
      }
    >();

    // Detect if query contains code-specific patterns (functions, classes, etc.)
    const hasCodePattern = (text: string): boolean => {
      const codePatterns = [
        /\w+\(\)/, // function calls: cn(), useState()
        /\bfunction\b/i, // "function" keyword
        /\bclass\b/i, // "class" keyword
        /\binterface\b/i, // "interface" keyword
        /\benum\b/i, // "enum" keyword
        /\btype\b/i, // "type" keyword
        /\bconst\b/i, // "const" keyword
        /\bimport\b/i, // "import" keyword
        /\bexport\b/i, // "export" keyword
      ];
      return codePatterns.some((pattern) => pattern.test(text));
    };

    // Check if this is a code-focused query
    const isCodeQuery = hasCodePattern(query);

    // Keyword weight multiplier (higher = more weight to keyword results)
    // For code queries: 2.5x boost to keyword matches
    // For general queries: 1.0x (equal weight)
    const KEYWORD_BOOST = isCodeQuery ? 2.5 : 1.0;

    logger.debug("RRF fusion parameters", {
      query,
      isCodeQuery,
      keywordBoost: KEYWORD_BOOST,
      vectorResults: resultSets[0]?.length || 0,
      keywordResults: resultSets[1]?.length || 0,
    });

    // Calculate RRF score for each result
    for (let i = 0; i < resultSets.length; i++) {
      const results = resultSets[i];
      const isVector = i === 0; // First set is vector, second is keyword
      const boost = isVector ? 1.0 : KEYWORD_BOOST;

      results.forEach((result, rank) => {
        const rrfScore = (1 / (this.RRF_K + rank + 1)) * boost;

        if (scoreMap.has(result.id)) {
          const existing = scoreMap.get(result.id)!;
          existing.rrfScore += rrfScore;

          if (isVector) {
            existing.vectorRank = rank;
            existing.vectorScore = result.score;
          } else {
            existing.keywordRank = rank;
            existing.keywordScore = result.score;
          }
        } else {
          scoreMap.set(result.id, {
            result: { ...result },
            rrfScore,
            vectorRank: isVector ? rank : undefined,
            keywordRank: isVector ? undefined : rank,
            vectorScore: isVector ? result.score : undefined,
            keywordScore: isVector ? undefined : result.score,
          });
        }
      });
    }

    // Convert to array and sort by RRF score
    const sorted = Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore);

    // Dynamic normalization: use the top RRF score as divisor so results
    // span the full [0, 1] range instead of being capped by a fixed constant.
    const maxRrfScore = sorted[0]?.rrfScore || 1;

    return sorted
      .map(
        (
          {
            result,
            rrfScore,
            vectorRank,
            keywordRank,
            vectorScore,
            keywordScore,
          },
          index,
        ) => {
          const rrfNormalized = rrfScore / maxRrfScore;

          // Combine RRF score with vector similarity for better relevance measurement
          // Weight: 70% RRF (ranking-based) + 30% vector similarity (semantic)
          const vectorSimilarity = vectorScore || 0;
          const combinedScore = rrfNormalized * 0.7 + vectorSimilarity * 0.3;

          // Centrality boost: symbols with higher PageRank get a mild re-ranking bonus.
          // finalScore = combined_score * (1 + 0.2 * centralityScore)
          // centralityScore is in [0, 1]; clamped to [0, 1] after boost.
          const centralityScore =
            typeof (result.metadata as Record<string, unknown>)?.centralityScore === "number"
              ? ((result.metadata as Record<string, unknown>).centralityScore as number)
              : 0;
          const normalizedScore = Math.min(1, combinedScore * (1 + 0.2 * centralityScore));

          // Generate explanation if requested
          const explanation = explainScores
            ? this.generateScoreExplanation(
                normalizedScore,
                rrfScore,
                vectorScore,
                keywordScore,
                vectorRank,
                keywordRank,
                index,
              )
            : undefined;

          return {
            ...result,
            score: normalizedScore,
            explanation,
            // Internal field: raw cosine similarity from the vector store.
            // Used by search() to apply minScore as an absolute relevance gate
            // (normalized RRF score is always ~1.0 for the top result and
            // therefore cannot filter semantic noise). Stripped before caching.
            metadata: {
              ...(result.metadata as Record<string, unknown>),
              _rrfRawVectorScore: vectorScore,
            } as typeof result.metadata,
          };
        },
      );
  }

  /**
   * Generate detailed score explanation
   */
  private generateScoreExplanation(
    finalScore: number,
    rrfScore: number,
    vectorScore?: number,
    keywordScore?: number,
    vectorRank?: number,
    keywordRank?: number,
    combinedRank?: number,
  ): any {
    const parts: string[] = [];

    if (vectorScore != null && vectorRank != null) {
      parts.push(
        `Vector: ${(vectorScore * 100).toFixed(1)}% (rank #${vectorRank + 1})`,
      );
    }

    if (keywordScore != null && keywordRank != null) {
      parts.push(
        `Keyword: ${(keywordScore * 100).toFixed(1)}% (rank #${keywordRank + 1})`,
      );
    }

    const breakdown =
      parts.join(" + ") +
      ` → RRF: ${rrfScore.toFixed(4)} → Final: ${(finalScore * 100).toFixed(1)}%`;

    return {
      finalScore,
      vectorScore: vectorScore ?? undefined,
      keywordScore: keywordScore ?? undefined,
      rrfScore,
      vectorRank: vectorRank != null ? vectorRank + 1 : undefined,
      keywordRank: keywordRank != null ? keywordRank + 1 : undefined,
      combinedRank: combinedRank != null ? combinedRank + 1 : undefined,
      breakdown,
    };
  }

  /**
   * Add expanded context to results
   */
  private async addContextToResults(
    results: SearchResult[],
    projectId: string,
  ): Promise<SearchResult[]> {
    return results.map((result) => {
      const metadata = result.metadata;
      const filePath = metadata?.filePath as string;
      const lineStart = metadata?.lineStart as number;
      const lineEnd = metadata?.lineEnd as number;

      if (filePath && lineStart && lineEnd) {
        return {
          ...result,
          highlights: [`${filePath}:${lineStart}-${lineEnd}`],
          metadata: {
            ...metadata,
            context: {
              filePath,
              lineStart,
              lineEnd,
              preview: this.extractPreview(result.content),
            },
          },
        };
      }

      return result;
    });
  }

  /**
   * Extract content preview (first lines)
   */
  private extractPreview(content: string, maxLines: number = 5): string {
    const lines = content.split("\n");
    const preview = lines.slice(0, maxLines).join("\n");
    return lines.length > maxLines ? preview + "\n..." : preview;
  }

  /**
   * Calculate average score
   */
  private calculateAvgScore(results: SearchResult[]): number {
    if (results.length === 0) return 0;
    const sum = results.reduce((acc, r) => acc + r.score, 0);
    return sum / results.length;
  }

  /**
   * Filter results by glob patterns
   */
  private filterByPatterns(
    results: SearchResult[],
    include?: string[],
    exclude?: string[],
  ): SearchResult[] {
    if (!include && !exclude) {
      return results;
    }

    return results.filter((result) => {
      const filePath = result.metadata?.filePath as string;
      if (!filePath) return true;

      // Check exclude patterns first (blacklist)
      if (exclude && exclude.length > 0) {
        const isExcluded = exclude.some((pattern) => {
          const regex = this.globToRegex(pattern);
          return regex.test(filePath);
        });
        if (isExcluded) return false;
      }

      // Check include patterns (whitelist)
      if (include && include.length > 0) {
        const isIncluded = include.some((pattern) => {
          const regex = this.globToRegex(pattern);
          return regex.test(filePath);
        });
        return isIncluded;
      }

      // No include patterns specified, include by default (unless excluded above)
      return true;
    });
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/\./g, "\\.")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  }

  /**
   * Clear project index
   */
  async clearProjectIndex(projectId: string): Promise<{ deleted: number }> {
    await this.ensureInitialized();
    try {
      const deleted = await this.vectorStore.deleteByProject(projectId);

      // Also clears keyword search
      // Note: KeywordSearch would need a deleteByProject method

      // Clear associated caches
      await this.searchCache.invalidateProject(projectId);
      this.fileFilterCache.invalidateProject(projectId);

      logger.info("Project index and caches cleared", { projectId, deleted });
      return { deleted };
    } catch (error) {
      logger.error("Failed to clear project index", error as Error, {
        projectId,
      });
      return { deleted: 0 };
    }
  }

  /**
   * Get project statistics
   */
  async getProjectStats(projectId: string): Promise<{
    totalDocuments: number;
    totalSize: number;
  }> {
    await this.ensureInitialized();
    return this.vectorStore.getStats(projectId);
  }

  /**
   * Warmup cache with common queries
   *
   * Pre-caches typical search patterns to improve initial search performance
   */
  async warmupCache(
    projectId: string,
    projectPath: string,
    customQueries?: string[],
  ): Promise<{ queriesWarmed: number; errors: number }> {
    await this.ensureInitialized();
    logger.info("Starting cache warmup", { projectId });

    // Common search patterns based on file types and structure
    const commonQueries = customQueries || [
      "authentication",
      "api endpoints",
      "database models",
      "components",
      "utils",
      "configuration",
      "routes",
      "services",
      "tests",
      "types",
      "interfaces",
      "error handling",
      "validation",
      "middleware",
      "hooks",
    ];

    let queriesWarmed = 0;
    let errors = 0;

    // Run searches in background to populate cache
    for (const query of commonQueries) {
      try {
        await this.search(query, projectId, {
          maxResults: 10,
          minScore: 0.3,
        });
        queriesWarmed++;

        logger.debug("Warmed cache for query", { query, projectId });
      } catch (error) {
        logger.error("Failed to warm cache for query", error as Error, {
          query,
          projectId,
        });
        errors++;
      }
    }

    logger.info("Cache warmup completed", {
      projectId,
      queriesWarmed,
      errors,
      totalQueries: commonQueries.length,
    });

    return { queriesWarmed, errors };
  }

  /**
   * Get analytics instance for querying metrics
   */
  getAnalytics(): SearchAnalytics | SearchAnalyticsPg {
    return this.analytics;
  }
}

// Export singleton
export const contextualSearch = new ContextualSearchRLM();
