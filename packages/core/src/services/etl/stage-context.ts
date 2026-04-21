/**
 * ETL Stage Context & Shared Types
 *
 * Contracts shared across all 4 ETL stages:
 *   discover → parse → resolve → load
 *
 * Each stage receives an EtlStageContext for progress reporting
 * and passes its output as the next stage's input.
 */

import type { Chunk } from "../search/smart-chunker.js";

// ─── Event types ─────────────────────────────────────────────────────────────

export type EtlStage = "discover" | "parse" | "resolve" | "load";

export interface EtlEvent {
  type:
    | "stage_start"
    | "stage_end"
    | "file_processed"
    | "file_error"
    | "progress";
  stage: EtlStage;
  payload: Record<string, unknown>;
  timestamp: number;
}

// ─── Stage context ────────────────────────────────────────────────────────────

export interface EtlStageContext {
  projectId: string;
  projectPath: string;
  jobId: string;
  /** Hook for emitting progress events to the EventBus. */
  emit: (event: EtlEvent) => void;
}

// ─── Stage data shapes ────────────────────────────────────────────────────────

/** Output of Discover stage / Input of Parse stage */
export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  mtime: number;
  size: number;
  contentHash: string; // SHA-256 of raw content
  /** True when content hash matches stored hash → skip parse/load. */
  needsReparse: boolean;
}

/** A raw symbol extracted by the Parse stage before FQN resolution. */
export interface RawSymbol {
  kind: "function" | "class" | "variable" | "type" | "interface" | "export";
  name: string;
  /** Filled by Resolve stage: '{relativePath}#{name}' */
  fqn?: string;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  docComment?: string;
}

/** A raw import statement before path resolution. */
export interface RawImport {
  specifier: string; // e.g. '../services/search'
  names: string[]; // e.g. ['SearchController', 'default']
  isTypeOnly: boolean;
}

/** Output of Parse stage / Input of Resolve stage */
export interface ParsedFile {
  file: DiscoveredFile;
  chunks: Chunk[]; // from smart-chunker, used by Load stage
  symbols: RawSymbol[];
  rawImports: RawImport[];
}

/** A resolved import with the concrete file path (or null if external). */
export interface ResolvedImport {
  raw: RawImport;
  resolvedPath: string | null; // relative project path
  external: boolean;
}

/** Output of Resolve stage / Input of Load stage */
export interface ResolvedFile extends ParsedFile {
  resolvedImports: ResolvedImport[];
}

// ─── Pipeline result ──────────────────────────────────────────────────────────

export interface EtlResult {
  filesDiscovered: number;
  filesIndexed: number;
  filesSkipped: number; // fingerprint cache hits
  chunksIndexed: number;
  symbolsIndexed: number;
  errors: number;
  durationMs: number;
  stageTimings: Record<EtlStage, number>;
}
