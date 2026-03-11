/**
 * Analytics Routes
 *
 * POST /api/v1/analytics - Obter analytics e métricas
 */

import { Elysia, t } from "elysia";
import { GetAnalyticsTool } from "@th0th-ai/core";

const getAnalyticsTool = new GetAnalyticsTool();

export const analyticsRoutes = new Elysia({ prefix: "/api/v1/analytics" }).post(
  "/",
  async ({ body }) => {
    return await getAnalyticsTool.handle(body);
  },
  {
    body: t.Object({
      type: t.Union(
        [
          t.Literal("summary"),
          t.Literal("project"),
          t.Literal("query"),
          t.Literal("cache"),
          t.Literal("recent"),
        ],
        { description: "Type of analytics" },
      ),
      projectId: t.Optional(t.String()),
      query: t.Optional(t.String()),
      limit: t.Optional(t.Number({ default: 10 })),
    }),
    detail: {
      tags: ["analytics"],
      summary: "Get analytics",
      description: "Get search analytics and performance metrics",
    },
  },
);
