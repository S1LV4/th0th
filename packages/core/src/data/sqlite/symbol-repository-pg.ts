/**
 * Symbol Repository - PostgreSQL Implementation
 *
 * All queries use raw SQL via $queryRaw / $executeRaw to avoid the
 * Prisma 7.7.0 + Bun ORM bug (isObjectEnumValue is not a function).
 */

import { logger } from "@th0th-ai/shared";
import { getPrismaClient } from "../../services/query/prisma-client.js";

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
  imported_names: string[];
  is_external: boolean;
  is_type_only: boolean;
}

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

// ─── Raw row types returned by $queryRaw ─────────────────────────────────────

interface WsRaw {
  project_id: string;
  project_path: string;
  display_name: string | null;
  status: string;
  last_indexed_at: Date | null;
  last_error: string | null;
  files_count: number;
  chunks_count: number;
  symbols_count: number;
  created_at: Date;
  updated_at: Date;
}

function mapWs(ws: WsRaw): WorkspaceRow {
  return {
    project_id: ws.project_id,
    project_path: ws.project_path,
    display_name: ws.display_name ?? undefined,
    status: ws.status as WorkspaceStatus,
    last_indexed_at: ws.last_indexed_at?.getTime(),
    last_error: ws.last_error ?? undefined,
    files_count: Number(ws.files_count),
    chunks_count: Number(ws.chunks_count),
    symbols_count: Number(ws.symbols_count),
    created_at: ws.created_at.getTime(),
    updated_at: ws.updated_at.getTime(),
  };
}

interface FileRaw {
  project_id: string;
  relative_path: string;
  content_hash: string;
  mtime: bigint;
  size: number;
  indexed_at: Date;
  symbol_count: number;
  chunk_count: number;
}

function mapFile(f: FileRaw): SymbolFileRow {
  return {
    project_id: f.project_id,
    relative_path: f.relative_path,
    content_hash: f.content_hash,
    mtime: Number(f.mtime),
    size: Number(f.size),
    indexed_at: f.indexed_at.getTime(),
    symbol_count: Number(f.symbol_count),
    chunk_count: Number(f.chunk_count),
  };
}

interface DefRaw {
  id: string;
  project_id: string;
  file_path: string;
  name: string;
  kind: string;
  line_start: number;
  line_end: number;
  exported: boolean;
  doc_comment: string | null;
  indexed_at: Date;
}

function mapDef(d: DefRaw): SymbolDefinition {
  return {
    id: d.id,
    project_id: d.project_id,
    file_path: d.file_path,
    name: d.name,
    kind: d.kind as SymbolKind,
    line_start: Number(d.line_start),
    line_end: Number(d.line_end),
    exported: Boolean(d.exported),
    doc_comment: d.doc_comment ?? undefined,
    indexed_at: d.indexed_at.getTime(),
  };
}

interface RefRaw {
  id: number;
  project_id: string;
  from_file: string;
  from_line: number;
  symbol_name: string;
  target_fqn: string;
  ref_kind: string;
}

function mapRef(r: RefRaw): SymbolReference {
  return {
    id: Number(r.id),
    project_id: r.project_id,
    from_file: r.from_file,
    from_line: Number(r.from_line),
    symbol_name: r.symbol_name,
    target_fqn: r.target_fqn,
    ref_kind: r.ref_kind as RefKind,
  };
}

interface ImpRaw {
  id: number;
  project_id: string;
  from_file: string;
  to_file: string | null;
  specifier: string;
  imported_names: string[];
  is_external: boolean;
  is_type_only: boolean;
}

function mapImp(i: ImpRaw): SymbolImport {
  return {
    id: Number(i.id),
    project_id: i.project_id,
    from_file: i.from_file,
    to_file: i.to_file ?? undefined,
    specifier: i.specifier,
    imported_names: Array.isArray(i.imported_names) ? i.imported_names : [],
    is_external: Boolean(i.is_external),
    is_type_only: Boolean(i.is_type_only),
  };
}

// ─── Repository ──────────────────────────────────────────────────────────────

export class SymbolRepositoryPg {
  private static instance: SymbolRepositoryPg | null = null;

  private constructor() {
    logger.info("SymbolRepositoryPg initialized (PostgreSQL)");
  }

  static getInstance(): SymbolRepositoryPg {
    if (!SymbolRepositoryPg.instance) {
      SymbolRepositoryPg.instance = new SymbolRepositoryPg();
    }
    return SymbolRepositoryPg.instance;
  }

  // ─── Workspace operations ─────────────────────────────────────────────────

  async upsertWorkspace(
    ws: Omit<WorkspaceRow, "created_at" | "updated_at"> & {
      created_at?: number;
    },
  ): Promise<void> {
    const lastIndexedAt = ws.last_indexed_at
      ? new Date(ws.last_indexed_at)
      : null;
    const p = getPrismaClient();
    await p.$executeRaw`
      INSERT INTO workspaces (project_id, project_path, display_name, status, last_indexed_at, last_error, files_count, chunks_count, symbols_count, created_at, updated_at)
      VALUES (
        ${ws.project_id}, ${ws.project_path}, ${ws.display_name ?? null},
        ${ws.status}, ${lastIndexedAt}, ${ws.last_error ?? null},
        ${ws.files_count}, ${ws.chunks_count}, ${ws.symbols_count},
        NOW(), NOW()
      )
      ON CONFLICT (project_id) DO UPDATE SET
        project_path    = EXCLUDED.project_path,
        display_name    = EXCLUDED.display_name,
        status          = EXCLUDED.status,
        last_indexed_at = EXCLUDED.last_indexed_at,
        last_error      = EXCLUDED.last_error,
        files_count     = EXCLUDED.files_count,
        chunks_count    = EXCLUDED.chunks_count,
        symbols_count   = EXCLUDED.symbols_count,
        updated_at      = NOW()
    `;
  }

  async updateWorkspaceStatus(
    projectId: string,
    status: WorkspaceStatus,
    opts?:
      | {
          lastError?: string | null;
          lastIndexedAt?: number;
          filesCount?: number;
          chunksCount?: number;
          symbolsCount?: number;
        }
      | string,
  ): Promise<void> {
    const lastError =
      typeof opts === "string" ? opts : (opts?.lastError ?? null);
    const filesCount = typeof opts === "object" ? opts?.filesCount : undefined;
    const chunksCount =
      typeof opts === "object" ? opts?.chunksCount : undefined;
    const symbolsCount =
      typeof opts === "object" ? opts?.symbolsCount : undefined;
    const lastIndexedAt =
      typeof opts === "object" && opts?.lastIndexedAt
        ? new Date(opts.lastIndexedAt)
        : status === "indexed"
          ? new Date()
          : undefined;

    const p = getPrismaClient();
    await p.$executeRaw`
      UPDATE workspaces SET
        status          = ${status},
        last_error      = ${lastError},
        last_indexed_at = ${lastIndexedAt ?? null},
        files_count     = COALESCE(${filesCount ?? null}, files_count),
        chunks_count    = COALESCE(${chunksCount ?? null}, chunks_count),
        symbols_count   = COALESCE(${symbolsCount ?? null}, symbols_count),
        updated_at      = NOW()
      WHERE project_id = ${projectId}
    `;
  }

  async getWorkspace(projectId: string): Promise<WorkspaceRow | null> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<WsRaw[]>`
      SELECT * FROM workspaces WHERE project_id = ${projectId} LIMIT 1
    `;
    return rows.length > 0 ? mapWs(rows[0]) : null;
  }

  async listWorkspaces(): Promise<WorkspaceRow[]> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<WsRaw[]>`
      SELECT * FROM workspaces ORDER BY updated_at DESC
    `;
    return rows.map(mapWs);
  }

  async deleteWorkspace(projectId: string): Promise<void> {
    const p = getPrismaClient();
    await p.$executeRaw`DELETE FROM workspaces WHERE project_id = ${projectId}`;
  }

  // ─── File operations ───────────────────────────────────────────────────────

  async upsertFile(file: SymbolFileRow): Promise<void> {
    const p = getPrismaClient();
    await p.$executeRaw`
      INSERT INTO symbol_files (project_id, relative_path, content_hash, mtime, size, indexed_at, symbol_count, chunk_count)
      VALUES (${file.project_id}, ${file.relative_path}, ${file.content_hash}, ${BigInt(Math.trunc(file.mtime))}, ${file.size}, ${new Date(file.indexed_at)}, ${file.symbol_count}, ${file.chunk_count})
      ON CONFLICT (project_id, relative_path) DO UPDATE SET
        content_hash = EXCLUDED.content_hash,
        mtime        = EXCLUDED.mtime,
        size         = EXCLUDED.size,
        indexed_at   = EXCLUDED.indexed_at,
        symbol_count = EXCLUDED.symbol_count,
        chunk_count  = EXCLUDED.chunk_count
    `;
  }

  async getFile(
    projectId: string,
    relativePath: string,
  ): Promise<SymbolFileRow | null> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<FileRaw[]>`
      SELECT * FROM symbol_files WHERE project_id = ${projectId} AND relative_path = ${relativePath} LIMIT 1
    `;
    return rows.length > 0 ? mapFile(rows[0]) : null;
  }

  // ─── Definition operations ─────────────────────────────────────────────────

  async upsertDefinition(def: SymbolDefinition): Promise<void> {
    const p = getPrismaClient();
    await p.$executeRaw`
      INSERT INTO symbol_definitions (id, project_id, file_path, name, kind, line_start, line_end, exported, doc_comment, indexed_at)
      VALUES (${def.id}, ${def.project_id}, ${def.file_path}, ${def.name}, ${def.kind}, ${def.line_start}, ${def.line_end}, ${def.exported}, ${def.doc_comment ?? null}, ${new Date(def.indexed_at)})
      ON CONFLICT (project_id, id) DO UPDATE SET
        file_path   = EXCLUDED.file_path,
        name        = EXCLUDED.name,
        kind        = EXCLUDED.kind,
        line_start  = EXCLUDED.line_start,
        line_end    = EXCLUDED.line_end,
        exported    = EXCLUDED.exported,
        doc_comment = EXCLUDED.doc_comment,
        indexed_at  = EXCLUDED.indexed_at
    `;
  }

  async deleteDefinitionsByFile(
    projectId: string,
    filePath: string,
  ): Promise<number> {
    const p = getPrismaClient();
    await p.$executeRaw`DELETE FROM symbol_definitions WHERE project_id = ${projectId} AND file_path = ${filePath}`;
    return 0; // count not needed by callers
  }

  async searchDefinitions(
    projectId: string,
    query?: string,
    kinds?: SymbolKind[],
    exportedOnly?: boolean,
    limit: number = 20,
  ): Promise<SymbolDefinition[]> {
    const p = getPrismaClient();
    // Build dynamic WHERE clauses via raw SQL
    const kindList = kinds && kinds.length > 0 ? kinds : null;
    const rows = await p.$queryRaw<DefRaw[]>`
      SELECT * FROM symbol_definitions
      WHERE project_id = ${projectId}
        AND (${query ?? null}::text IS NULL OR name ILIKE ${"%" + (query ?? "") + "%"})
        AND (${kindList}::text[] IS NULL OR kind = ANY(${kindList}::text[]))
        AND (${exportedOnly ?? false} = false OR exported = true)
      ORDER BY name ASC
      LIMIT ${limit}
    `;
    return rows.map(mapDef);
  }

  async getDefinition(
    projectId: string,
    fqn: string,
  ): Promise<SymbolDefinition | null> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<DefRaw[]>`
      SELECT * FROM symbol_definitions WHERE project_id = ${projectId} AND id = ${fqn} LIMIT 1
    `;
    return rows.length > 0 ? mapDef(rows[0]) : null;
  }

  // ─── Reference operations ──────────────────────────────────────────────────

  async insertReference(ref: SymbolReference): Promise<void> {
    const p = getPrismaClient();
    await p.$executeRaw`
      INSERT INTO symbol_references (project_id, from_file, from_line, symbol_name, target_fqn, ref_kind)
      VALUES (${ref.project_id}, ${ref.from_file}, ${ref.from_line}, ${ref.symbol_name}, ${ref.target_fqn ?? "unknown"}, ${ref.ref_kind})
    `;
  }

  async deleteReferencesByFile(
    projectId: string,
    filePath: string,
  ): Promise<number> {
    const p = getPrismaClient();
    await p.$executeRaw`DELETE FROM symbol_references WHERE project_id = ${projectId} AND from_file = ${filePath}`;
    return 0;
  }

  async getReferences(
    projectId: string,
    symbolName: string,
    limit: number = 50,
  ): Promise<SymbolReference[]> {
    const p = getPrismaClient();
    const suffix = `#${symbolName}`;
    const rows = await p.$queryRaw<RefRaw[]>`
      SELECT * FROM symbol_references
      WHERE project_id = ${projectId}
        AND (symbol_name = ${symbolName} OR target_fqn LIKE ${"%" + suffix})
      ORDER BY from_file ASC, from_line ASC
      LIMIT ${limit}
    `;
    return rows.map(mapRef);
  }

  // ─── Import operations ─────────────────────────────────────────────────────

  async insertImport(imp: SymbolImport): Promise<void> {
    const p = getPrismaClient();
    await p.$executeRaw`
      INSERT INTO symbol_imports (project_id, from_file, to_file, specifier, imported_names, is_external, is_type_only)
      VALUES (${imp.project_id}, ${imp.from_file}, ${imp.to_file ?? null}, ${imp.specifier}, ${imp.imported_names}, ${imp.is_external}, ${imp.is_type_only})
    `;
  }

  async deleteImportsByFile(
    projectId: string,
    filePath: string,
  ): Promise<number> {
    const p = getPrismaClient();
    await p.$executeRaw`DELETE FROM symbol_imports WHERE project_id = ${projectId} AND from_file = ${filePath}`;
    return 0;
  }

  async getImportsFrom(
    projectId: string,
    filePath: string,
  ): Promise<SymbolImport[]> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<ImpRaw[]>`
      SELECT * FROM symbol_imports WHERE project_id = ${projectId} AND from_file = ${filePath}
    `;
    return rows.map(mapImp);
  }

  // ─── Centrality operations ─────────────────────────────────────────────────

  async upsertCentrality(entry: CentralityEntry): Promise<void> {
    const p = getPrismaClient();
    await p.$executeRaw`
      INSERT INTO symbol_centrality (project_id, file_path, score, updated_at)
      VALUES (${entry.project_id}, ${entry.file_path}, ${entry.score}, ${new Date(entry.updated_at)})
      ON CONFLICT (project_id, file_path) DO UPDATE SET
        score      = EXCLUDED.score,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async getTopCentralFiles(
    projectId: string,
    limit: number = 20,
  ): Promise<CentralityEntry[]> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<
      {
        project_id: string;
        file_path: string;
        score: number;
        updated_at: Date;
      }[]
    >`
      SELECT * FROM symbol_centrality WHERE project_id = ${projectId} ORDER BY score DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({
      project_id: r.project_id,
      file_path: r.file_path,
      score: Number(r.score),
      updated_at: r.updated_at.getTime(),
    }));
  }

  /**
   * Aggregates used to build a project map in a single round trip:
   * symbols grouped by kind, files grouped by extension, and the most
   * recently indexed files (absolute timestamp for the caller to format).
   */
  async getProjectMapAggregates(
    projectId: string,
    recentLimit: number = 10,
  ): Promise<{
    symbolsByKind: Record<string, number>;
    filesByLanguage: Record<string, number>;
    recentFiles: Array<{ filePath: string; indexedAt: number | null }>;
  }> {
    const p = getPrismaClient();

    const [kindRows, langRows, recentRows] = await Promise.all([
      p.$queryRaw<{ kind: string; count: bigint }[]>`
        SELECT kind, COUNT(*)::bigint AS count
        FROM symbol_definitions
        WHERE project_id = ${projectId}
        GROUP BY kind
        ORDER BY count DESC
      `,
      // Postgres-native extension extraction; NULLIF avoids treating files
      // without a dot as extension "" (they fall under "other").
      p.$queryRaw<{ ext: string | null; count: bigint }[]>`
        SELECT LOWER(NULLIF(SUBSTRING(relative_path FROM '\\.([^./\\\\]+)$'), '')) AS ext,
               COUNT(*)::bigint AS count
        FROM symbol_files
        WHERE project_id = ${projectId}
        GROUP BY ext
        ORDER BY count DESC
      `,
      p.$queryRaw<{ relative_path: string; indexed_at: Date }[]>`
        SELECT relative_path, indexed_at
        FROM symbol_files
        WHERE project_id = ${projectId}
        ORDER BY indexed_at DESC
        LIMIT ${recentLimit}
      `,
    ]);

    const symbolsByKind: Record<string, number> = {};
    for (const row of kindRows) symbolsByKind[row.kind] = Number(row.count);

    const filesByLanguage: Record<string, number> = {};
    for (const row of langRows) {
      const key = row.ext ?? "other";
      filesByLanguage[key] = Number(row.count);
    }

    const recentFiles = recentRows.map((r) => ({
      filePath: r.relative_path,
      indexedAt: r.indexed_at ? r.indexed_at.getTime() : null,
    }));

    return { symbolsByKind, filesByLanguage, recentFiles };
  }

  async getCentrality(projectId: string): Promise<Map<string, number>> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<{ file_path: string; score: number }[]>`
      SELECT file_path, score FROM symbol_centrality WHERE project_id = ${projectId}
    `;
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.file_path, Number(r.score));
    return map;
  }

  // ─── Batch operations ──────────────────────────────────────────────────────

  async batchUpsertDefinitions(defs: SymbolDefinition[]): Promise<void> {
    if (defs.length === 0) return;
    const p = getPrismaClient();
    await p.$transaction(async (tx) => {
      for (const def of defs) {
        await tx.$executeRaw`
          INSERT INTO symbol_definitions (id, project_id, file_path, name, kind, line_start, line_end, exported, doc_comment, indexed_at)
          VALUES (${def.id}, ${def.project_id}, ${def.file_path}, ${def.name}, ${def.kind}, ${def.line_start}, ${def.line_end}, ${def.exported}, ${def.doc_comment ?? null}, ${new Date(def.indexed_at)})
          ON CONFLICT (project_id, id) DO UPDATE SET
            file_path   = EXCLUDED.file_path,
            name        = EXCLUDED.name,
            kind        = EXCLUDED.kind,
            line_start  = EXCLUDED.line_start,
            line_end    = EXCLUDED.line_end,
            exported    = EXCLUDED.exported,
            doc_comment = EXCLUDED.doc_comment,
            indexed_at  = EXCLUDED.indexed_at
        `;
      }
    });
  }

  async batchInsertReferences(refs: SymbolReference[]): Promise<void> {
    if (refs.length === 0) return;
    const p = getPrismaClient();
    await p.$transaction(async (tx) => {
      for (const ref of refs) {
        if (!ref.target_fqn) continue;
        await tx.$executeRaw`
          INSERT INTO symbol_references (project_id, from_file, from_line, symbol_name, target_fqn, ref_kind)
          VALUES (${ref.project_id}, ${ref.from_file}, ${ref.from_line}, ${ref.symbol_name}, ${ref.target_fqn}, ${ref.ref_kind})
        `;
      }
    });
  }

  async batchInsertImports(imports: SymbolImport[]): Promise<void> {
    if (imports.length === 0) return;
    const p = getPrismaClient();
    await p.$transaction(async (tx) => {
      for (const imp of imports) {
        await tx.$executeRaw`
          INSERT INTO symbol_imports (project_id, from_file, to_file, specifier, imported_names, is_external, is_type_only)
          VALUES (${imp.project_id}, ${imp.from_file}, ${imp.to_file ?? null}, ${imp.specifier}, ${imp.imported_names}, ${imp.is_external}, ${imp.is_type_only})
        `;
      }
    });
  }

  // ── High-level composite operations ──────────────────────────────────────

  async writeFileSymbols(
    projectId: string,
    filePath: string,
    defs: SymbolDefinition[],
    refs: SymbolReference[],
    imports: SymbolImport[],
  ): Promise<void> {
    const now = new Date();

    await getPrismaClient().$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM symbol_definitions WHERE project_id = ${projectId} AND file_path = ${filePath}`;
      await tx.$executeRaw`DELETE FROM symbol_references WHERE project_id = ${projectId} AND from_file = ${filePath}`;
      await tx.$executeRaw`DELETE FROM symbol_imports WHERE project_id = ${projectId} AND from_file = ${filePath}`;

      for (const def of defs) {
        await tx.$executeRaw`
          INSERT INTO symbol_definitions (id, project_id, file_path, name, kind, line_start, line_end, exported, doc_comment, indexed_at)
          VALUES (${def.id}, ${projectId}, ${filePath}, ${def.name}, ${def.kind}, ${def.line_start}, ${def.line_end}, ${def.exported}, ${def.doc_comment ?? null}, ${now})
          ON CONFLICT (project_id, id) DO UPDATE SET
            file_path   = EXCLUDED.file_path,
            name        = EXCLUDED.name,
            kind        = EXCLUDED.kind,
            line_start  = EXCLUDED.line_start,
            line_end    = EXCLUDED.line_end,
            exported    = EXCLUDED.exported,
            doc_comment = EXCLUDED.doc_comment,
            indexed_at  = EXCLUDED.indexed_at
        `;
      }

      for (const ref of refs) {
        if (!ref.target_fqn) continue;
        await tx.$executeRaw`
          INSERT INTO symbol_references (project_id, from_file, from_line, symbol_name, target_fqn, ref_kind)
          VALUES (${projectId}, ${filePath}, ${ref.from_line}, ${ref.symbol_name}, ${ref.target_fqn}, ${ref.ref_kind})
        `;
      }

      for (const imp of imports) {
        await tx.$executeRaw`
          INSERT INTO symbol_imports (project_id, from_file, to_file, specifier, imported_names, is_external, is_type_only)
          VALUES (${projectId}, ${filePath}, ${imp.to_file ?? null}, ${imp.specifier}, ${imp.imported_names}, ${imp.is_external}, ${imp.is_type_only})
        `;
      }
    });
  }

  async clearProject(projectId: string): Promise<void> {
    const p = getPrismaClient();
    await p.$executeRaw`DELETE FROM workspaces WHERE project_id = ${projectId}`;
  }

  // ── Query helpers ────────────────────────────────────────────────────────

  async findDefinitionsByName(
    projectId: string,
    name: string,
  ): Promise<SymbolDefinition[]> {
    return this.searchDefinitions(projectId, name);
  }

  async findDefinitionByFqn(
    projectId: string,
    fqn: string,
  ): Promise<SymbolDefinition | null> {
    return this.getDefinition(projectId, fqn);
  }

  /** All file paths for a project (used by centrality / hasData checks). */
  async allFiles(projectId: string): Promise<string[]> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<{ relative_path: string }[]>`
      SELECT relative_path FROM symbol_files WHERE project_id = ${projectId}
    `;
    return rows.map((r) => r.relative_path);
  }

  /** All import edges for a project (used by PageRank). */
  async allImportEdges(projectId: string): Promise<SymbolImport[]> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<ImpRaw[]>`
      SELECT * FROM symbol_imports WHERE project_id = ${projectId}
    `;
    return rows.map(mapImp);
  }

  /** Imports originating from a specific file (alias for getImportsFrom). */
  async findDependencies(
    projectId: string,
    fromFile: string,
  ): Promise<SymbolImport[]> {
    return this.getImportsFrom(projectId, fromFile);
  }

  /** References matching by target FQN. */
  async findReferencesByFqn(
    projectId: string,
    fqn: string,
  ): Promise<SymbolReference[]> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<RefRaw[]>`
      SELECT * FROM symbol_references
      WHERE project_id = ${projectId} AND target_fqn = ${fqn}
      ORDER BY from_file ASC, from_line ASC
    `;
    return rows.map(mapRef);
  }

  /** References matching by symbol name. */
  async findReferencesByName(
    projectId: string,
    symbolName: string,
  ): Promise<SymbolReference[]> {
    const p = getPrismaClient();
    const rows = await p.$queryRaw<RefRaw[]>`
      SELECT * FROM symbol_references
      WHERE project_id = ${projectId} AND symbol_name = ${symbolName}
      ORDER BY from_file ASC, from_line ASC
    `;
    return rows.map(mapRef);
  }

  /** List definitions with filter options (mirrors SQLite SymbolRepository.listDefinitions). */
  async listDefinitions(
    projectId: string,
    opts: {
      query?: string;
      kinds?: SymbolKind[];
      exportedOnly?: boolean;
      limit?: number;
    } = {},
  ): Promise<SymbolDefinition[]> {
    return this.searchDefinitions(
      projectId,
      opts.query,
      opts.kinds,
      opts.exportedOnly,
      opts.limit ?? 100,
    );
  }

  /** Batch-update centrality scores computed by PageRank. */
  async updateCentrality(
    projectId: string,
    scores: Map<string, number>,
  ): Promise<void> {
    if (scores.size === 0) return;
    const p = getPrismaClient();
    const now = new Date();
    await p.$transaction(async (tx) => {
      for (const [filePath, score] of scores) {
        await tx.$executeRaw`
          INSERT INTO symbol_centrality (project_id, file_path, score, updated_at)
          VALUES (${projectId}, ${filePath}, ${score}, ${now})
          ON CONFLICT (project_id, file_path) DO UPDATE SET
            score      = EXCLUDED.score,
            updated_at = EXCLUDED.updated_at
        `;
      }
    });
  }
}
