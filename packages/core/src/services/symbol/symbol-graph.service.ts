/**
 * Symbol Graph Service
 *
 * High-level API for code navigation operations:
 *   - go_to_definition: resolve where a symbol is declared
 *   - get_references: find all usages of a symbol
 *   - get_dependencies: file import graph (BFS, with depth limit)
 *   - list_definitions: filtered browse of all symbols in a project
 *
 * Also owns centrality recomputation (triggered after ETL completes).
 */

import path from "path";
import fs from "fs/promises";
import { logger } from "@th0th-ai/shared";
import { getSymbolRepository } from "../../data/sqlite/symbol-repository-factory.js";
import type {
  SymbolDefinition,
  SymbolReference,
  SymbolImport,
  CentralityEntry,
} from "../../data/sqlite/symbol-repository.js";
import { computePageRank } from "./centrality.js";

// ─── Return types ─────────────────────────────────────────────────────────────

export interface DefinitionResult {
  fqn: string;
  name: string;
  kind: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  docComment?: string;
  snippet?: string;
  centralityScore: number;
}

export interface ReferenceResult {
  fromFile: string;
  fromLine: number;
  refKind: string;
  symbolName: string;
  targetFqn?: string;
  context?: string; // 3-line snippet around the reference
}

export interface DependencyNode {
  file: string;
  depth: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
  specifier: string;
  importedNames: string[];
  isExternal: boolean;
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface CentralityResult {
  filePath: string;
  score: number;
  updatedAt: number;
}

export interface ListDefinitionsOptions {
  kind?: string[];
  file?: string;
  exportedOnly?: boolean;
  search?: string;
  limit?: number;
}

export interface ProjectMapResult {
  projectId: string;
  stats: {
    files: number;
    chunks: number;
    symbols: number;
    status: string;
    lastIndexedAt: string | null;
  };
  topCentralFiles: CentralityResult[];
  symbolsByKind: Record<string, number>;
  filesByLanguage: Record<string, number>;
  recentFiles: Array<{ filePath: string; indexedAt: string | null }>;
}

export interface GetProjectMapOptions {
  centralityLimit?: number;
  recentLimit?: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class SymbolGraphService {
  private static instance: SymbolGraphService | null = null;

  private constructor() {}

  static getInstance(): SymbolGraphService {
    if (!SymbolGraphService.instance) {
      SymbolGraphService.instance = new SymbolGraphService();
    }
    return SymbolGraphService.instance;
  }

  /** Returns true if the project has any indexed symbols. */
  async hasData(projectId: string): Promise<boolean> {
    const files = await getSymbolRepository().allFiles(projectId);
    return files.length > 0;
  }

  // ── go_to_definition ────────────────────────────────────────────────────────

  /**
   * Find where a symbol is defined.
   *
   * Disambiguation order when multiple results:
   *   1. Symbols defined in `fromFile` (same-file priority)
   *   2. Symbols defined in direct imports of `fromFile`
   *   3. All other results, sorted by centrality desc
   */
  async goToDefinition(
    projectId: string,
    symbolName: string,
    fromFile?: string,
  ): Promise<DefinitionResult[]> {
    const repo = getSymbolRepository();
    const [centrality, defs] = await Promise.all([
      repo.getCentrality(projectId),
      repo.findDefinitionsByName(projectId, symbolName),
    ]);

    if (defs.length === 0) return [];

    // Determine direct imports of fromFile for disambiguation
    const directImportFiles = fromFile
      ? new Set(
          (await repo.findDependencies(projectId, fromFile))
            .filter((imp) => imp.to_file)
            .map((imp) => imp.to_file!),
        )
      : new Set<string>();

    const results = defs.map((def) => this.toDefinitionResult(def, centrality));

    results.sort((a, b) => {
      if (fromFile) {
        const aInFile = a.file === fromFile ? 2 : directImportFiles.has(a.file) ? 1 : 0;
        const bInFile = b.file === fromFile ? 2 : directImportFiles.has(b.file) ? 1 : 0;
        if (aInFile !== bInFile) return bInFile - aInFile;
      }
      return b.centralityScore - a.centralityScore;
    });

    // Enrich top-3 with code snippet
    const top = results.slice(0, 3);
    await Promise.all(
      top.map(async (r) => {
        r.snippet = await this.readSnippet(r.file, r.lineStart, r.lineEnd);
      }),
    );

    return results;
  }

  // ── get_references ──────────────────────────────────────────────────────────

  /**
   * Find all usage sites of a symbol.
   *
   * Resolves via FQN if provided, otherwise searches by name.
   * Enriches top results with 3-line code context.
   */
  async getReferences(
    projectId: string,
    symbolName: string,
    fqn?: string,
  ): Promise<ReferenceResult[]> {
    const repo = getSymbolRepository();
    const refs: SymbolReference[] = fqn
      ? await repo.findReferencesByFqn(projectId, fqn)
      : await repo.findReferencesByName(projectId, symbolName);

    const results: ReferenceResult[] = refs.map((r) => ({
      fromFile: r.from_file,
      fromLine: r.from_line,
      refKind: r.ref_kind,
      symbolName: r.symbol_name,
      targetFqn: r.target_fqn,
    }));

    // Enrich top-20 with code context
    const toEnrich = results.slice(0, 20);
    await Promise.all(
      toEnrich.map(async (r) => {
        r.context = await this.readContext(r.fromFile, r.fromLine, 3);
      }),
    );

    return results;
  }

  // ── get_dependencies ────────────────────────────────────────────────────────

  /**
   * BFS over the import graph to build a file dependency tree.
   * maxDepth default = 3 to avoid graph explosion.
   */
  async getDependencies(
    projectId: string,
    filePath: string,
    maxDepth = 3,
  ): Promise<DependencyGraph> {
    const visited = new Set<string>();
    const nodes: DependencyNode[] = [];
    const edges: DependencyEdge[] = [];
    const queue: Array<{ file: string; depth: number }> = [{ file: filePath, depth: 0 }];

    while (queue.length > 0) {
      const { file, depth } = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);
      nodes.push({ file, depth });

      if (depth >= maxDepth) continue;

      const deps: SymbolImport[] = await getSymbolRepository().findDependencies(projectId, file);
      for (const dep of deps) {
        edges.push({
          from: file,
          to: dep.to_file ?? dep.specifier,
          specifier: dep.specifier,
          importedNames: dep.imported_names,
          isExternal: dep.is_external,
        });
        if (dep.to_file && !visited.has(dep.to_file)) {
          queue.push({ file: dep.to_file, depth: depth + 1 });
        }
      }
    }

    return { nodes, edges };
  }

  // ── list_definitions ────────────────────────────────────────────────────────

  async listDefinitions(
    projectId: string,
    opts: ListDefinitionsOptions = {},
  ): Promise<DefinitionResult[]> {
    const repo = getSymbolRepository();
    const [defs, centrality] = await Promise.all([
      repo.listDefinitions(projectId, opts),
      repo.getCentrality(projectId),
    ]);
    return defs.map((def) => this.toDefinitionResult(def, centrality));
  }

  // ── get_top_central_files ──────────────────────────────────────────────────

  async getTopCentralFiles(projectId: string, limit = 20): Promise<CentralityResult[]> {
    const rows: CentralityEntry[] = await getSymbolRepository().getTopCentralFiles(projectId, limit);
    return rows.map((row) => ({
      filePath: row.file_path,
      score: row.score,
      updatedAt: row.updated_at,
    }));
  }

  // ── project_map ─────────────────────────────────────────────────────────

  /**
   * Aggregate view of a project — stats, central files, symbol breakdown by
   * kind, file count by language extension, and most-recently indexed files.
   * Consumes symbol_files, symbol_definitions, and workspace metadata.
   */
  async getProjectMap(
    projectId: string,
    opts: GetProjectMapOptions = {},
  ): Promise<ProjectMapResult | null> {
    const centralityLimit = opts.centralityLimit ?? 20;
    const recentLimit = opts.recentLimit ?? 10;

    const repo = getSymbolRepository();
    const workspace = await repo.getWorkspace(projectId);
    if (!workspace) return null;

    const [topCentralFiles, aggregates] = await Promise.all([
      this.getTopCentralFiles(projectId, centralityLimit),
      repo.getProjectMapAggregates(projectId, recentLimit),
    ]);

    return {
      projectId,
      stats: {
        files: workspace.files_count,
        chunks: workspace.chunks_count,
        symbols: workspace.symbols_count,
        status: workspace.status,
        lastIndexedAt: workspace.last_indexed_at
          ? new Date(workspace.last_indexed_at).toISOString()
          : null,
      },
      topCentralFiles,
      symbolsByKind: aggregates.symbolsByKind,
      filesByLanguage: aggregates.filesByLanguage,
      recentFiles: aggregates.recentFiles.map((r) => ({
        filePath: r.filePath,
        indexedAt: r.indexedAt ? new Date(r.indexedAt).toISOString() : null,
      })),
    };
  }

  // ── centrality recomputation ─────────────────────────────────────────────

  /**
   * Recompute PageRank scores for all files in the project.
   * Should be called after a full index completes.
   */
  async recomputeCentrality(projectId: string): Promise<void> {
    const t0 = performance.now();

    const repo = getSymbolRepository();
    const [nodes, rawEdges] = await Promise.all([
      repo.allFiles(projectId),
      repo.allImportEdges(projectId),
    ]);

    if (nodes.length === 0) return;

    const edges = rawEdges
      .filter((e) => !!e.to_file)
      .map((e) => ({ from_file: e.from_file, to_file: e.to_file! }));

    const scores = computePageRank(nodes, edges);
    await repo.updateCentrality(projectId, scores);

    logger.info("SymbolGraphService: centrality recomputed", {
      projectId,
      nodes: nodes.length,
      edges: edges.length,
      durationMs: Math.round(performance.now() - t0),
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private toDefinitionResult(
    def: SymbolDefinition,
    centrality: Map<string, number>,
  ): DefinitionResult {
    return {
      fqn: def.id,
      name: def.name,
      kind: def.kind,
      file: def.file_path,
      lineStart: def.line_start,
      lineEnd: def.line_end,
      exported: def.exported,
      docComment: def.doc_comment,
      centralityScore: centrality.get(def.file_path) ?? 0,
    };
  }

  /**
   * Read lines [lineStart, lineEnd] from a relative project path.
   * Used to enrich definition results with code previews.
   */
  private async readSnippet(
    relativePath: string,
    lineStart: number,
    lineEnd: number,
    projectPath?: string,
  ): Promise<string | undefined> {
    // SymbolGraphService doesn't have direct access to projectPath at this layer;
    // snippet is best-effort — resolved via absolute path if file exists.
    try {
      const content = await fs.readFile(relativePath, "utf-8");
      const lines = content.split("\n");
      return lines
        .slice(Math.max(0, lineStart - 1), Math.min(lines.length, lineEnd))
        .join("\n");
    } catch {
      return undefined;
    }
  }

  /** Read N lines of context around a given line number from a relative path. */
  private async readContext(
    relativePath: string,
    lineNumber: number,
    contextLines: number,
  ): Promise<string | undefined> {
    try {
      const content = await fs.readFile(relativePath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, lineNumber - contextLines - 1);
      const end = Math.min(lines.length, lineNumber + contextLines);
      return lines.slice(start, end).join("\n");
    } catch {
      return undefined;
    }
  }
}

export const symbolGraphService = SymbolGraphService.getInstance();
