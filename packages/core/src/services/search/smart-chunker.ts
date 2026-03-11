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
}

const DEFAULT_CONFIG: ChunkerConfig = {
  maxChunkLines: 200, // ~4000 chars avg, fits within MAX_CHARS without truncation
  minChunkLines: 5,
  codeChunkTarget: 80,
  fixedChunkSize: 50,
  addFileContext: true,
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

  // Add file context prefix for better embedding quality
  if (cfg.addFileContext) {
    chunks = chunks.map((chunk) => ({
      ...chunk,
      content: `// File: ${relativePath}\n${chunk.label ? `// Section: ${chunk.label}\n` : ""}${chunk.content}`,
    }));
  }

  // Filter out empty chunks
  return chunks.filter((c) => c.content.trim().length > 0);
}

// ─────────────────────────────────────────────────────────
// Markdown Chunker
// ─────────────────────────────────────────────────────────

/**
 * Split Markdown by headings.
 *
 * Strategy:
 * - Each heading (# to ######) starts a new chunk
 * - The heading hierarchy is tracked so each chunk gets a context label
 *   like "Installation > Prerequisites"
 * - Content before the first heading is its own chunk ("preamble")
 * - Code blocks (```) are treated as opaque (headings inside them are ignored)
 */
function chunkMarkdown(content: string, cfg: ChunkerConfig): Chunk[] {
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

// ─────────────────────────────────────────────────────────
// JSON Chunker
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// YAML Chunker
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// Code Chunker (improved version of original)
// ─────────────────────────────────────────────────────────

/**
 * Split code by semantic blocks (functions, classes, etc.)
 *
 * Improvements over original:
 * - More patterns: Python (def/class), Go (func), Rust (fn/impl/struct)
 * - Captures preceding comments/decorators as part of the chunk
 * - Limits individual chunk size (splits huge functions)
 */
function chunkCode(content: string, cfg: ChunkerConfig): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  // Block start patterns for multiple languages
  const blockPatterns = [
    // TypeScript/JavaScript
    /^\s*(export\s+)?(class|interface|type|enum)\s+\w+/,
    /^\s*(export\s+)?(async\s+)?function\s+\w+/,
    /^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/,
    /^\s*(export\s+)?(async\s+)?\w+\s*\([^)]*\)\s*(:\s*\w+)?\s*\{/,
    /^\s*describe\s*\(/, // test blocks
    /^\s*it\s*\(/, // test cases
    // Python
    /^\s*(async\s+)?def\s+\w+/,
    /^\s*class\s+\w+/,
    // Go
    /^\s*func\s+(\([^)]+\)\s+)?\w+/,
    // Rust
    /^\s*(pub\s+)?(async\s+)?fn\s+\w+/,
    /^\s*(pub\s+)?struct\s+\w+/,
    /^\s*(pub\s+)?enum\s+\w+/,
    /^\s*(pub\s+)?impl\s+/,
    /^\s*(pub\s+)?trait\s+/,
    // C/C++
    /^\s*(\w+\s+)+\w+\s*\([^)]*\)\s*\{/,
  ];

  let currentChunk: { lines: string[]; startLine: number } | null = null;
  let braceCount = 0;
  let inBlock = false;

  // Track preceding comment/decorator lines to include with the block
  let commentBuffer: string[] = [];
  let commentBufferStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Track comments and decorators that precede blocks
    if (
      !inBlock &&
      (trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("@") ||
        trimmed.startsWith('"""') ||
        trimmed.startsWith("///"))
    ) {
      if (commentBuffer.length === 0) {
        commentBufferStart = i;
      }
      commentBuffer.push(line);
      continue;
    }

    const isBlockStart = blockPatterns.some((pattern) => pattern.test(line));

    if (isBlockStart && !inBlock) {
      // Save previous chunk if it has content
      if (currentChunk && currentChunk.lines.length > 0) {
        chunks.push({
          content: currentChunk.lines.join("\n"),
          lineStart: currentChunk.startLine,
          lineEnd: Math.max(currentChunk.startLine, i),
          type: "code_block",
        });
      }

      // Start new chunk, including preceding comments
      const blockLines =
        commentBuffer.length > 0 ? [...commentBuffer, line] : [line];
      const startLine =
        commentBuffer.length > 0 ? commentBufferStart + 1 : i + 1;

      currentChunk = {
        lines: blockLines,
        startLine,
      };
      commentBuffer = [];
      inBlock = true;
      braceCount =
        (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    } else if (inBlock && currentChunk) {
      currentChunk.lines.push(line);
      braceCount +=
        (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

      // End of block
      if (braceCount <= 0 && line.trim().endsWith("}")) {
        chunks.push({
          content: currentChunk.lines.join("\n"),
          lineStart: currentChunk.startLine,
          lineEnd: i + 1,
          type: "code_block",
        });
        currentChunk = null;
        inBlock = false;
        braceCount = 0;
        commentBuffer = [];
      }
    } else if (!inBlock && line.trim()) {
      // Flush comment buffer into current chunk
      if (commentBuffer.length > 0) {
        if (!currentChunk) {
          currentChunk = {
            lines: [],
            startLine: commentBufferStart + 1,
          };
        }
        currentChunk.lines.push(...commentBuffer);
        commentBuffer = [];
      }

      if (!currentChunk) {
        currentChunk = {
          lines: [],
          startLine: i + 1,
        };
      }
      currentChunk.lines.push(line);
    }
  }

  // Flush remaining comment buffer
  if (commentBuffer.length > 0 && currentChunk) {
    currentChunk.lines.push(...commentBuffer);
  }

  // Final chunk
  if (currentChunk && currentChunk.lines.length > 0) {
    chunks.push({
      content: currentChunk.lines.join("\n"),
      lineStart: currentChunk.startLine,
      lineEnd: lines.length,
      type: "code_block",
    });
  }

  // If no semantic blocks found, use fixed chunking
  if (chunks.length === 0) {
    return chunkFixed(content, cfg);
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────
// Fixed Chunker (fallback)
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────

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

    // Split oversized chunks
    if (lineCount > cfg.maxChunkLines) {
      const subChunks = splitOversizedChunk(chunk, cfg);
      result.push(...subChunks);
      continue;
    }

    // Merge tiny chunks with previous
    if (
      lineCount < cfg.minChunkLines &&
      result.length > 0
    ) {
      const prev = result[result.length - 1];
      const prevLineCount = prev.content.split("\n").length;
      // Only merge if combined size is reasonable
      if (prevLineCount + lineCount <= cfg.maxChunkLines) {
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
 * Tries to split at blank lines or heading boundaries.
 */
function splitOversizedChunk(chunk: Chunk, cfg: ChunkerConfig): Chunk[] {
  const lines = chunk.content.split("\n");
  const target = cfg.maxChunkLines;
  const subChunks: Chunk[] = [];

  let start = 0;
  while (start < lines.length) {
    let end = Math.min(start + target, lines.length);

    // Try to find a natural break point (blank line) near the target
    if (end < lines.length) {
      let bestBreak = -1;
      // Search backward from target for a blank line
      for (let i = end; i > start + Math.floor(target * 0.5); i--) {
        if (lines[i].trim() === "") {
          bestBreak = i;
          break;
        }
      }
      if (bestBreak > start) {
        end = bestBreak;
      }
    }

    const subLines = lines.slice(start, end);
    if (subLines.some((l) => l.trim())) {
      subChunks.push({
        content: subLines.join("\n"),
        lineStart: chunk.lineStart + start,
        lineEnd: chunk.lineStart + end - 1,
        type: chunk.type,
        label: chunk.label
          ? `${chunk.label} (part ${subChunks.length + 1})`
          : undefined,
      });
    }

    start = end;
  }

  return subChunks;
}

// ─────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────

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
