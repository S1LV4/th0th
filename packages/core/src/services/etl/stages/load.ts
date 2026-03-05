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
import { sqliteVectorStore } from "../../../data/vector/sqlite-vector-store.js";
import {
  symbolRepository,
  type SymbolDefinition,
  type SymbolReference,
  type SymbolImport,
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

export class LoadStage {
  async run(ctx: EtlStageContext, files: ResolvedFile[]): Promise<LoadResult> {
    const t0 = performance.now();

    ctx.emit({
      type: "stage_start",
      stage: "load",
      payload: { total: files.length, toLoad: files.filter((f) => f.file.needsReparse).length },
      timestamp: Date.now(),
    });

    let filesLoaded = 0;
    let chunksLoaded = 0;
    let symbolsLoaded = 0;
    let errors = 0;

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
            symbolRepository.upsertFile({
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

      ctx.emit({
        type: "progress",
        stage: "load",
        payload: {
          current: Math.min(i + BATCH, files.length),
          total: files.length,
          percentage: Math.round((Math.min(i + BATCH, files.length) / files.length) * 100),
        },
        timestamp: Date.now(),
      });
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
    });

    return { filesLoaded, chunksLoaded, symbolsLoaded, errors };
  }

  /** Insert semantic chunks into the vector store. Returns chunk count. */
  private async loadToVectorStore(ctx: EtlStageContext, file: ResolvedFile): Promise<number> {
    if (file.chunks.length === 0) return 0;

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

    await sqliteVectorStore.addDocuments(documents);
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
    symbolRepository.writeFileSymbols(ctx.projectId, filePath, defs, refs, imports);

    return defs.length;
  }
}
