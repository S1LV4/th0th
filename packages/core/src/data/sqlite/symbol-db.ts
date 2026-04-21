/**
 * Symbol Database
 *
 * SQLite schema for the symbol graph: definitions, references, imports,
 * file fingerprints, centrality scores, and workspace status.
 *
 * This is the persistence backbone for the ETL pipeline and all
 * cross-file navigation (go_to_definition, get_references, dependencies).
 */

import { Database } from "bun:sqlite";
import { config } from "@th0th-ai/shared";
import { logger } from "@th0th-ai/shared";
import path from "path";
import fs from "fs";

const SCHEMA_VERSION = 1;

/**
 * Singleton Symbol DB — one shared SQLite file per process.
 * With TH0TH_SYMBOL_DB_SHARDING=true, each projectId gets its own file.
 */
export class SymbolDb {
  private static instance: SymbolDb | null = null;
  private db!: Database;
  private dbPath: string;

  private constructor() {
    const vectorConfig = config.get("vectorStore") as Record<string, unknown>;
    const dataDir = path.dirname(vectorConfig.dbPath as string);
    this.dbPath = path.join(dataDir, "symbols.db");
    this.initialize();
  }

  static getInstance(): SymbolDb {
    if (!SymbolDb.instance) {
      SymbolDb.instance = new SymbolDb();
    }
    return SymbolDb.instance;
  }

  getDb(): Database {
    return this.db;
  }

  /** Returns a shard db path for a given projectId (sharding mode). */
  static shardPath(projectId: string): string {
    const vectorConfig = config.get("vectorStore") as Record<string, unknown>;
    const dataDir = path.dirname(vectorConfig.dbPath as string);
    return path.join(dataDir, `symbols-${projectId}.db`);
  }

  private initialize(): void {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath);

      // WAL mode for concurrent read/write
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA busy_timeout = 10000");
      this.db.exec("PRAGMA foreign_keys = ON");

      this.runMigrations();

      logger.info("SymbolDb initialized", { dbPath: this.dbPath });
    } catch (error) {
      logger.error("Failed to initialize SymbolDb", error as Error);
      throw error;
    }
  }

  private runMigrations(): void {
    // Schema version tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version  INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const row = this.db
      .prepare("SELECT MAX(version) as v FROM _schema_version")
      .get() as { v: number | null };

    const currentVersion = row?.v ?? 0;

    if (currentVersion < 1) {
      this.applyMigration1();
      this.db
        .prepare("INSERT INTO _schema_version (version, applied_at) VALUES (?, ?)")
        .run(1, Date.now());
      logger.info("SymbolDb migration 1 applied");
    }
  }

  private applyMigration1(): void {
    this.db.exec(`
      -- ─── File fingerprints ────────────────────────────────────────
      -- Tracks per-file content hash to skip reparse when unchanged.
      CREATE TABLE IF NOT EXISTS symbol_files (
        project_id    TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        mtime         INTEGER NOT NULL,
        size          INTEGER NOT NULL DEFAULT 0,
        indexed_at    INTEGER NOT NULL,
        symbol_count  INTEGER NOT NULL DEFAULT 0,
        chunk_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, relative_path)
      );

      -- ─── Symbol definitions ───────────────────────────────────────
      -- One row per symbol (function, class, variable, type, interface).
      -- id is the fully-qualified name: 'relative/path.ts#SymbolName'
      CREATE TABLE IF NOT EXISTS symbol_definitions (
        id          TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL,
        line_start  INTEGER NOT NULL,
        line_end    INTEGER NOT NULL,
        exported    INTEGER NOT NULL DEFAULT 0,
        doc_comment TEXT,
        indexed_at  INTEGER NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_sym_def_project ON symbol_definitions(project_id);
      CREATE INDEX IF NOT EXISTS idx_sym_def_file    ON symbol_definitions(project_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_sym_def_name    ON symbol_definitions(project_id, name);

      -- ─── Symbol references ────────────────────────────────────────
      -- One row per usage site of a symbol.
      CREATE TABLE IF NOT EXISTS symbol_references (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL,
        from_file   TEXT NOT NULL,
        from_line   INTEGER NOT NULL,
        symbol_name TEXT NOT NULL,
        target_fqn  TEXT,
        ref_kind    TEXT NOT NULL
        -- ref_kind: 'call'|'type_ref'|'import'|'extend'|'implement'
      );
      CREATE INDEX IF NOT EXISTS idx_sym_ref_project ON symbol_references(project_id);
      CREATE INDEX IF NOT EXISTS idx_sym_ref_target  ON symbol_references(project_id, target_fqn);
      CREATE INDEX IF NOT EXISTS idx_sym_ref_file    ON symbol_references(project_id, from_file);

      -- ─── Import edges ─────────────────────────────────────────────
      -- One row per import statement. Encodes file-level dependency graph.
      CREATE TABLE IF NOT EXISTS symbol_imports (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id     TEXT NOT NULL,
        from_file      TEXT NOT NULL,
        to_file        TEXT,
        specifier      TEXT NOT NULL,
        imported_names TEXT NOT NULL,
        is_external    INTEGER NOT NULL DEFAULT 0,
        is_type_only   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sym_imp_from ON symbol_imports(project_id, from_file);
      CREATE INDEX IF NOT EXISTS idx_sym_imp_to   ON symbol_imports(project_id, to_file);

      -- ─── Centrality scores ────────────────────────────────────────
      -- PageRank per file, recomputed after each full index.
      CREATE TABLE IF NOT EXISTS symbol_centrality (
        project_id TEXT NOT NULL,
        file_path  TEXT NOT NULL,
        score      REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, file_path)
      );

      -- ─── Workspace / project registry ────────────────────────────
      -- Replaces the zero-embedding _metadata doc in the vector store.
      CREATE TABLE IF NOT EXISTS workspaces (
        project_id      TEXT PRIMARY KEY,
        project_path    TEXT NOT NULL,
        display_name    TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        last_indexed_at INTEGER,
        last_error      TEXT,
        files_count     INTEGER NOT NULL DEFAULT 0,
        chunks_count    INTEGER NOT NULL DEFAULT 0,
        symbols_count   INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ws_status ON workspaces(status);
      CREATE INDEX IF NOT EXISTS idx_ws_path   ON workspaces(project_path);
    `);
  }
}

export const symbolDb = SymbolDb.getInstance();
