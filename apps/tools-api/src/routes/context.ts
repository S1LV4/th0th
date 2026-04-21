/**
 * Context Routes
 *
 * POST /api/v1/context/compress   - Comprimir contexto
 * POST /api/v1/context/optimized  - Obter contexto otimizado
 */

import { CompressContextTool, GetOptimizedContextTool } from "@th0th-ai/core";
import { Elysia, t } from "elysia";

let compressContextTool: CompressContextTool | null = null;
let optimizedContextTool: GetOptimizedContextTool | null = null;

function getCompressContextTool(): CompressContextTool {
  if (!compressContextTool) {
    compressContextTool = new CompressContextTool();
  }
  return compressContextTool;
}

function getOptimizedContextTool(): GetOptimizedContextTool {
  if (!optimizedContextTool) {
    optimizedContextTool = new GetOptimizedContextTool();
  }
  return optimizedContextTool;
}

export const contextRoutes = new Elysia({ prefix: "/api/v1/context" })
  .post(
    "/compress",
    async ({ body }) => {
      return await getCompressContextTool().handle(body);
    },
    {
      body: t.Object({
        content: t.String({ description: "Content to compress" }),
        strategy: t.Optional(
          t.Union(
            [
              t.Literal("code_structure"),
              t.Literal("conversation_summary"),
              t.Literal("semantic_dedup"),
              t.Literal("hierarchical"),
            ],
            { default: "code_structure" },
          ),
        ),
        targetRatio: t.Optional(
          t.Number({
            minimum: 0,
            maximum: 1,
            default: 0.7,
            description: "Target compression ratio",
          }),
        ),
        language: t.Optional(
          t.String({
            description: "Programming language for code compression",
          }),
        ),
      }),
      detail: {
        tags: ["context"],
        summary: "Compress context",
        description:
          "Compress context using semantic compression (keeps structure, removes details)",
      },
    },
  )
  .post(
    "/optimized",
    async ({ body }) => {
      return await getOptimizedContextTool().handle(body);
    },
    {
      body: t.Object({
        query: t.String({
          description: "Search query to find relevant context",
        }),
        projectId: t.String({ description: "Project ID for code context" }),
        projectPath: t.Optional(t.String()),
        maxTokens: t.Optional(
          t.Number({
            default: 4000,
            description: "Maximum tokens in returned context",
          }),
        ),
        maxResults: t.Optional(
          t.Number({
            default: 5,
            description: "Maximum search results to include",
          }),
        ),
      }),
      detail: {
        tags: ["context"],
        summary: "Get optimized context",
        description:
          "Retrieve and compress context with maximum token efficiency (search + compress)",
      },
    },
  );
