/**
 * File Routes
 *
 * POST /api/v1/file/read - Read file with optimizations
 */

import { ReadFileTool, SymbolGraphService } from "@th0th-ai/core";
import { Elysia, t } from "elysia";

let readFileTool: ReadFileTool | null = null;

function getReadFileTool(): ReadFileTool {
  if (!readFileTool) {
    const symbolGraph = SymbolGraphService.getInstance();
    readFileTool = new ReadFileTool(symbolGraph);
  }
  return readFileTool;
}

export const fileRoutes = new Elysia({ prefix: "/api/v1/file" }).post(
  "/read",
  async ({ body }) => {
    return await getReadFileTool().handle(body);
  },
  {
    body: t.Object({
      filePath: t.String({
        description: "File path (absolute or relative to project root)",
      }),
      projectId: t.Optional(
        t.String({ description: "Project ID for symbol metadata" }),
      ),
      offset: t.Optional(
        t.Number({ description: "Start line number (1-indexed)" }),
      ),
      limit: t.Optional(t.Number({ description: "Number of lines to read" })),
      lineStart: t.Optional(
        t.Number({ description: "Start line (alternative to offset)" }),
      ),
      lineEnd: t.Optional(
        t.Number({ description: "End line (alternative to limit)" }),
      ),
      compress: t.Optional(
        t.Boolean({
          default: true,
          description: "Auto-compress content > 100 lines",
        }),
      ),
      targetRatio: t.Optional(
        t.Number({
          default: 0.3,
          description: "Compression target ratio (0.3 = 70% reduction)",
        }),
      ),
      format: t.Optional(
        t.Union([t.Literal("json"), t.Literal("toon")], {
          default: "json",
        }),
      ),
      includeSymbols: t.Optional(
        t.Boolean({
          default: true,
          description: "Include symbol metadata from graph",
        }),
      ),
      includeImports: t.Optional(
        t.Boolean({
          default: true,
          description: "Extract and show import statements",
        }),
      ),
    }),
    detail: {
      summary: "Read file with optimizations",
      description:
        "Read file with automatic compression, caching, and symbol metadata. " +
        "Use with th0th_search results for 60% token savings.",
      tags: ["file"],
    },
  },
);
