/**
 * Search Routes
 *
 * POST /api/v1/search/project - Busca em projeto indexado
 * POST /api/v1/search/code    - Busca semântica de código
 */

import { SearchCodeTool, SearchProjectTool } from "@th0th-ai/core";
import { Elysia, t } from "elysia";

let searchProjectTool: SearchProjectTool | null = null;
let searchCodeTool: SearchCodeTool | null = null;

function getSearchProjectTool(): SearchProjectTool {
  if (!searchProjectTool) {
    searchProjectTool = new SearchProjectTool();
  }
  return searchProjectTool;
}

function getSearchCodeTool(): SearchCodeTool {
  if (!searchCodeTool) {
    searchCodeTool = new SearchCodeTool();
  }
  return searchCodeTool;
}

export const searchRoutes = new Elysia({ prefix: "/api/v1/search" })
  .post(
    "/project",
    async ({ body }) => {
      return await getSearchProjectTool().handle(body);
    },
    {
      body: t.Object({
        query: t.String({
          description: "Search query (natural language or keywords)",
        }),
        projectId: t.String({ description: "Project ID to search in" }),
        projectPath: t.Optional(
          t.String({ description: "Project path for auto-reindex" }),
        ),
        maxResults: t.Optional(
          t.Number({ default: 10, description: "Max results to return" }),
        ),
        minScore: t.Optional(
          t.Number({
            default: 0.3,
            description: "Minimum relevance score (0-1)",
          }),
        ),
        responseMode: t.Optional(
          t.Union([t.Literal("summary"), t.Literal("full")], {
            default: "summary",
          }),
        ),
        autoReindex: t.Optional(t.Boolean({ default: false })),
        include: t.Optional(
          t.Array(t.String(), { description: "Glob patterns to include" }),
        ),
        exclude: t.Optional(
          t.Array(t.String(), { description: "Glob patterns to exclude" }),
        ),
        explainScores: t.Optional(t.Boolean({ default: false })),
        sessionId: t.Optional(t.String({ description: "Session ID for hook scoping" })),
        format: t.Optional(
          t.Union([t.Literal("json"), t.Literal("toon")], {
            default: "toon",
            description: "Output format (json or toon)",
          }),
        ),
      }),
      detail: {
        tags: ["search"],
        summary: "Search indexed project",
        description:
          "Contextual search using hybrid vector + keyword search with RRF ranking",
      },
    },
  )
  .post(
    "/code",
    async ({ body }) => {
      return await getSearchCodeTool().handle(body);
    },
    {
      body: t.Object({
        query: t.String({ description: "Code search query" }),
        projectId: t.String({ description: "Project ID to search in" }),
        limit: t.Optional(t.Number({ default: 10 })),
      }),
      detail: {
        tags: ["search"],
        summary: "Semantic code search",
        description:
          "Search for code using semantic and keyword search (alias for search_project)",
      },
    },
  );
