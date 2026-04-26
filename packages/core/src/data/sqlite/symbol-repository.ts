/**
 * Symbol Repository
 *
 * Low-level CRUD for symbol_definitions, symbol_references, symbol_imports,
 * symbol_files, symbol_centrality, and workspaces tables.
 *
 * All writes use bun:sqlite synchronous API wrapped in transactions for atomicity.
 * All reads return plain objects (no ORM layer).
 */

import type { Database, Statement } from "bun:sqlite";
import { symbolDb } from "./symbol-db.js";

// ─── Domain types ────────────────────────────────────────────────────────────

export type SymbolKind =
  | "function"
  | "class"
  | "variable"
  | "type"
  | "interface"
  | "export";

export type RefKind = "call" | "type_ref" | "import" | "extend" | "implement";

export type WorkspaceStatus = "pending" | "indexing" | "indexed" | "error";

export interface SymbolFileRow {
  project_id: string;
  relative_path: string;
  content_hash: string;
  mtime: number;
  size: number;
  indexed_at: number;
  symbol_count: number;
  chunk_count: number;
}

export interface SymbolDefinition {
  id: string; // fqn: 'relative/path.ts#Name'
  project_id: string;
  file_path: string;
  name: string;
  kind: SymbolKind;
  line_start: number;
  line_end: number;
  exported: boolean;
  doc_comment?: string;
  indexed_at: number;
}

export interface SymbolReference {
  id?: number;
  project_id: string;
  from_file: string;
  from_line: number;
  symbol_name: string;
  target_fqn?: string;
  ref_kind: RefKind;
}

export interface SymbolImport {
  id?: number;
  project_id: string;
  from_file: string;
  to_file?: string;
  specifier: string;
  imported_names: string[]; // stored as JSON
  is_external: boolean;
  is_type_only: boolean;
}

/** Raw row shape as returned from SQLite (imported_names is a JSON string) */
type SymbolImportRow = Omit<SymbolImport, "imported_names" | "is_external" | "is_type_only"> & {
  imported_names: string;
  is_external: number;
  is_type_only: number;
};

export interface CentralityEntry {
  project_id: string;
  file_path: string;
  score: number;
  updated_at: number;
}

export interface WorkspaceRow {
  project_id: string;
  project_path: string;
  display_name?: string;
  status: WorkspaceStatus;
  last_indexed_at?: number;
  last_error?: string;
  files_count: number;
  chunks_count: number;
  symbols_count: number;
  created_at: number;
  updated_at: number;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export class SymbolRepository {
  private static instance: SymbolRepository | null = null;
  private db: Database;

  // Prepared statements (cached for performance)
  private stmts!: {
    upsertFile: Statement;
    getFile: Statement;
    upsertDef: Statement;
    deleteDefs: Statement;
    upsertRef: Statement;
    deleteRefs: Statement;
    upsertImport: Statement;
    deleteImports: Statement;
    upsertCentrality: Statement;
    upsertWorkspace: Statement;
    updateWorkspaceStatus: Statement;
    getWorkspace: Statement;
    listWorkspaces: Statement;
    deleteWorkspace: Statement;
  };

  private constructor() {
    this.db = symbolDb.getDb();
    this.prepareStatements();
  }

  static getInstance(): SymbolRepository {
    if (!SymbolRepository.instance) {
      SymbolRepository.instance = new SymbolRepository();
    }
    return SymbolRepository.instance;
  }

  private prepareStatements(): void {
    this.stmts = {
      upsertFile: this.db.prepare(`
        INSERT INTO symbol_files
          (project_id, relative_path, content_hash, mtime, size, indexed_at, symbol_count, chunk_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, relative_path) DO UPDATE SET
          content_hash = excluded.content_hash,
          mtime        = excluded.mtime,
          size         = excluded.size,
          indexed_at   = excluded.indexed_at,
          symbol_count = excluded.symbol_count,
          chunk_count  = excluded.chunk_count
      `),

      getFile: this.db.prepare(`
        SELECT * FROM symbol_files
        WHERE project_id = ? AND relative_path = ?
      `),

      upsertDef: this.db.prepare(`
        INSERT INTO symbol_definitions
          (id, project_id, file_path, name, kind, line_start, line_end, exported, doc_comment, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, id) DO UPDATE SET
          file_path   = excluded.file_path,
          name        = excluded.name,
          kind        = excluded.kind,
          line_start  = excluded.line_start,
          line_end    = excluded.line_end,
          exported    = excluded.exported,
          doc_comment = excluded.doc_comment,
          indexed_at  = excluded.indexed_at
      `),

      deleteDefs: this.db.prepare(`
        DELETE FROM symbol_definitions WHERE project_id = ? AND file_path = ?
      `),

      upsertRef: this.db.prepare(`
        INSERT INTO symbol_references
          (project_id, from_file, from_line, symbol_name, target_fqn, ref_kind)
        VALUES (?, ?, ?, ?, ?, ?)
      `),

      deleteRefs: this.db.prepare(`
        DELETE FROM symbol_references WHERE project_id = ? AND from_file = ?
      `),

      upsertImport: this.db.prepare(`
        INSERT INTO symbol_imports
          (project_id, from_file, to_file, specifier, imported_names, is_external, is_type_only)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),

      deleteImports: this.db.prepare(`
        DELETE FROM symbol_imports WHERE project_id = ? AND from_file = ?
      `),

      upsertCentrality: this.db.prepare(`
        INSERT INTO symbol_centrality (project_id, file_path, score, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, file_path) DO UPDATE SET
          score      = excluded.score,
          updated_at = excluded.updated_at
      `),

      upsertWorkspace: this.db.prepare(`
        INSERT INTO workspaces
          (project_id, project_path, display_name, status, files_count, chunks_count, symbols_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          project_path = excluded.project_path,
          display_name = excluded.display_name,
          status       = excluded.status,
          files_count  = excluded.files_count,
          chunks_count = excluded.chunks_count,
          symbols_count= excluded.symbols_count,
          updated_at   = excluded.updated_at
      `),

      updateWorkspaceStatus: this.db.prepare(`
        UPDATE workspaces
        SET status = ?, last_indexed_at = ?, last_error = ?, files_count = ?,
            chunks_count = ?, symbols_count = ?, updated_at = ?
        WHERE project_id = ?
      `),

      getWorkspace: this.db.prepare(`
        SELECT * FROM workspaces WHERE project_id = ?
      `),

      listWorkspaces: this.db.prepare(`
        SELECT * FROM workspaces ORDER BY updated_at DESC
      `),

      deleteWorkspace: this.db.prepare(`
        DELETE FROM workspaces WHERE project_id = ?
      `),
    };
  }

  // ─── File fingerprints ────────────────────────────────────────────────────

  upsertFile(row: SymbolFileRow): void {
    this.stmts.upsertFile.run(
      row.project_id,
      row.relative_path,
      row.content_hash,
      row.mtime,
      row.size,
      row.indexed_at,
      row.symbol_count,
      row.chunk_count,
    );
  }

  getFile(projectId: string, relativePath: string): SymbolFileRow | null {
    return (this.stmts.getFile.get(projectId, relativePath) as SymbolFileRow) ?? null;
  }

  /** Bulk-write symbols for one file inside a single transaction. */
  writeFileSymbols(
    projectId: string,
    filePath: string,
    defs: SymbolDefinition[],
    refs: SymbolReference[],
    imports: SymbolImport[],
  ): void {
    const tx = this.db.transaction(() => {
      // Wipe previous data for this file (incremental reindex)
      this.stmts.deleteDefs.run(projectId, filePath);
      this.stmts.deleteRefs.run(projectId, filePath);
      this.stmts.deleteImports.run(projectId, filePath);

      for (const def of defs) {
        this.stmts.upsertDef.run(
          def.id,
          def.project_id,
          def.file_path,
          def.name,
          def.kind,
          def.line_start,
          def.line_end,
          def.exported ? 1 : 0,
          def.doc_comment ?? null,
          def.indexed_at,
        );
      }

      for (const ref of refs) {
        this.stmts.upsertRef.run(
          ref.project_id,
          ref.from_file,
          ref.from_line,
          ref.symbol_name,
          ref.target_fqn ?? null,
          ref.ref_kind,
        );
      }

      for (const imp of imports) {
        this.stmts.upsertImport.run(
          imp.project_id,
          imp.from_file,
          imp.to_file ?? null,
          imp.specifier,
          JSON.stringify(imp.imported_names),
          imp.is_external ? 1 : 0,
          imp.is_type_only ? 1 : 0,
        );
      }
    });
    tx();
  }

  /** Delete all symbol data for a project (full clear before reindex). */
  clearProject(projectId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM symbol_definitions WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM symbol_references  WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM symbol_imports     WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM symbol_files       WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM symbol_centrality  WHERE project_id = ?").run(projectId);
    });
    tx();
  }

  // ─── Definitions ─────────────────────────────────────────────────────────

  findDefinitionsByName(projectId: string, name: string): SymbolDefinition[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM symbol_definitions WHERE project_id = ? AND name = ? COLLATE NOCASE`,
        )
        .all(projectId, name) as SymbolDefinition[]
    ).map(this.normalizeDef);
  }

  findDefinitionByFqn(projectId: string, fqn: string): SymbolDefinition | null {
    const row = this.db
      .prepare(`SELECT * FROM symbol_definitions WHERE project_id = ? AND id = ?`)
      .get(projectId, fqn) as SymbolDefinition | null;
    return row ? this.normalizeDef(row) : null;
  }

  listDefinitions(
    projectId: string,
    opts: {
      kind?: string[];
      file?: string;
      exportedOnly?: boolean;
      search?: string;
      limit?: number;
    } = {},
  ): SymbolDefinition[] {
    const conditions: string[] = ["project_id = ?"];
    const params: unknown[] = [projectId];

    if (opts.kind && opts.kind.length > 0) {
      conditions.push(`kind IN (${opts.kind.map(() => "?").join(",")})`);
      params.push(...opts.kind);
    }
    if (opts.file) {
      conditions.push("file_path = ?");
      params.push(opts.file);
    }
    if (opts.exportedOnly) {
      conditions.push("exported = 1");
    }
    if (opts.search) {
      conditions.push("name LIKE ? COLLATE NOCASE");
      params.push(`%${opts.search}%`);
    }

    const limit = opts.limit ?? 50;
    const sql = `SELECT * FROM symbol_definitions WHERE ${conditions.join(" AND ")} ORDER BY name LIMIT ?`;
    params.push(limit);

    // bun:sqlite Statement.all() accepts individual binding args; spread is typed correctly here
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db.prepare(sql).all(...(params as any[])) as SymbolDefinition[]).map(this.normalizeDef);
  }

  // ─── References ──────────────────────────────────────────────────────────

  findReferencesByFqn(projectId: string, targetFqn: string): SymbolReference[] {
    return this.db
      .prepare(
        `SELECT * FROM symbol_references WHERE project_id = ? AND target_fqn = ? ORDER BY from_file, from_line`,
      )
      .all(projectId, targetFqn) as SymbolReference[];
  }

  findReferencesByName(projectId: string, symbolName: string): SymbolReference[] {
    return this.db
      .prepare(
        `SELECT * FROM symbol_references WHERE project_id = ? AND symbol_name = ? COLLATE NOCASE ORDER BY from_file, from_line`,
      )
      .all(projectId, symbolName) as SymbolReference[];
  }

  // ─── Imports ─────────────────────────────────────────────────────────────

  findDependencies(projectId: string, filePath: string): SymbolImport[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM symbol_imports WHERE project_id = ? AND from_file = ?`,
        )
        .all(projectId, filePath) as SymbolImportRow[]
    ).map(this.normalizeImport);
  }

  findImporters(projectId: string, filePath: string): SymbolImport[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM symbol_imports WHERE project_id = ? AND to_file = ?`,
        )
        .all(projectId, filePath) as SymbolImportRow[]
    ).map(this.normalizeImport);
  }

  /** All internal (non-external) import edges for PageRank computation. */
  allImportEdges(projectId: string): Array<{ from_file: string; to_file: string }> {
    return this.db
      .prepare(
        `SELECT from_file, to_file FROM symbol_imports WHERE project_id = ? AND is_external = 0 AND to_file IS NOT NULL`,
      )
      .all(projectId) as Array<{ from_file: string; to_file: string }>;
  }

  /**
   * All unique file paths in the project — from definitions AND import edges.
   * This ensures files that only re-export (no own definitions) are included
   * in the PageRank graph as valid nodes.
   */
  allFiles(projectId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT file_path FROM (
            SELECT file_path FROM symbol_definitions WHERE project_id = ?
            UNION
            SELECT from_file AS file_path FROM symbol_imports WHERE project_id = ? AND is_external = 0
            UNION
            SELECT to_file AS file_path FROM symbol_imports WHERE project_id = ? AND is_external = 0 AND to_file IS NOT NULL
          )`,
        )
        .all(projectId, projectId, projectId) as Array<{ file_path: string }>
    ).map((r) => r.file_path);
  }

  // ─── Centrality ──────────────────────────────────────────────────────────

  updateCentrality(projectId: string, scores: Map<string, number>): void {
    const tx = this.db.transaction(() => {
      const now = Date.now();
      for (const [filePath, score] of scores) {
        this.stmts.upsertCentrality.run(projectId, filePath, score, now);
      }
    });
    tx();
  }

  getCentrality(projectId: string): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT file_path, score FROM symbol_centrality WHERE project_id = ?`)
      .all(projectId) as Array<{ file_path: string; score: number }>;

    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.file_path, r.score);
    }
    return map;
  }

  getTopCentralFiles(projectId: string, limit = 20): CentralityEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM symbol_centrality WHERE project_id = ? ORDER BY score DESC LIMIT ?`,
      )
      .all(projectId, limit) as CentralityEntry[];
  }

  // ─── Workspaces ──────────────────────────────────────────────────────────

  upsertWorkspace(row: Omit<WorkspaceRow, "created_at" | "updated_at"> & { created_at?: number }): void {
    const now = Date.now();
    this.stmts.upsertWorkspace.run(
      row.project_id,
      row.project_path,
      row.display_name ?? null,
      row.status,
      row.files_count,
      row.chunks_count,
      row.symbols_count,
      row.created_at ?? now,
      now,
    );
  }

  updateWorkspaceStatus(
    projectId: string,
    status: WorkspaceStatus,
    opts: {
      lastIndexedAt?: number;
      lastError?: string | null;
      filesCount?: number;
      chunksCount?: number;
      symbolsCount?: number;
    } = {},
  ): void {
    this.stmts.updateWorkspaceStatus.run(
      status,
      opts.lastIndexedAt ?? null,
      opts.lastError ?? null,
      opts.filesCount ?? 0,
      opts.chunksCount ?? 0,
      opts.symbolsCount ?? 0,
      Date.now(),
      projectId,
    );
  }

  getWorkspace(projectId: string): WorkspaceRow | null {
    return (this.stmts.getWorkspace.get(projectId) as WorkspaceRow) ?? null;
  }

  async getProjectMapAggregates(
    projectId: string,
    recentLimit: number = 10,
  ): Promise<{
    symbolsByKind: Record<string, number>;
    filesByLanguage: Record<string, number>;
    recentFiles: Array<{ filePath: string; indexedAt: number | null }>;
  }> {
    const kindRows = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM symbol_definitions WHERE project_id = ? GROUP BY kind ORDER BY count DESC`,
      )
      .all(projectId) as Array<{ kind: string; count: number }>;

    const fileRows = this.db
      .prepare(`SELECT relative_path FROM symbol_files WHERE project_id = ?`)
      .all(projectId) as Array<{ relative_path: string }>;

    const recentRows = this.db
      .prepare(
        `SELECT relative_path, indexed_at FROM symbol_files WHERE project_id = ? ORDER BY indexed_at DESC LIMIT ?`,
      )
      .all(projectId, recentLimit) as Array<{ relative_path: string; indexed_at: number | null }>;

    const symbolsByKind: Record<string, number> = {};
    for (const row of kindRows) symbolsByKind[row.kind] = row.count;

    const filesByLanguage: Record<string, number> = {};
    for (const row of fileRows) {
      const dot = row.relative_path.lastIndexOf(".");
      const ext = dot >= 0 ? row.relative_path.slice(dot + 1).toLowerCase() : "other";
      filesByLanguage[ext] = (filesByLanguage[ext] ?? 0) + 1;
    }

    const recentFiles = recentRows.map((r) => ({
      filePath: r.relative_path,
      indexedAt: r.indexed_at ?? null,
    }));

    return { symbolsByKind, filesByLanguage, recentFiles };
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.stmts.listWorkspaces.all() as WorkspaceRow[];
  }

  deleteWorkspace(projectId: string): void {
    this.stmts.deleteWorkspace.run(projectId);
  }

  // ─── Normalizers ─────────────────────────────────────────────────────────

  private normalizeDef(row: SymbolDefinition): SymbolDefinition {
    return { ...row, exported: Boolean(row.exported) };
  }

  private normalizeImport(row: SymbolImportRow): SymbolImport {
    return {
      ...row,
      imported_names:
        typeof row.imported_names === "string"
          ? JSON.parse(row.imported_names)
          : row.imported_names,
      is_external: Boolean(row.is_external),
      is_type_only: Boolean(row.is_type_only),
    };
  }
}

export const symbolRepository = SymbolRepository.getInstance();
