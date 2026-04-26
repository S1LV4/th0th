/**
 * Smart Chunker - Language/format-aware semantic chunking
 *
 * Instead of treating all files the same, this module splits content
 * based on file type:
 *
 * - **Markdown** (.md): Split by headings (## sections), preserving hierarchy.
 *   Each section becomes a chunk with its heading chain as context prefix.
 *
 * - **JSON** (.json): Split by top-level keys. Each key→value pair is a chunk.
 *   Nested objects are kept together (not split further).
 *
 * - **YAML** (.yaml, .yml): Split by top-level keys or YAML document separators (---).
 *
 * - **Code** (.ts, .js, .tsx, .jsx, .py, .go, .rs, etc.):
 *   Existing brace-counting approach for functions/classes,
 *   with improved chunk size limits and overlap.
 *
 * Design goals:
 * - Each chunk should be self-contained and understandable in isolation
 * - Chunk size targets 200-800 lines for docs, 10-100 lines for code
 * - Include context prefixes (file path, heading chain) for better embedding quality
 * - Never produce empty chunks
 */

import path from "path";

export interface Chunk {
  /** The text content of the chunk */
  content: string;
  /** 1-indexed start line in the original file */
  lineStart: number;
  /** 1-indexed end line in the original file */
  lineEnd: number;
  /** Chunk type for metadata */
  type: "heading_section" | "json_key" | "yaml_block" | "code_block" | "fixed";
  /** Optional label (heading text, JSON key, etc.) */
  label?: string;
}

/**
 * Configuration for the smart chunker
 */
export interface ChunkerConfig {
  /** Max lines for a single chunk before splitting further */
  maxChunkLines: number;
  /** Min lines for a chunk (smaller gets merged with previous) */
  minChunkLines: number;
  /** For code: target chunk size in lines */
  codeChunkTarget: number;
  /** For fixed fallback: chunk size in lines */
  fixedChunkSize: number;
  /** Whether to add file-path context prefix to each chunk */
  addFileContext: boolean;
  /**
   * Max characters per chunk. Takes precedence over line count for files with
   * very long lines (minified JS, single-line JSON, i18n files). Should stay
   * below the embedding provider's maxChars to avoid truncation.
   */
  maxChunkChars: number;
}

const DEFAULT_CONFIG: ChunkerConfig = {
  maxChunkLines: 200,
  minChunkLines: 5,
  codeChunkTarget: 80,
  fixedChunkSize: 50,
  addFileContext: true,
  maxChunkChars: 7500, // 90% of 8000 char Ollama maxChars default, leaves room for file-context prefix
};

/**
 * Main entry point: chunk a file based on its extension
 */
export function smartChunk(
  content: string,
  filePath: string,
  config: Partial<ChunkerConfig> = {},
): Chunk[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const ext = path.extname(filePath).toLowerCase();
  const relativePath = filePath; // caller should pass relative path

  let chunks: Chunk[];

  switch (ext) {
    case ".md":
    case ".mdx":
      chunks = chunkMarkdown(content, cfg);
      break;

    case ".json":
      chunks = chunkJSON(content, cfg);
      break;

    case ".yaml":
    case ".yml":
      chunks = chunkYAML(content, cfg);
      break;

    case ".py":
      // Python uses indentation, not braces -- brace-counting would produce mega-chunks
      chunks = chunkFixed(content, cfg);
      break;

    default:
      // Code files: use semantic code chunking
      if (isCodeFile(ext)) {
        chunks = chunkCode(content, cfg);
      } else {
        chunks = chunkFixed(content, cfg);
      }
      break;
  }

  // Post-processing: merge tiny chunks, split oversized ones
  chunks = postProcess(chunks, cfg);

  // Add file context prefix for better embedding quality.
  //
  // The label (Class.method, top-level fn name, etc.) is the highest-signal
  // token for retrieval — repeat it 3x in the header so the embedding vector
  // is biased toward it. Known RAG trick for transformer-based embeddings:
  // token frequency in the input shifts attention.
  //
  // BUT: do NOT repeat for tiny chunks (< 5 lines). A 1-line constant like
  // `const REINDEX_FILE_THRESHOLD = 15` would otherwise outrank the actual
  // implementation when the query mentions "reindex" — the label match is
  // trivial and not informative. For tiny chunks, the label appears once
  // (via `// Section:`) which is enough.
  const REPEAT_MIN_LINES = 5;
  if (cfg.addFileContext) {
    chunks = chunks.map((chunk) => {
      const lineCount = chunk.content.split("\n").length;
      const repeat = chunk.label && lineCount >= REPEAT_MIN_LINES;
      const labelHeader = chunk.label
        ? repeat
          ? `// Section: ${chunk.label}\n// ${chunk.label}\n// ${chunk.label}\n`
          : `// Section: ${chunk.label}\n`
        : "";
      return {
        ...chunk,
        content: `// File: ${relativePath}\n${labelHeader}${chunk.content}`,
      };
    });
  }

  // Filter out empty chunks
  return chunks.filter((c) => c.content.trim().length > 0);
}

// --- Markdown Chunker ---

/**
 * Split Markdown by headings.
 *
 * Strategy:
 * - Each heading (# to ######) starts a new chunk
 * - The heading hierarchy is tracked so each chunk gets a context label
 *   like "Installation > Prerequisites"
 * - Content before the first heading is its own chunk ("preamble")
 * - Code blocks (```) are treated as opaque (headings inside them are ignored)
 * - If the file has NO headings at all, fall back to fixed chunking so we
 *   don't emit a single mega-chunk that matches every query.
 */
function chunkMarkdown(content: string, cfg: ChunkerConfig): Chunk[] {
  // Quick scan: if no headings exist, fall back to fixed chunks.
  // Otherwise the whole file becomes one "preamble" that wins every search
  // by virtue of containing every keyword in the query.
  const hasHeading = /^\s*#{1,6}\s+/m.test(content);
  if (!hasHeading) return chunkFixed(content, cfg);

  return chunkMarkdownByHeadings(content, cfg);
}

function chunkMarkdownByHeadings(content: string, _cfg: ChunkerConfig): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  // Track heading hierarchy: headingStack[level-1] = heading text
  const headingStack: (string | undefined)[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;
  let currentLabel = "";
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks (```)
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      currentLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      currentLines.push(line);
      continue;
    }

    // Check for heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      // Save previous chunk if it has content
      if (currentLines.length > 0 && currentLines.some((l) => l.trim())) {
        chunks.push({
          content: currentLines.join("\n"),
          lineStart: currentStart,
          lineEnd: i, // line before this heading
          type: "heading_section",
          label: currentLabel || "preamble",
        });
      }

      const level = headingMatch[1].length; // 1-6
      const headingText = headingMatch[2].trim();

      // Update heading stack
      headingStack[level - 1] = headingText;
      // Clear deeper levels
      for (let j = level; j < 6; j++) {
        headingStack[j] = undefined;
      }

      // Build label from hierarchy
      currentLabel = headingStack
        .filter((h): h is string => h !== undefined)
        .join(" > ");

      currentLines = [line];
      currentStart = i + 1;
    } else {
      currentLines.push(line);
    }
  }

  // Final chunk
  if (currentLines.length > 0 && currentLines.some((l) => l.trim())) {
    chunks.push({
      content: currentLines.join("\n"),
      lineStart: currentStart,
      lineEnd: lines.length,
      type: "heading_section",
      label: currentLabel || "preamble",
    });
  }

  return chunks;
}

// --- JSON Chunker ---

/**
 * Split JSON by top-level keys.
 *
 * Strategy:
 * - Parse the JSON, iterate top-level keys
 * - Each key→value becomes a chunk, serialized as `{ "key": value }`
 * - If the file isn't a JSON object (e.g. it's an array), fall back to fixed chunks
 * - For very large values (> maxChunkLines), recursively split one level deeper
 */
function chunkJSON(content: string, cfg: ChunkerConfig): Chunk[] {
  try {
    const parsed = JSON.parse(content);

    // Only split objects, not arrays or primitives
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return chunkFixed(content, cfg);
    }

    const chunks: Chunk[] = [];
    const keys = Object.keys(parsed);

    // For small objects (< 5 keys), keep as single chunk
    if (keys.length < 5) {
      const lines = content.split("\n");
      return [
        {
          content,
          lineStart: 1,
          lineEnd: lines.length,
          type: "json_key",
          label: `{${keys.join(", ")}}`,
        },
      ];
    }

    // Split by top-level keys
    // We need to map keys back to line positions in the original text
    const lines = content.split("\n");

    for (const key of keys) {
      const value = parsed[key];
      const serialized = JSON.stringify({ [key]: value }, null, 2);
      const serializedLines = serialized.split("\n");

      // Find approximate line position in original file
      const keyPattern = new RegExp(
        `^\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`,
      );
      let startLine = 1;
      for (let i = 0; i < lines.length; i++) {
        if (keyPattern.test(lines[i])) {
          startLine = i + 1;
          break;
        }
      }

      chunks.push({
        content: serialized,
        lineStart: startLine,
        lineEnd: startLine + serializedLines.length - 1,
        type: "json_key",
        label: key,
      });
    }

    return chunks;
  } catch {
    // Invalid JSON, fall back to fixed chunks
    return chunkFixed(content, cfg);
  }
}

// --- YAML Chunker ---

/**
 * Split YAML by top-level keys or document separators (---).
 *
 * Strategy:
 * - First split on `---` (YAML document separators)
 * - Within each document, split on top-level keys (lines starting at column 0
 *   with `key:` pattern, not inside multi-line scalars)
 */
function chunkYAML(content: string, cfg: ChunkerConfig): Chunk[] {
  const lines = content.split("\n");

  // If there are document separators, split on those first
  const docSeparators: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      docSeparators.push(i);
    }
  }

  if (docSeparators.length > 1) {
    // Multi-document YAML: each document is a chunk
    const chunks: Chunk[] = [];
    for (let d = 0; d < docSeparators.length; d++) {
      const start = docSeparators[d];
      const end =
        d + 1 < docSeparators.length ? docSeparators[d + 1] : lines.length;
      const docLines = lines.slice(start, end);

      if (docLines.some((l) => l.trim() && l.trim() !== "---")) {
        chunks.push({
          content: docLines.join("\n"),
          lineStart: start + 1,
          lineEnd: end,
          type: "yaml_block",
          label: `document ${d + 1}`,
        });
      }
    }
    if (chunks.length > 0) return chunks;
  }

  // Single document: split by top-level keys
  const chunks: Chunk[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;
  let currentLabel = "";

  // Pattern for top-level key (not indented, followed by colon)
  const topLevelKey = /^[a-zA-Z_][a-zA-Z0-9_.-]*\s*:/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip document separators and comments at top
    if (line.trim() === "---" || line.trim() === "...") {
      currentLines.push(line);
      continue;
    }

    if (topLevelKey.test(line) && currentLines.length > 0) {
      // Save previous chunk
      if (currentLines.some((l) => l.trim() && l.trim() !== "---")) {
        chunks.push({
          content: currentLines.join("\n"),
          lineStart: currentStart,
          lineEnd: i,
          type: "yaml_block",
          label: currentLabel || "header",
        });
      }
      currentLines = [line];
      currentStart = i + 1;
      currentLabel = line.split(":")[0].trim();
    } else {
      currentLines.push(line);
      // Set label from first top-level key if not set
      if (!currentLabel && topLevelKey.test(line)) {
        currentLabel = line.split(":")[0].trim();
      }
    }
  }

  // Final chunk
  if (currentLines.length > 0 && currentLines.some((l) => l.trim())) {
    chunks.push({
      content: currentLines.join("\n"),
      lineStart: currentStart,
      lineEnd: lines.length,
      type: "yaml_block",
      label: currentLabel || "content",
    });
  }

  return chunks.length > 0 ? chunks : chunkFixed(content, cfg);
}

// --- Code Chunker (improved version of original) ---

/**
 * Split code by semantic blocks (functions, classes, methods).
 *
 * Two-phase algorithm:
 *
 *   Phase 1 — find boundaries: scan once tracking brace depth.
 *     - At depth 0: top-level declarations (class/interface/function/const/...)
 *     - At depth = container.openDepth + 1 (one level inside a container):
 *       method-like declarations (`name(...)`, `name<T>(...)`)
 *     Pure-comment lines are skipped for boundary detection but do not
 *     update brace depth (comments rarely contain raw braces).
 *
 *   Phase 2 — slice into chunks: walk back from each boundary to absorb
 *     immediately-preceding doc comments / decorators (without crossing
 *     the previous boundary). Lines before the first boundary become a
 *     `imports` preamble chunk.
 *
 * This replaces the previous brace-counting accumulator, which had two
 * bugs: (a) methods inside a class were never split (the whole class became
 * one chunk because `isBlockStart` was only checked when `!inBlock`), and
 * (b) the comment-buffer was emitted twice in some edge cases, producing
 * overlapping chunk ranges.
 */
function chunkCode(content: string, cfg: ChunkerConfig): Chunk[] {
  const lines = content.split("\n");
  const boundaries = findCodeBoundaries(lines);

  if (boundaries.length === 0) return chunkFixed(content, cfg);

  // Compute realStart for each boundary (walk back over preceding doc comments
  // / decorators, but never cross the previous boundary's line).
  const realStarts: number[] = [];
  for (let b = 0; b < boundaries.length; b++) {
    const limit = b > 0 ? boundaries[b - 1].line + 1 : 0;
    let s = boundaries[b].line;
    while (s > limit) {
      const prev = lines[s - 1].trimStart();
      const isDoc =
        prev.startsWith("//") ||
        prev.startsWith("/*") ||
        prev.startsWith("*") ||
        prev.startsWith("///") ||
        prev.startsWith("@") ||
        prev.startsWith('"""');
      if (isDoc) s--;
      else break;
    }
    realStarts.push(s);
  }

  const chunks: Chunk[] = [];

  // Preamble: anything before the first boundary's realStart (imports,
  // file-level constants, file JSDoc).
  if (realStarts[0] > 0) {
    const preamble = lines.slice(0, realStarts[0]);
    if (preamble.some((l) => l.trim())) {
      chunks.push({
        content: preamble.join("\n"),
        lineStart: 1,
        lineEnd: realStarts[0],
        type: "code_block",
        label: "imports",
      });
    }
  }

  for (let b = 0; b < boundaries.length; b++) {
    const start = realStarts[b];
    const end = b + 1 < realStarts.length ? realStarts[b + 1] : lines.length;
    const slice = lines.slice(start, end);
    if (!slice.some((l) => l.trim())) continue;
    const label = boundaries[b].container
      ? `${boundaries[b].container}.${boundaries[b].label}`
      : boundaries[b].label;
    chunks.push({
      content: slice.join("\n"),
      lineStart: start + 1,
      lineEnd: end,
      type: "code_block",
      label,
    });
  }

  return chunks;
}

interface CodeBoundary {
  /** 0-indexed line where the declaration starts */
  line: number;
  /** Symbol name (e.g. "ParseStage", "extractJsSymbols") */
  label: string;
  /** Outer container name when this boundary is a method */
  container?: string;
}

const RESERVED_KEYWORDS = new Set([
  "if", "for", "while", "switch", "return", "throw", "catch",
  "do", "try", "else", "case", "with", "yield", "await",
]);

/** Top-level container declarations (class/interface/enum/namespace/trait/impl) */
const CONTAINER_RE =
  /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?(?:class|interface|enum|namespace|trait|impl)\s+(\w+)/;

/** Top-level non-container declarations (function/const/let/var/type/struct/fn/def/func) */
const TOP_LEVEL_RE =
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|const|let|var|type|struct|fn|def|func)\s+(\w+)/;

/** Method-like declarations inside a class body: identifier followed by `(` or `<` */
const METHOD_RE =
  /^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+|abstract\s+|get\s+|set\s+)*(\w+)\s*[(<]/;

function findCodeBoundaries(lines: string[]): CodeBoundary[] {
  const boundaries: CodeBoundary[] = [];
  const containerStack: { name: string; openDepth: number }[] = [];
  let depth = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Block comment continuations
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlockComment = true;
      continue;
    }
    // Skip empty / pure comment lines (no brace updates, no boundary)
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("///") ||
      trimmed.startsWith("*")
    ) {
      continue;
    }

    // Boundary detection BEFORE updating depth (depth still reflects the state
    // at the start of this line)
    if (depth === 0) {
      const c = CONTAINER_RE.exec(trimmed);
      if (c) {
        boundaries.push({ line: i, label: c[1] });
        containerStack.push({ name: c[1], openDepth: 0 });
      } else {
        const t = TOP_LEVEL_RE.exec(trimmed);
        if (t) boundaries.push({ line: i, label: t[1] });
      }
    } else if (
      containerStack.length > 0 &&
      depth === containerStack[containerStack.length - 1].openDepth + 1
    ) {
      const m = METHOD_RE.exec(trimmed);
      if (m && !RESERVED_KEYWORDS.has(m[1])) {
        boundaries.push({
          line: i,
          label: m[1],
          container: containerStack[containerStack.length - 1].name,
        });
      }
    }

    // Update depth using the line's brace counts (strings/regex/comments
    // stripped first, so braces inside `"{"`, `/\{/`, etc. don't drift the
    // depth — this matters for files like parsers that contain regex
    // literals with curly braces).
    depth += netBraceDelta(line);

    // Pop containers whose scope just closed
    while (
      containerStack.length > 0 &&
      depth <= containerStack[containerStack.length - 1].openDepth
    ) {
      containerStack.pop();
    }
  }

  return boundaries;
}

/**
 * Brace-depth delta for a single line, ignoring braces inside string,
 * template, regex, and inline comment literals. Heuristic — does not handle
 * template-literal `${}` interpolation expressions correctly, but those are
 * rare enough at the line level that the drift is bounded.
 */
function netBraceDelta(line: string): number {
  const stripped = line
    .replace(/\/\*.*?\*\//g, "") // inline /* ... */
    .replace(/\/\/.*$/, "") // // line comment
    .replace(/'(?:\\.|[^'\\])*'/g, "''") // 'single'
    .replace(/"(?:\\.|[^"\\])*"/g, '""') // "double"
    .replace(/`(?:\\.|[^`\\])*`/g, "``") // `template` (no ${} support)
    .replace(/\/(?:\\.|[^/\\\n])+\/[gimsuy]*/g, "//"); // /regex/flags
  return (stripped.match(/\{/g) || []).length - (stripped.match(/\}/g) || []).length;
}

// --- Fixed Chunker (fallback) ---

/**
 * Simple fixed-size chunking as a last resort
 */
function chunkFixed(content: string, cfg: ChunkerConfig): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  const size = cfg.fixedChunkSize;

  for (let i = 0; i < lines.length; i += size) {
    const chunkLines = lines.slice(i, Math.min(i + size, lines.length));
    if (chunkLines.some((l) => l.trim())) {
      chunks.push({
        content: chunkLines.join("\n"),
        lineStart: i + 1,
        lineEnd: Math.min(i + size, lines.length),
        type: "fixed",
      });
    }
  }

  return chunks;
}

// --- Post-processing ---

/**
 * Post-process chunks:
 * 1. Merge tiny chunks (< minChunkLines) with the previous chunk
 * 2. Split oversized chunks (> maxChunkLines) into sub-chunks
 */
function postProcess(chunks: Chunk[], cfg: ChunkerConfig): Chunk[] {
  if (chunks.length === 0) return chunks;

  const result: Chunk[] = [];

  for (const chunk of chunks) {
    const lineCount = chunk.content.split("\n").length;
    const charCount = chunk.content.length;

    // For code blocks, use the (smaller) codeChunkTarget so that long methods
    // (like a 180-line controller `calculate` with multiple validation
    // sub-blocks) get split into focused pieces. Embeddings of huge methods
    // wash out semantic signal — splitting recovers recall.
    const lineLimit =
      chunk.type === "code_block" ? cfg.codeChunkTarget : cfg.maxChunkLines;

    // Split oversized chunks (by lines OR by chars — long single lines bypass line-based limit)
    if (lineCount > lineLimit || charCount > cfg.maxChunkChars) {
      const subChunks = splitOversizedChunk(
        chunk,
        chunk.type === "code_block"
          ? { ...cfg, maxChunkLines: cfg.codeChunkTarget }
          : cfg,
      );
      result.push(...subChunks);
      continue;
    }

    // Merge tiny chunks with previous — but NEVER merge code chunks that
    // carry an explicit semantic label (method/function name). A 3-line
    // getter is small but discoverable; merging it into a neighbor erases
    // it from search.
    if (chunk.label && chunk.type === "code_block") {
      result.push(chunk);
      continue;
    }
    if (
      lineCount < cfg.minChunkLines &&
      result.length > 0
    ) {
      const prev = result[result.length - 1];
      const prevLineCount = prev.content.split("\n").length;
      const prevCharCount = prev.content.length;
      // Only merge if combined size is reasonable (both line and char limits)
      if (
        prevLineCount + lineCount <= cfg.maxChunkLines &&
        prevCharCount + charCount + 1 <= cfg.maxChunkChars
      ) {
        prev.content += "\n" + chunk.content;
        prev.lineEnd = chunk.lineEnd;
        // Keep the previous chunk's label
        continue;
      }
    }

    result.push(chunk);
  }

  return result;
}

/**
 * Split an oversized chunk into smaller pieces.
 *
 * Split is capped by both line count (cfg.maxChunkLines) and char count
 * (cfg.maxChunkChars). Prefers blank-line boundaries when possible. A single
 * line longer than maxChunkChars is further split by characters, preferring
 * semantic separators (`; , } `) before a hard cut.
 */
function splitOversizedChunk(chunk: Chunk, cfg: ChunkerConfig): Chunk[] {
  const lines = chunk.content.split("\n");
  const targetLines = cfg.maxChunkLines;
  const maxChars = cfg.maxChunkChars;
  const subChunks: Chunk[] = [];

  const pushSub = (subLines: string[], startIdx: number, endIdx: number) => {
    if (!subLines.some((l) => l.trim())) return;
    subChunks.push({
      content: subLines.join("\n"),
      lineStart: chunk.lineStart + startIdx,
      lineEnd: chunk.lineStart + endIdx - 1,
      type: chunk.type,
      label: chunk.label
        ? `${chunk.label} (part ${subChunks.length + 1})`
        : undefined,
    });
  };

  let start = 0;
  while (start < lines.length) {
    // Single line exceeds maxChars: split that line by characters
    if (lines[start].length > maxChars) {
      const parts = splitLineByChars(lines[start], maxChars);
      for (const part of parts) {
        subChunks.push({
          content: part,
          lineStart: chunk.lineStart + start,
          lineEnd: chunk.lineStart + start,
          type: chunk.type,
          label: chunk.label
            ? `${chunk.label} (part ${subChunks.length + 1})`
            : undefined,
        });
      }
      start += 1;
      continue;
    }

    let end = Math.min(start + targetLines, lines.length);

    // Shrink end until the slice fits within maxChars
    while (end > start + 1) {
      const sliceLen = lines.slice(start, end).reduce((s, l) => s + l.length + 1, -1);
      if (sliceLen <= maxChars) break;
      end--;
    }

    // Prefer a blank-line break in the final half of the window
    if (end < lines.length) {
      const minBreak = start + Math.max(1, Math.floor((end - start) * 0.5));
      for (let i = end; i > minBreak; i--) {
        if (lines[i]?.trim() === "") {
          end = i;
          break;
        }
      }
    }

    pushSub(lines.slice(start, end), start, end);

    // Safety: guarantee progress if the loop produced an empty slice
    start = end === start ? start + 1 : end;
  }

  return subChunks;
}

/**
 * Split a single overly long line into parts ≤ maxChars each.
 * Prefers semantic separators (`;` > `,` > `}` > space) within the last 20%
 * of each window. Falls back to a hard cut at maxChars.
 */
function splitLineByChars(line: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remaining = line;
  while (remaining.length > maxChars) {
    const windowStart = Math.floor(maxChars * 0.8);
    const window = remaining.substring(windowStart, maxChars);
    let breakAt = -1;
    for (const sep of [";", ",", "}", " "]) {
      const idx = window.lastIndexOf(sep);
      if (idx >= 0) {
        breakAt = windowStart + idx + 1;
        break;
      }
    }
    if (breakAt < 0) breakAt = maxChars;
    parts.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

// --- Utilities ---

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".js",
  ".tsx",
  ".jsx",
  ".dart",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".lua",
  ".zig",
  ".ex",
  ".exs",
  ".erl",
  ".clj",
  ".ml",
  ".hs",
]);

function isCodeFile(ext: string): boolean {
  return CODE_EXTENSIONS.has(ext);
}
