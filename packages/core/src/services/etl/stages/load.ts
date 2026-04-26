/**
 * ETL Stage 4 — Load
 *
 * Persists ResolvedFile data in parallel to:
 *   1. SQLite Vector Store  — embedding chunks for semantic search
 *   2. Symbol DB            — definitions, references, imports for graph navigation
 *
 * Each file is written atomically (SQLite transaction per file).
 * Updates the symbol_files fingerprint table on success.
 */

import { logger } from "@th0th-ai/shared";
import { getVectorStore } from "../../../data/vector/vector-store-factory.js";
import { getSymbolRepository } from "../../../data/sqlite/symbol-repository-factory.js";
import type {
  SymbolDefinition,
  SymbolReference,
  SymbolImport,
} from "../../../data/sqlite/symbol-repository.js";
import type {
  EtlStageContext,
  ResolvedFile,
  RawSymbol,
} from "../stage-context.js";

export interface LoadResult {
  filesLoaded: number;
  chunksLoaded: number;
  symbolsLoaded: number;
  errors: number;
}

/** Human-readable duration: "42s", "3m 12s", "1h 04m". */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm.toString().padStart(2, "0")}m`;
}

export class LoadStage {
  private vectorStore: Awaited<ReturnType<typeof getVectorStore>> | null = null;

  private async ensureVectorStore() {
    if (!this.vectorStore) {
      this.vectorStore = await getVectorStore();
    }
    return this.vectorStore;
  }

  async run(ctx: EtlStageContext, files: ResolvedFile[]): Promise<LoadResult> {
    const t0 = performance.now();
    const toLoadCount = files.filter((f) => f.file.needsReparse).length;

    ctx.emit({
      type: "stage_start",
      stage: "load",
      payload: { total: files.length, toLoad: toLoadCount },
      timestamp: Date.now(),
    });

    if (toLoadCount > 0) {
      logger.info("ETL Load starting", {
        projectId: ctx.projectId,
        filesToLoad: toLoadCount,
        filesSkipped: files.length - toLoadCount,
      });
    }

    let filesLoaded = 0;
    let chunksLoaded = 0;
    let symbolsLoaded = 0;
    let errors = 0;
    let processedSinceStart = 0; // files that actually ran (not skipped) — for ETA rate
    let lastEtaLogAt = 0;

    // Process in batches of 10 to avoid overwhelming the embedding service
    const BATCH = 10;

    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);

      await Promise.all(
        batch.map(async (file) => {
          if (!file.file.needsReparse) return; // skip unchanged files

          try {
            const [chunkCount, symCount] = await Promise.all([
              this.loadToVectorStore(ctx, file),
              this.loadToSymbolDb(ctx, file),
            ]);

            // Update fingerprint table
            await getSymbolRepository().upsertFile({
              project_id: ctx.projectId,
              relative_path: file.file.relativePath,
              content_hash: file.file.contentHash,
              mtime: file.file.mtime,
              size: file.file.size,
              indexed_at: Date.now(),
              symbol_count: symCount,
              chunk_count: chunkCount,
            });

            filesLoaded++;
            chunksLoaded += chunkCount;
            symbolsLoaded += symCount;
            processedSinceStart++;

            ctx.emit({
              type: "file_processed",
              stage: "load",
              payload: {
                filePath: file.file.relativePath,
                chunks: chunkCount,
                symbols: symCount,
                status: "ok",
              },
              timestamp: Date.now(),
            });
          } catch (err) {
            errors++;
            processedSinceStart++;
            ctx.emit({
              type: "file_error",
              stage: "load",
              payload: { filePath: file.file.relativePath, error: (err as Error).message },
              timestamp: Date.now(),
            });
            logger.error("LoadStage: failed to load file", err as Error, {
              projectId: ctx.projectId,
              filePath: file.file.relativePath,
            });
          }
        }),
      );

      const current = Math.min(i + BATCH, files.length);
      const elapsedMs = performance.now() - t0;
      const remainingToLoad = Math.max(0, toLoadCount - processedSinceStart);
      // Only compute ETA once we have a real sample and files left to process
      const filesPerSec = processedSinceStart > 0 && elapsedMs > 0
        ? (processedSinceStart / elapsedMs) * 1000
        : 0;
      const etaMs = filesPerSec > 0 && remainingToLoad > 0
        ? Math.round(remainingToLoad / filesPerSec * 1000)
        : 0;

      ctx.emit({
        type: "progress",
        stage: "load",
        payload: {
          current,
          total: files.length,
          percentage: Math.round((current / files.length) * 100),
          processed: processedSinceStart,
          toLoad: toLoadCount,
          elapsedMs: Math.round(elapsedMs),
          filesPerSec: Number(filesPerSec.toFixed(2)),
          etaMs,
        },
        timestamp: Date.now(),
      });

      // Throttle ETA log to at most every 5s so it stays informative, not spammy
      if (
        etaMs > 0 &&
        processedSinceStart >= BATCH &&
        elapsedMs - lastEtaLogAt >= 5000
      ) {
        lastEtaLogAt = elapsedMs;
        logger.info("ETL Load progress", {
          projectId: ctx.projectId,
          processed: processedSinceStart,
          toLoad: toLoadCount,
          percentage: Math.round((processedSinceStart / toLoadCount) * 100),
          filesPerSec: Number(filesPerSec.toFixed(2)),
          eta: formatDuration(etaMs),
          elapsed: formatDuration(elapsedMs),
        });
      }
    }

    const durationMs = Math.round(performance.now() - t0);

    ctx.emit({
      type: "stage_end",
      stage: "load",
      payload: { filesLoaded, chunksLoaded, symbolsLoaded, errors, durationMs },
      timestamp: Date.now(),
    });

    logger.info("ETL Load complete", {
      projectId: ctx.projectId,
      filesLoaded,
      chunksLoaded,
      symbolsLoaded,
      errors,
      durationMs,
      duration: formatDuration(durationMs),
      filesPerSec: filesLoaded > 0 && durationMs > 0
        ? Number(((filesLoaded / durationMs) * 1000).toFixed(2))
        : 0,
    });

    return { filesLoaded, chunksLoaded, symbolsLoaded, errors };
  }

  /** Insert semantic chunks into the vector store. Returns chunk count. */
  private async loadToVectorStore(ctx: EtlStageContext, file: ResolvedFile): Promise<number> {
    if (file.chunks.length === 0) return 0;
    
    const vs = await this.ensureVectorStore();

    const documents = file.chunks.map((chunk, i) => ({
      id: `${ctx.projectId}:${file.file.relativePath}:${i}`,
      content: chunk.content,
      metadata: {
        projectId: ctx.projectId,
        filePath: file.file.relativePath,
        chunkIndex: i,
        totalChunks: file.chunks.length,
        type: chunk.type,
        language: file.file.relativePath.split(".").pop() ?? "",
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        label: chunk.label,
      },
    }));

    await vs.addDocuments(documents);
    return documents.length;
  }

  /** Insert symbols, references, and imports into the symbol DB. Returns symbol count. */
  private async loadToSymbolDb(ctx: EtlStageContext, file: ResolvedFile): Promise<number> {
    const now = Date.now();
    const filePath = file.file.relativePath;

    // Build SymbolDefinition objects
    const defs: SymbolDefinition[] = file.symbols.map((sym: RawSymbol) => ({
      id: sym.fqn ?? `${filePath}#${sym.name}`,
      project_id: ctx.projectId,
      file_path: filePath,
      name: sym.name,
      kind: sym.kind,
      line_start: sym.lineStart,
      line_end: sym.lineEnd,
      exported: sym.exported,
      doc_comment: sym.docComment,
      indexed_at: now,
    }));

    // Build SymbolReference from imports (import is a ref of kind 'import')
    const refs: SymbolReference[] = file.resolvedImports
      .filter((imp) => !imp.external)
      .flatMap((imp) =>
        imp.raw.names.map((name) => ({
          project_id: ctx.projectId,
          from_file: filePath,
          from_line: 1, // import lines are at file top; line precision not critical here
          symbol_name: name,
          target_fqn: imp.resolvedPath ? `${imp.resolvedPath}#${name}` : undefined,
          ref_kind: "import" as const,
        })),
      );

    // Build SymbolImport edges
    const imports: SymbolImport[] = file.resolvedImports.map((imp) => ({
      project_id: ctx.projectId,
      from_file: filePath,
      to_file: imp.resolvedPath ?? undefined,
      specifier: imp.raw.specifier,
      imported_names: imp.raw.names,
      is_external: imp.external,
      is_type_only: imp.raw.isTypeOnly,
    }));

    // Single transaction: delete old + insert new
    await getSymbolRepository().writeFileSymbols(ctx.projectId, filePath, defs, refs, imports);

    return defs.length;
  }
}
