/**
 * Project Routes
 *
 * GET  /api/v1/project/list - Listar projetos indexados
 * POST /api/v1/project/index - Indexar projeto (assíncrono)
 * GET /api/v1/project/index/status/:jobId - Consultar status de indexação
 */

import { Elysia, t } from "elysia";
import { IndexProjectTool, GetIndexStatusTool, sqliteVectorStore } from "@th0th-ai/core";

const indexProjectTool = new IndexProjectTool();
const getIndexStatusTool = new GetIndexStatusTool();

export const projectRoutes = new Elysia({ prefix: "/api/v1/project" })
  .get(
    "/list",
    async () => {
      try {
        const projects = await sqliteVectorStore.listProjects();
        return {
          success: true,
          data: {
            projects,
            total: projects.length,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    },
    {
      detail: {
        tags: ["project"],
        summary: "List indexed projects",
        description:
          "List all projects that have been indexed in the vector store, with document counts and metadata.",
      },
    },
  )
  .post(
    "/index",
    async ({ body }) => {
      return await indexProjectTool.handle(body);
    },
    {
      body: t.Object({
        projectPath: t.String({
          description: "Absolute path to the project directory to index",
        }),
        projectId: t.Optional(
          t.String({ description: "Unique identifier for the project" }),
        ),
        forceReindex: t.Optional(t.Boolean({ default: false })),
        warmCache: t.Optional(
          t.Boolean({
            default: false,
            description: "Pre-cache common queries after indexing",
          }),
        ),
        warmupQueries: t.Optional(
          t.Array(t.String(), { description: "Custom queries to pre-cache" }),
        ),
      }),
      detail: {
        tags: ["project"],
        summary: "Index a project (async)",
        description:
          "Start indexing a project directory in background. Returns a jobId immediately. Use GET /index/status/:jobId to check progress.",
      },
    },
  )
  .get(
    "/index/status/:jobId",
    async ({ params }) => {
      return await getIndexStatusTool.handle({ jobId: params.jobId });
    },
    {
      params: t.Object({
        jobId: t.String({ description: "Job ID returned by POST /index" }),
      }),
      detail: {
        tags: ["project"],
        summary: "Get indexing job status",
        description:
          "Get the status and progress of an async indexing job started with POST /index",
      },
    },
  );
