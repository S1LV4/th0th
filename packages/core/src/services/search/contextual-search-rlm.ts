/**
 * ContextualSearchRLM - Sistema de Busca Contextual Otimizado
 *
 * Implementação inspirada em padrões de busca paralela,
 * adaptada para o ecossistema RLM com:
 *
 * Features:
 * - Indexação automática de projetos com namespace por projectId
 * - Busca híbrida (vector + keyword) com RRF (Reciprocal Rank Fusion)
 * - Busca paralela em múltiplos arquivos
 * - Retorna apenas trechos relevantes com contexto
 * - Cache inteligente multi-nível
 * - Integração com embedding service existente
 *
 * Arquitetura:
 * - Usa SQLite como backend único (vector + keyword + cache)
 * - Namespace por projectId para isolamento
 * - Reutilização de embeddings entre projetos
 */

import {
  SearchResult,
  SearchSource,
  RetrievalOptions,
  VectorDocument,
} from "@th0th-ai/shared";
import { logger } from "@th0th-ai/shared";
import { KeywordSearch } from "../../data/sqlite/keyword-search.js";
import { sqliteVectorStore } from "../../data/vector/sqlite-vector-store.js";
import { estimateTokens } from "@th0th-ai/shared";
import { config } from "@th0th-ai/shared";
import { IndexManager } from "./index-manager.js";
import { SearchCache } from "./search-cache.js";
import { SearchAnalytics } from "./search-analytics.js";
import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import ignoreModule from "ignore";
import { minimatch } from "minimatch";
import { FileFilterCache } from "./file-filter-cache.js";
import { smartChunk } from "./smart-chunker.js";

const globAsync = glob;
const ignore = (ignoreModule as any).default || ignoreModule;

/**
 * ContextualSearchRLM - Serviço principal de busca contextual
 */
export class ContextualSearchRLM {
  private keywordSearch: KeywordSearch;
  private vectorStore = sqliteVectorStore;
  private indexManager: IndexManager;
  private searchCache: SearchCache;
  private analytics: SearchAnalytics;
  private fileFilterCache: FileFilterCache;
  private readonly RRF_K = 60; // Constante para Reciprocal Rank Fusion

  constructor() {
    this.keywordSearch = new KeywordSearch();
    this.indexManager = new IndexManager(this.vectorStore);
    this.searchCache = new SearchCache();
    this.analytics = new SearchAnalytics();
    this.fileFilterCache = new FileFilterCache();
    logger.info("ContextualSearchRLM initialized");
  }

  /**
   * Load and parse .gitignore file
   */
  private async loadGitignore(projectPath: string) {
    const ig = ignore();

    // Add default ignores (always ignore these)
    ig.add([
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
      // Generated files (huge, low search value)
      "**/generated/**",
      "**/*.generated.*",
      "**/*.d.ts",     // Type declaration files (usually auto-generated or from packages)
      "**/*.wasm*",    // WebAssembly (binary, not searchable)
      "**/*.min.*",    // Minified files
      "**/*.map",      // Source maps
      "**/lock.yaml",
      "**/pnpm-lock.yaml",
      "**/package-lock.json",
      "**/bun.lockb",
      "**/yarn.lock",
    ]);

    try {
      const gitignorePath = path.join(projectPath, ".gitignore");
      const gitignoreContent = await fs.readFile(gitignorePath, "utf8");

      // Parse .gitignore (filter out comments and empty lines)
      const rules = gitignoreContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));

      ig.add(rules);

      logger.info("Loaded .gitignore for project indexing", {
        projectPath,
        rulesCount: rules.length,
      });
    } catch (error) {
      logger.debug("No .gitignore found during indexing, using defaults only", {
        projectPath,
      });
    }

    return ig;
  }

  /**
   * Indexa um projeto inteiro
   *
   * @param projectPath - Caminho do projeto
   * @param projectId - ID único do projeto (namespace)
   * @returns Estatísticas da indexação
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

      // Encontra todos os arquivos relevantes
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

      let filesIndexed = 0;
      let chunksIndexed = 0;
      let errors = 0;

      // Processa arquivos em batches para não sobrecarregar
      const BATCH_SIZE = 10;
      let processedFiles = 0;
      for (let i = 0; i < filteredFiles.length; i += BATCH_SIZE) {
        const batch = filteredFiles.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (file) => {
            try {
              const result = await this.indexFile(file, projectId, projectPath);
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

        // Log progresso
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
    const allowFullReindex = options.allowFullReindex ?? true;
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

    // Get files that need reindexing
    const filesToReindex = await this.indexManager.getFilesToReindex(
      projectId,
      projectPath,
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

    let filesIndexed = 0;
    let chunksIndexed = 0;
    let errors = 0;

    for (const relativeFilePath of filesToReindex) {
      try {
        const fullPath = path.join(projectPath, relativeFilePath);
        const result = await this.indexFile(fullPath, projectId, projectPath);
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
   * Indexa um único arquivo, dividindo em chunks semânticos
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
  ): Promise<{ chunks: number }> {
    const content = await fs.readFile(filePath, "utf-8");
    const relativePath = path.relative(projectRoot, filePath);

    // Verifica tamanho máximo
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
   * Busca híbrida (vector + keyword) com filtro por projectId
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
    const maxResults = options.maxResults || 10;
    const minScore = options.minScore || 0.3;
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
      // Busca paralela em vector store e keyword search
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

      // Combina resultados usando RRF (with score explanation if requested)
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

      // Filtra por score mínimo e limita
      const filtered = filteredByPattern
        .filter((result) => result.score >= minScore)
        .slice(0, maxResults);

      // Adiciona contexto aos resultados
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
   * Reciprocal Rank Fusion (RRF) - Combina múltiplas listas de resultados
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

    // Calcula RRF score para cada resultado
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

    // Converte para array e ordena por RRF score
    return Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
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
          const normalizedScore = Math.min(1, rrfScore / 0.05);

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
   * Adiciona contexto expandido aos resultados
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
   * Extrai preview do conteúdo (primeiras linhas)
   */
  private extractPreview(content: string, maxLines: number = 5): string {
    const lines = content.split("\n");
    const preview = lines.slice(0, maxLines).join("\n");
    return lines.length > maxLines ? preview + "\n..." : preview;
  }

  /**
   * Calcula score médio
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
   * Limpa indexação de um projeto
   */
  async clearProjectIndex(projectId: string): Promise<{ deleted: number }> {
    try {
      const deleted = await this.vectorStore.deleteByProject(projectId);

      // Também limpa keyword search
      // Nota: KeywordSearch precisaria de método deleteByProject

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
   * Obtém estatísticas de um projeto
   */
  async getProjectStats(projectId: string): Promise<{
    totalDocuments: number;
    totalSize: number;
  }> {
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
  getAnalytics(): SearchAnalytics {
    return this.analytics;
  }
}

// Exporta singleton
export const contextualSearch = new ContextualSearchRLM();
