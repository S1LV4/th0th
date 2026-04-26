/**
 * ETL Stage 2 — Parse
 *
 * For each DiscoveredFile that needsReparse=true:
 *   1. Reads file content
 *   2. Runs smart-chunker for semantic embedding chunks
 *   3. Extracts raw symbols (functions, classes, variables, types, interfaces)
 *      via regex + heuristic AST-lite (no heavy ts-morph dependency)
 *   4. Extracts raw import statements for Resolve stage
 *
 * Files with needsReparse=false are passed through with empty symbols/chunks.
 */

import fs from "fs/promises";
import path from "path";
import { logger } from "@th0th-ai/shared";
import { smartChunk, type Chunk } from "../../search/smart-chunker.js";
import type {
  EtlStageContext,
  DiscoveredFile,
  ParsedFile,
  RawSymbol,
  RawImport,
} from "../stage-context.js";

const BATCH_SIZE = 20;

function resolveChunkerMaxChars(): number | undefined {
  const providerLimit =
    Number(process.env.OLLAMA_EMBEDDING_MAX_CHARS) ||
    Number(process.env.EMBEDDING_MAX_CHARS);
  if (!providerLimit) return undefined;
  return Math.floor(providerLimit * 0.9);
}

export class ParseStage {
  async run(ctx: EtlStageContext, files: DiscoveredFile[]): Promise<ParsedFile[]> {
    const t0 = performance.now();

    ctx.emit({
      type: "stage_start",
      stage: "parse",
      payload: { total: files.length, toProcess: files.filter((f) => f.needsReparse).length },
      timestamp: Date.now(),
    });

    const results: ParsedFile[] = [];
    let processed = 0;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((file) => this.parseFile(ctx, file)),
      );
      results.push(...batchResults);
      processed += batch.length;

      ctx.emit({
        type: "progress",
        stage: "parse",
        payload: { current: processed, total: files.length, percentage: Math.round((processed / files.length) * 100) },
        timestamp: Date.now(),
      });
    }

    const durationMs = Math.round(performance.now() - t0);

    ctx.emit({
      type: "stage_end",
      stage: "parse",
      payload: {
        parsed: results.filter((f) => f.file.needsReparse).length,
        totalSymbols: results.reduce((s, f) => s + f.symbols.length, 0),
        totalChunks: results.reduce((s, f) => s + f.chunks.length, 0),
        durationMs,
      },
      timestamp: Date.now(),
    });

    logger.info("ETL Parse complete", {
      projectId: ctx.projectId,
      parsed: results.filter((f) => f.file.needsReparse).length,
      durationMs,
    });

    return results;
  }

  private async parseFile(ctx: EtlStageContext, file: DiscoveredFile): Promise<ParsedFile> {
    if (!file.needsReparse) {
      // Fingerprint cache hit — pass through with empty collections
      return { file, chunks: [], symbols: [], rawImports: [] };
    }

    try {
      const content = await fs.readFile(file.absolutePath, "utf-8");
      const ext = path.extname(file.relativePath).toLowerCase();

      const chunkerMaxChars = resolveChunkerMaxChars();
      const chunks = smartChunk(
        content,
        file.relativePath,
        chunkerMaxChars ? { maxChunkChars: chunkerMaxChars } : {},
      );
      const symbols = this.extractSymbols(content, ext);
      const rawImports = this.extractImports(content, ext);

      ctx.emit({
        type: "file_processed",
        stage: "parse",
        payload: {
          filePath: file.relativePath,
          symbols: symbols.length,
          chunks: chunks.length,
          imports: rawImports.length,
          status: "ok",
        },
        timestamp: Date.now(),
      });

      return { file, chunks, symbols, rawImports };
    } catch (err) {
      ctx.emit({
        type: "file_error",
        stage: "parse",
        payload: { filePath: file.relativePath, error: (err as Error).message },
        timestamp: Date.now(),
      });
      logger.warn("ParseStage: failed to parse file", {
        filePath: file.relativePath,
        error: (err as Error).message,
      });
      return { file, chunks: [], symbols: [], rawImports: [] };
    }
  }

  // ─── Symbol extraction ─────────────────────────────────────────────────────

  private extractSymbols(content: string, ext: string): RawSymbol[] {
    switch (ext) {
      case ".ts":
      case ".tsx":
      case ".js":
      case ".jsx":
        return this.extractJsSymbols(content);
      case ".py":
        return this.extractPySymbols(content);
      case ".dart":
        return this.extractDartSymbols(content);
      default:
        return [];
    }
  }

  /**
   * TypeScript/JavaScript symbol extractor.
   *
   * Regex patterns cover the most common declaration forms.
   * Does NOT require a full AST parser — tradeoff: avoids ts-morph boot cost
   * (~300ms) at the expense of missing edge cases (decorators, namespaces).
   */
  private extractJsSymbols(content: string): RawSymbol[] {
    const lines = content.split("\n");
    const symbols: RawSymbol[] = [];

    // Patterns: [regex, kind, exportGroup, nameGroup]
    const patterns: Array<[RegExp, RawSymbol["kind"], boolean]> = [
      // export async function foo / export function foo
      [/^(export\s+)?(?:async\s+)?function\s+(\w+)/, "function", false],
      // export class Foo / class Foo
      [/^(export\s+)?class\s+(\w+)/, "class", false],
      // export const/let/var foo = / export const foo: Type =
      [/^(export\s+)?(?:const|let|var)\s+(\w+)(?:\s*[=:])/, "variable", false],
      // export type Foo = / type Foo =
      [/^(export\s+)?type\s+(\w+)\s*(?:[=<{])/, "type", false],
      // export interface Foo / interface Foo
      [/^(export\s+)?interface\s+(\w+)/, "interface", false],
      // export default function / export default class
      [/^export\s+default\s+(?:async\s+)?(?:function|class)\s*(\w+)?/, "export", false],
      // export { Foo, Bar } — re-exports / named exports
      [/^export\s+\{([^}]+)\}/, "export", false],
      // Arrow function assigned to const: const foo = (...) =>
      [/^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/, "function", false],
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimStart();

      for (const [pattern, kind] of patterns) {
        const match = pattern.exec(line);
        if (!match) continue;

        const exported = line.startsWith("export");

        // Find symbol name from capture groups
        let name = "";
        if (kind === "export" && line.includes("{")) {
          // export { Foo, Bar as Baz } — emit each name
          const inner = match[0].replace(/export\s*\{/, "").replace("}", "");
          const names = inner
            .split(",")
            .map((n) => n.split(" as ").pop()!.trim())
            .filter(Boolean);
          for (const n of names) {
            symbols.push({ kind, name: n, lineStart: i + 1, lineEnd: i + 1, exported: true });
          }
          break;
        } else {
          // Find first capture group that looks like an identifier
          for (let g = 1; g < match.length; g++) {
            const cap = match[g];
            if (cap && /^\w+$/.test(cap) && cap !== "export" && cap !== "async") {
              name = cap;
              break;
            }
          }
        }

        if (!name) break;

        // Find end line: for functions/classes, track braces
        const lineEnd = this.findBlockEnd(lines, i);

        // Extract JSDoc comment above the declaration
        const docComment = this.extractDocComment(lines, i);

        symbols.push({ kind, name, lineStart: i + 1, lineEnd, exported, docComment });
        break;
      }
    }

    return symbols;
  }

  private extractPySymbols(content: string): RawSymbol[] {
    const lines = content.split("\n");
    const symbols: RawSymbol[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;

      // Only top-level (indent 0) or class-level (indent 4)
      if (indent > 4) continue;

      const fnMatch = /^(?:async\s+)?def\s+(\w+)/.exec(trimmed);
      if (fnMatch) {
        const name = fnMatch[1];
        const exported = !name.startsWith("_");
        const lineEnd = this.findPyBlockEnd(lines, i);
        symbols.push({ kind: "function", name, lineStart: i + 1, lineEnd, exported });
        continue;
      }

      const clsMatch = /^class\s+(\w+)/.exec(trimmed);
      if (clsMatch) {
        const name = clsMatch[1];
        const lineEnd = this.findPyBlockEnd(lines, i);
        symbols.push({ kind: "class", name, lineStart: i + 1, lineEnd, exported: true });
      }
    }

    return symbols;
  }

  private extractDartSymbols(content: string): RawSymbol[] {
    const lines = content.split("\n");
    const symbols: RawSymbol[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimStart();

      const clsMatch = /^(?:abstract\s+)?class\s+(\w+)/.exec(line);
      if (clsMatch) {
        const lineEnd = this.findBlockEnd(lines, i);
        symbols.push({ kind: "class", name: clsMatch[1], lineStart: i + 1, lineEnd, exported: true });
        continue;
      }

      // Dart top-level functions: returnType name(...)
      const fnMatch = /^(?:\w+\s+)+(\w+)\s*\(/.exec(line);
      if (fnMatch && !line.includes("=") && !["if", "while", "for", "switch"].includes(fnMatch[1])) {
        const lineEnd = this.findBlockEnd(lines, i);
        symbols.push({ kind: "function", name: fnMatch[1], lineStart: i + 1, lineEnd, exported: true });
      }
    }

    return symbols;
  }

  // ─── Import extraction ────────────────────────────────────────────────────

  private extractImports(content: string, ext: string): RawImport[] {
    switch (ext) {
      case ".ts":
      case ".tsx":
      case ".js":
      case ".jsx":
        return this.extractJsImports(content);
      case ".py":
        return this.extractPyImports(content);
      default:
        return [];
    }
  }

  private extractJsImports(content: string): RawImport[] {
    const imports: RawImport[] = [];

    // import { A, B } from 'x' / import type { A } from 'x'
    const namedRe = /import\s+(type\s+)?\{\s*([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = namedRe.exec(content)) !== null) {
      const isTypeOnly = Boolean(m[1]);
      const names = m[2].split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
      imports.push({ specifier: m[3], names, isTypeOnly });
    }

    // import DefaultExport from 'x'
    const defaultRe = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = defaultRe.exec(content)) !== null) {
      imports.push({ specifier: m[2], names: ["default"], isTypeOnly: false });
    }

    // import * as X from 'x'
    const starRe = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = starRe.exec(content)) !== null) {
      imports.push({ specifier: m[2], names: ["*"], isTypeOnly: false });
    }

    // require('x')
    const requireRe = /require\(['"]([^'"]+)['"]\)/g;
    while ((m = requireRe.exec(content)) !== null) {
      imports.push({ specifier: m[1], names: ["*"], isTypeOnly: false });
    }

    return imports;
  }

  private extractPyImports(content: string): RawImport[] {
    const imports: RawImport[] = [];

    // from module import A, B
    const fromRe = /^from\s+([\w.]+)\s+import\s+(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(content)) !== null) {
      const names = m[2].split(",").map((n) => n.trim()).filter(Boolean);
      imports.push({ specifier: m[1].replace(/\./g, "/"), names, isTypeOnly: false });
    }

    // import module
    const importRe = /^import\s+([\w.,\s]+)$/gm;
    while ((m = importRe.exec(content)) !== null) {
      const names = m[1].split(",").map((n) => n.trim()).filter(Boolean);
      for (const n of names) {
        imports.push({ specifier: n.replace(/\./g, "/"), names: ["*"], isTypeOnly: false });
      }
    }

    return imports;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Tracks brace depth to find the closing line of a JS/TS block. */
  private findBlockEnd(lines: string[], startLine: number): number {
    let depth = 0;
    let found = false;

    for (let i = startLine; i < Math.min(lines.length, startLine + 500); i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; found = true; }
        if (ch === "}") { depth--; }
      }
      if (found && depth <= 0) return i + 1;
    }

    return startLine + 1;
  }

  /** Find end of a Python block by indentation. */
  private findPyBlockEnd(lines: string[], startLine: number): number {
    const baseIndent = lines[startLine].length - lines[startLine].trimStart().length;

    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= baseIndent) return i;
    }

    return lines.length;
  }

  /** Extract JSDoc/TSDoc comment lines immediately before the given line. */
  private extractDocComment(lines: string[], lineIndex: number): string | undefined {
    const commentLines: string[] = [];
    let i = lineIndex - 1;

    while (i >= 0) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("/**") || trimmed.startsWith("*/")) {
        commentLines.unshift(trimmed);
        i--;
      } else if (trimmed.startsWith("//")) {
        commentLines.unshift(trimmed.slice(2).trim());
        i--;
      } else {
        break;
      }
    }

    if (commentLines.length === 0) return undefined;
    return commentLines.join(" ").replace(/\/\*\*?|\*\//g, "").replace(/\s*\*\s*/g, " ").trim();
  }
}
