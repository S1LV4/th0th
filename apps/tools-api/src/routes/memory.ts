/**
 * Memory Routes
 *
 * POST /api/v1/memory/store  - Armazenar memória
 * POST /api/v1/memory/search - Buscar memórias
 * POST /api/v1/memory/list   - Listar memórias (sem busca semântica)
 */

import { Elysia, t } from "elysia";
import {
  StoreMemoryTool,
  SearchMemoriesTool,
  MemoryRepository,
} from "@th0th-ai/core";
import type { MemoryRow } from "@th0th-ai/core";
import { logger } from "@th0th-ai/shared";

const storeMemoryTool = new StoreMemoryTool();
const searchMemoriesTool = new SearchMemoriesTool();

/** Convert a raw MemoryRow into the same shape the search endpoint returns. */
function formatRow(row: MemoryRow) {
  let tags: string[] = [];
  try {
    tags = row.tags ? JSON.parse(row.tags) : [];
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    level: row.level,
    agentId: row.agent_id,
    importance: row.importance,
    tags,
    score: row.importance, // no semantic score — use importance as proxy
    createdAt: new Date(row.created_at).toISOString(),
    accessCount: row.access_count,
  };
}

export const memoryRoutes = new Elysia({ prefix: "/api/v1/memory" })
  .post(
    "/store",
    async ({ body }) => {
      return await storeMemoryTool.handle(body);
    },
    {
      body: t.Object({
        content: t.String({ description: "Content to store in memory" }),
        type: t.Union(
          [
            t.Literal("preference"),
            t.Literal("conversation"),
            t.Literal("code"),
            t.Literal("decision"),
            t.Literal("pattern"),
          ],
          { description: "Type of memory" },
        ),
        userId: t.Optional(t.String()),
        projectId: t.Optional(t.String()),
        sessionId: t.Optional(t.String()),
        agentId: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        importance: t.Optional(
          t.Number({ minimum: 0, maximum: 1, default: 0.5 }),
        ),
        format: t.Optional(
          t.Union([t.Literal("json"), t.Literal("toon")], { default: "toon" }),
        ),
      }),
      detail: {
        tags: ["memory"],
        summary: "Store memory",
        description:
          "Store a new memory in the hierarchical memory system (local SQLite)",
      },
    },
  )
  .post(
    "/search",
    async ({ body }) => {
      return await searchMemoriesTool.handle(body);
    },
    {
      body: t.Object({
        query: t.String({ description: "Search query (what to remember)" }),
        userId: t.Optional(t.String()),
        projectId: t.Optional(t.String()),
        sessionId: t.Optional(t.String()),
        agentId: t.Optional(t.String()),
        types: t.Optional(
          t.Array(
            t.Union([
              t.Literal("preference"),
              t.Literal("conversation"),
              t.Literal("code"),
              t.Literal("decision"),
              t.Literal("pattern"),
            ]),
          ),
        ),
        limit: t.Optional(t.Number({ default: 10 })),
        minImportance: t.Optional(
          t.Number({ minimum: 0, maximum: 1, default: 0.3 }),
        ),
        includePersistent: t.Optional(t.Boolean({ default: true })),
        format: t.Optional(
          t.Union([t.Literal("json"), t.Literal("toon")], { default: "toon" }),
        ),
      }),
      detail: {
        tags: ["memory"],
        summary: "Search memories",
        description:
          "Search stored memories using semantic search across sessions",
      },
    },
  )
  .post(
    "/list",
    async ({ body }) => {
      try {
        const repo = MemoryRepository.getInstance();
        const db = repo.getDb();

        const conditions: string[] = [];
        const params: any[] = [];

        if (body.type) {
          conditions.push("type = ?");
          params.push(body.type);
        }
        if (body.minImportance != null) {
          conditions.push("importance >= ?");
          params.push(body.minImportance);
        }

        const whereClause =
          conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const limit = body.limit ?? 50;
        const offset = body.offset ?? 0;

        const countSql = `SELECT COUNT(*) as total FROM memories ${whereClause}`;
        const total = (db.prepare(countSql).get(...params) as any).total;

        const sql = `
          SELECT
            id, content, type, level,
            user_id, session_id, project_id, agent_id,
            importance, tags, embedding,
            created_at, access_count, last_accessed
          FROM memories
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `;
        params.push(limit, offset);

        const rows = db.prepare(sql).all(...params) as MemoryRow[];

        return {
          success: true,
          data: {
            memories: rows.map(formatRow),
            total,
            limit,
            offset,
          },
        };
      } catch (error) {
        logger.error("Failed to list memories", error as Error);
        return {
          success: false,
          error: `Failed to list memories: ${(error as Error).message}`,
        };
      }
    },
    {
      body: t.Object({
        type: t.Optional(
          t.Union([
            t.Literal("preference"),
            t.Literal("conversation"),
            t.Literal("code"),
            t.Literal("decision"),
            t.Literal("pattern"),
          ]),
        ),
        limit: t.Optional(t.Number({ default: 50 })),
        offset: t.Optional(t.Number({ default: 0 })),
        minImportance: t.Optional(
          t.Number({ minimum: 0, maximum: 1, default: 0 }),
        ),
      }),
      detail: {
        tags: ["memory"],
        summary: "List memories",
        description:
          "List stored memories with optional filters (no semantic search, ordered by creation date)",
      },
    },
  );
