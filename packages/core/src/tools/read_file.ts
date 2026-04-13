/**
 * @th0th-ai/core - Read File Tool
 * 
 * Optimized file reading with:
 * - Automatic compression for large files
 * - Intelligent caching
 * - Symbol metadata integration
 * - Multi-range support
 * - Language detection
 */

import { IToolHandler, ToolResponse, estimateTokens } from "@th0th-ai/shared";
import { logger } from "@th0th-ai/shared";
import { CodeCompressor } from "../services/compression/code-compressor.js";
import { SymbolGraphService } from "../services/symbol/symbol-graph.service.js";
import fs from "fs/promises";
import path from "path";

interface ReadFileParams {
  filePath: string;
  projectId?: string;
  offset?: number;
  limit?: number;
  lineStart?: number;
  lineEnd?: number;
  compress?: boolean;
  targetRatio?: number;
  format?: "json" | "toon";
  includeSymbols?: boolean;
  includeImports?: boolean;
}

interface ReadRange {
  start: number;
  end: number;
}

interface FileMetadata {
  totalLines: number;
  language?: string;
  symbols?: {
    definitions: number;
    references: number;
  };
  imports?: string[];
}

interface CachedFile {
  content: string;
  timestamp: number;
  metadata?: FileMetadata;
}

export class ReadFileTool implements IToolHandler {
  name = "read_file";
  description = 
    "Read file with automatic compression, caching, and symbol metadata. " +
    "Use with th0th_search results for 60% token savings.";

  inputSchema = {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "File path (absolute or relative to project root)",
      },
      projectId: {
        type: "string",
        description: "Project ID for symbol metadata (optional)",
      },
      offset: {
        type: "number",
        description: "Start line number (1-indexed)",
      },
      limit: {
        type: "number",
        description: "Number of lines to read",
      },
      lineStart: {
        type: "number",
        description: "Start line (alternative to offset)",
      },
      lineEnd: {
        type: "number",
        description: "End line (alternative to limit)",
      },
      compress: {
        type: "boolean",
        description: "Auto-compress content > 100 lines (default: true)",
        default: true,
      },
      targetRatio: {
        type: "number",
        description: "Compression target ratio (0.3 = 70% reduction)",
        default: 0.3,
      },
      format: {
        type: "string",
        enum: ["json", "toon"],
        description: "Output format",
        default: "json",
      },
      includeSymbols: {
        type: "boolean",
        description: "Include symbol metadata from graph (default: true)",
        default: true,
      },
      includeImports: {
        type: "boolean",
        description: "Extract and show import statements (default: true)",
        default: true,
      },
    },
    required: ["filePath"],
  };

  private compressor: CodeCompressor;
  private symbolGraph?: SymbolGraphService;
  private fileCache: Map<string, CachedFile> = new Map();
  private readonly CACHE_TTL = 60000; // 1 minute

  constructor(symbolGraph?: SymbolGraphService) {
    this.compressor = new CodeCompressor();
    this.symbolGraph = symbolGraph;
  }

  async handle(params: unknown): Promise<ToolResponse> {
    const p = params as ReadFileParams;
    const shouldCompress = p.compress !== false;
    const targetRatio = p.targetRatio || 0.3;
    const format = p.format || "json";
    const includeSymbols = p.includeSymbols !== false;
    const includeImports = p.includeImports !== false;

    try {
      // Resolve file path
      const filePath = this.resolveFilePath(p.filePath, p.projectId);
      
      // Calculate line range
      const range = this.calculateRange(p);
      
      // Read file with cache
      const { content, metadata } = await this.readFileWithCache(filePath, {
        includeSymbols,
        includeImports,
        projectId: p.projectId,
      });

      // Extract requested lines
      const lines = content.split("\n");
      const totalLines = lines.length;
      const adjustedRange = this.adjustRange(range, totalLines);
      const selectedContent = this.extractLines(lines, adjustedRange);
      const selectedLineCount = selectedContent.split("\n").length;

      // Determine if compression is needed
      const shouldAutoCompress = 
        shouldCompress && 
        selectedLineCount > 100 && 
        targetRatio < 1;

      const result: any = {
        filePath: p.filePath,
        absolutePath: filePath,
        lineRange: {
          requested: {
            start: range.start,
            end: range.end === Infinity ? null : range.end,
          },
          actual: {
            start: adjustedRange.start,
            end: adjustedRange.end,
            total: totalLines,
          },
          selected: selectedLineCount,
        },
        metadata: {
          totalLines,
          language: metadata.language,
          ...(metadata.symbols && { symbols: metadata.symbols }),
          ...(metadata.imports && { imports: metadata.imports }),
        },
        compressed: shouldAutoCompress,
        recommendations: [],
      };

      if (shouldAutoCompress) {
        // Auto-compress
        const compressed = await this.compressor.compress(
          selectedContent,
          "code_structure" as any
        );

        const originalTokens = estimateTokens(selectedContent, "code");
        const compressedTokens = estimateTokens(compressed.compressed, "code");
        const actualRatio = compressedTokens / originalTokens;

        result.content = compressed.compressed;
        result.tokens = {
          original: originalTokens,
          compressed: compressedTokens,
          saved: originalTokens - compressedTokens,
          savingsPercent: Math.round((1 - actualRatio) * 100),
        };
        result.compressionRatio = actualRatio;
        result.recommendations.push(
          `✓ Auto-compressed ${selectedLineCount} lines (${result.tokens.savingsPercent}% reduction)`
        );
      } else {
        result.content = selectedContent;
        result.tokens = {
          original: estimateTokens(selectedContent, "code"),
          compressed: estimateTokens(selectedContent, "code"),
          saved: 0,
          savingsPercent: 0,
        };

        // Add recommendations for large files
        if (selectedLineCount > 100) {
          result.recommendations.push(
            "💡 Content > 100 lines. Consider compress=true for token savings"
          );
        }
      }

      // Add usage tips
      if (range.start === 1 && range.end === Infinity) {
        result.recommendations.push(
          "💡 Use lineStart/lineEnd or offset/limit to read specific sections (60% token savings)"
        );
      }

      // Add related files tip if symbols found
      if (metadata.symbols && metadata.symbols.definitions > 0) {
        result.recommendations.push(
          `💡 Use th0th_get_references() to find usages of ${metadata.symbols.definitions} symbols in this file`
        );
      }

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      logger.error("Failed to read file", error as Error, {
        filePath: p.filePath,
      });
      return {
        success: false,
        error: `Failed to read file: ${(error as Error).message}`,
      };
    }
  }

  private resolveFilePath(filePath: string, projectId?: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.resolve(filePath);
  }

  private calculateRange(params: ReadFileParams): ReadRange {
    // Priority: lineStart/lineEnd > offset/limit > entire file
    if (params.lineStart !== undefined && params.lineEnd !== undefined) {
      return {
        start: Math.max(1, params.lineStart),
        end: params.lineEnd,
      };
    }

    if (params.offset !== undefined) {
      const offset = Math.max(1, params.offset);
      const limit = params.limit || 1000;
      return {
        start: offset,
        end: offset + limit - 1,
      };
    }

    return {
      start: 1,
      end: Infinity,
    };
  }

  private adjustRange(range: ReadRange, totalLines: number): ReadRange {
    const start = Math.max(1, Math.min(range.start, totalLines));
    const end = range.end === Infinity 
      ? totalLines 
      : Math.min(range.end, totalLines);
    
    return { start, end };
  }

  private async readFileWithCache(
    filePath: string,
    options: {
      includeSymbols: boolean;
      includeImports: boolean;
      projectId?: string;
    }
  ): Promise<{ content: string; metadata: FileMetadata }> {
    const cacheKey = filePath;
    const cached = this.fileCache.get(cacheKey);

    // Check cache validity
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      logger.debug("File cache hit", { filePath });
      return {
        content: cached.content,
        metadata: cached.metadata || await this.extractMetadata(cached.content, filePath, options),
      };
    }

    // Read file
    const content = await fs.readFile(filePath, "utf-8");
    const metadata = await this.extractMetadata(content, filePath, options);

    // Update cache
    this.fileCache.set(cacheKey, {
      content,
      timestamp: Date.now(),
      metadata,
    });

    logger.debug("File read and cached", { filePath });
    
    return { content, metadata };
  }

  private async extractMetadata(
    content: string,
    filePath: string,
    options: {
      includeSymbols: boolean;
      includeImports: boolean;
      projectId?: string;
    }
  ): Promise<FileMetadata> {
    const lines = content.split("\n");
    const language = this.detectLanguage(filePath);
    
    const metadata: FileMetadata = {
      totalLines: lines.length,
      language,
    };

    // Extract imports if requested
    if (options.includeImports && language) {
      metadata.imports = this.extractImports(lines, language);
    }

    // Get symbol metadata if symbol graph available
    if (options.includeSymbols && this.symbolGraph && options.projectId) {
      try {
        const definitions = await this.symbolGraph.listDefinitions(
          options.projectId,
          {
            file: filePath,
            limit: 100,
          }
        );

        metadata.symbols = {
          definitions: definitions.length,
          references: 0, // Would need separate query
        };
      } catch (error) {
        logger.debug("Failed to get symbol metadata", { filePath, error });
      }
    }

    return metadata;
  }

  private extractLines(lines: string[], range: ReadRange): string {
    const start = range.start - 1; // Convert to 0-indexed
    const end = range.end;
    
    const selectedLines = lines.slice(start, end);
    
    // Add line numbers for context
    return selectedLines
      .map((line, index) => {
        const lineNum = start + index + 1;
        return `${lineNum.toString().padStart(6, " ")}: ${line}`;
      })
      .join("\n");
  }

  private detectLanguage(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      ".ts": "TypeScript",
      ".tsx": "TypeScript",
      ".js": "JavaScript",
      ".jsx": "JavaScript",
      ".py": "Python",
      ".go": "Go",
      ".rs": "Rust",
      ".java": "Java",
      ".cpp": "C++",
      ".c": "C",
      ".h": "C",
      ".hpp": "C++",
      ".cs": "C#",
      ".rb": "Ruby",
      ".php": "PHP",
      ".swift": "Swift",
      ".kt": "Kotlin",
      ".scala": "Scala",
      ".md": "Markdown",
      ".json": "JSON",
      ".yaml": "YAML",
      ".yml": "YAML",
      ".xml": "XML",
      ".html": "HTML",
      ".css": "CSS",
      ".scss": "SCSS",
      ".sql": "SQL",
      ".sh": "Shell",
      ".bash": "Shell",
    };
    return languageMap[ext];
  }

  private extractImports(lines: string[], language: string): string[] {
    const imports: string[] = [];
    
    const importPatterns: Record<string, RegExp> = {
      TypeScript: /^(import\s+.*?from\s+['"]|import\s+['"])/,
      JavaScript: /^(import\s+.*?from\s+['"]|import\s+['"]|require\s*\(\s*['"])/,
      Python: /^(import\s+|from\s+\S+\s+import)/,
      Go: /^import\s+/,
      Java: /^import\s+/,
      Rust: /^use\s+/,
    };

    const pattern = importPatterns[language];
    if (!pattern) return imports;

    for (const line of lines) {
      const trimmed = line.trim();
      if (pattern.test(trimmed)) {
        imports.push(trimmed);
      }
    }

    return imports;
  }
}
