/**
 * Project Routes
 *
 * GET  /api/v1/project/list - Listar projetos indexados
 * POST /api/v1/project/index - Indexar projeto (assíncrono)
 * GET /api/v1/project/index/status/:jobId - Consultar status de indexação
 */

import {
  GetIndexStatusTool,
  IndexProjectTool,
  getMemoryRepository,
  getSearchCache,
  getVectorStore,
  workspaceManager,
} from "@th0th-ai/core";
import { Elysia, t } from "elysia";
import fs from "fs/promises";
import os from "os";
import path from "path";

let indexProjectTool: IndexProjectTool | null = null;
let indexStatusTool: GetIndexStatusTool | null = null;

function getIndexProjectTool(): IndexProjectTool {
  if (!indexProjectTool) {
    indexProjectTool = new IndexProjectTool();
  }
  return indexProjectTool;
}

function getIndexStatusTool(): GetIndexStatusTool {
  if (!indexStatusTool) {
    indexStatusTool = new GetIndexStatusTool();
  }
  return indexStatusTool;
}

export const projectRoutes = new Elysia({ prefix: "/api/v1/project" })
  .get(
    "/list",
    async () => {
      try {
        const vectorStore = await getVectorStore();
        const projects = await vectorStore.listProjects();
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
      return await getIndexProjectTool().handle(body);
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
  .post(
    "/reset",
    async ({ body }) => {
      const {
        projectId,
        clearVectors = true,
        clearSymbols = true,
        clearMemories = true,
      } = body as {
        projectId: string;
        clearVectors?: boolean;
        clearSymbols?: boolean;
        clearMemories?: boolean;
      };

      const result: Record<string, number | string> = {};
      const errors: string[] = [];

      if (clearVectors) {
        try {
          const vectorStore = await getVectorStore();
          result.vectorsDeleted = await vectorStore.deleteByProject(projectId);
          // Invalidate the in-process search cache (L1 + L2). Without this,
          // queries served from L1 keep returning stale chunk metadata
          // (file/lineStart/lineEnd) until the process restarts.
          await getSearchCache().invalidateProject(projectId);
        } catch (e) {
          errors.push(`vectors: ${(e as Error).message}`);
        }
      }

      if (clearSymbols) {
        try {
          await workspaceManager.removeWorkspace(projectId);
          result.symbolsCleared = 1;
        } catch (e) {
          // workspace may not exist — treat as success
          result.symbolsCleared = 0;
        }
      }

      if (clearMemories) {
        try {
          result.memoriesDeleted =
            await getMemoryRepository().deleteByProject(projectId);
        } catch (e) {
          errors.push(`memories: ${(e as Error).message}`);
        }
      }

      if (errors.length > 0) {
        return {
          success: false,
          data: result,
          errors,
        };
      }

      return {
        success: true,
        data: {
          projectId,
          ...result,
          message: `Project '${projectId}' reset complete.`,
        },
      };
    },
    {
      body: t.Object({
        projectId: t.String({ description: "Project ID to reset" }),
        clearVectors: t.Optional(
          t.Boolean({
            default: true,
            description: "Delete vector embeddings (semantic search index)",
          }),
        ),
        clearSymbols: t.Optional(
          t.Boolean({
            default: true,
            description:
              "Delete symbol graph (definitions, references, imports, centrality)",
          }),
        ),
        clearMemories: t.Optional(
          t.Boolean({
            default: true,
            description: "Delete stored memories for this project",
          }),
        ),
      }),
      detail: {
        tags: ["project"],
        summary: "Reset / clean a project",
        description:
          "Delete all indexed data for a project: vector embeddings, symbol graph, and memories. Each scope can be toggled independently. Useful before a full reindex or to free space.",
      },
    },
  )

  .post(
    "/upload-and-index",
    async ({ body }) => {
      const finalProjectId = body.projectId || path.basename(body.projectPath) || "default";
      const stagingDir = path.join(
        process.env.TH0TH_UPLOAD_DIR || path.join(os.homedir(), ".rlm", "uploads"),
        finalProjectId,
      );

      await Promise.all(
        body.files.map(async (file) => {
          const dest = path.join(stagingDir, file.relativePath);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, file.content, "utf-8");
        }),
      );

      return await getIndexProjectTool().handle({
        projectPath: stagingDir,
        projectId: finalProjectId,
        forceReindex: body.forceReindex,
        warmCache: body.warmCache,
        warmupQueries: body.warmupQueries,
      });
    },
    {
      body: t.Object({
        projectPath: t.String({
          description: "Original path on the client machine (used to derive projectId)",
        }),
        projectId: t.Optional(t.String()),
        forceReindex: t.Optional(t.Boolean({ default: false })),
        warmCache: t.Optional(t.Boolean({ default: false })),
        warmupQueries: t.Optional(t.Array(t.String())),
        files: t.Array(
          t.Object({
            relativePath: t.String(),
            content: t.String(),
          }),
        ),
      }),
      detail: {
        tags: ["project"],
        summary: "Upload files and index (remote client)",
        description:
          "Receive project files from a remote MCP client, write them to a server-side staging directory, and kick off the ETL indexing pipeline.",
      },
    },
  )

  .get(
    "/index/status/:jobId",
    async ({ params }) => {
      return await getIndexStatusTool().handle({ jobId: params.jobId });
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
