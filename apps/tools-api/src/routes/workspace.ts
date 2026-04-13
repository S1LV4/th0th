/**
 * Workspace Routes
 *
 * GET    /api/v1/workspace/list            ← list all workspaces (th0th_list_projects)
 * GET    /api/v1/workspace/:id             ← get single workspace details
 * DELETE /api/v1/workspace/:id             ← remove workspace + symbol data
 * POST   /api/v1/workspace/:id/reindex     ← force reindex
 *
 * GET    /api/v1/symbol/definitions        ← th0th_search_definitions
 * GET    /api/v1/symbol/references         ← th0th_get_references
 * GET    /api/v1/symbol/definition         ← th0th_go_to_definition
 */

import { Elysia, t } from "elysia";
import fs from "fs/promises";
import path from "path";
import {
  workspaceManager,
  symbolGraphService,
  IndexProjectTool,
} from "@th0th-ai/core";

const indexProjectTool = new IndexProjectTool();

export const workspaceRoutes = new Elysia({ prefix: "/api/v1" })
  // ── Workspace management ──────────────────────────────────────────────────

  .get(
    "/workspace/list",
    async ({ query }) => {
      try {
        const status = (query.status as string) || "all";
        const workspaces = await workspaceManager.listWorkspaces(status as "all");
        return {
          success: true,
          data: {
            workspaces: workspaces.map((w) => ({
              projectId: w.project_id,
              projectPath: w.project_path,
              displayName: w.display_name,
              status: w.status,
              lastIndexedAt: w.last_indexed_at
                ? new Date(w.last_indexed_at).toISOString()
                : null,
              lastError: w.last_error,
              filesCount: w.files_count,
              chunksCount: w.chunks_count,
              symbolsCount: w.symbols_count,
            })),
            total: workspaces.length,
          },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
    {
      detail: {
        tags: ["workspace"],
        summary: "List all indexed workspaces",
        description: "Returns all registered projects with their indexing status and statistics.",
      },
    },
  )

  .get(
    "/workspace/:id",
    async ({ params }) => {
      try {
        const workspace = await workspaceManager.getWorkspace(params.id);
        if (!workspace) {
          return { success: false, error: `Workspace '${params.id}' not found` };
        }
        return { success: true, data: workspace };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
    {
      detail: { tags: ["workspace"], summary: "Get workspace details" },
    },
  )

  .delete(
    "/workspace/:id",
    async ({ params }) => {
      try {
        await workspaceManager.removeWorkspace(params.id);
        return { success: true, data: { removed: params.id } };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
    {
      detail: {
        tags: ["workspace"],
        summary: "Remove workspace and all symbol data",
      },
    },
  )

  .post(
    "/workspace/:id/reindex",
    async ({ params, body }) => {
      try {
        const { projectPath } = body as { projectPath: string };
        return await indexProjectTool.handle({
          projectId: params.id,
          projectPath,
          forceReindex: true,
        });
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
    {
      body: t.Object({
        projectPath: t.String({ description: "Absolute path to project directory" }),
      }),
      detail: {
        tags: ["workspace"],
        summary: "Force reindex a workspace",
      },
    },
  )

  // ── Symbol graph ──────────────────────────────────────────────────────────

  .get(
    "/symbol/definitions",
    async ({ query }) => {
      try {
        const {
          projectId,
          search,
          kind,
          file,
          exportedOnly,
          limit = "20",
        } = query as Record<string, string>;

        if (!projectId) return { success: false, error: "projectId is required" };

        const defs = await symbolGraphService.listDefinitions(projectId, {
          search,
          kind: kind ? kind.split(",") : undefined,
          file,
          exportedOnly: exportedOnly === "true",
          limit: parseInt(limit, 10),
        });

        return { success: true, data: { definitions: defs, total: defs.length } };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
    {
      detail: {
        tags: ["symbol"],
        summary: "Search symbol definitions",
        description:
          "Browse functions, classes, variables, types, and interfaces. Params: projectId, search (name), kind (comma-separated), file, exportedOnly, limit.",
      },
    },
  )

  .get(
    "/symbol/references",
    async ({ query }) => {
      try {
        const { projectId, symbolName, fqn, limit = "50" } = query as Record<string, string>;

        if (!projectId) return { success: false, error: "projectId is required" };
        if (!symbolName) return { success: false, error: "symbolName is required" };

        const refs = await symbolGraphService.getReferences(projectId, symbolName, fqn);
        const limited = refs.slice(0, parseInt(limit, 10));

        return {
          success: true,
          data: { references: limited, total: refs.length, shown: limited.length },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
    {
      detail: {
        tags: ["symbol"],
        summary: "Get all references to a symbol",
      },
    },
  )

  .get(
    "/symbol/definition",
    async ({ query }) => {
      try {
        const { projectId, symbolName, fromFile } = query as Record<string, string>;

        if (!projectId) return { success: false, error: "projectId is required" };
        if (!symbolName) return { success: false, error: "symbolName is required" };

        const defs = await symbolGraphService.goToDefinition(projectId, symbolName, fromFile);

        return {
          success: true,
          data: {
            found: defs.length > 0,
            symbolName,
            definitions: defs,
          },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
    {
      detail: {
        tags: ["symbol"],
        summary: "Go to definition of a symbol",
      },
    },
  )

  .get(
    "/symbol/centrality/:projectId",
    async ({ params, query }) => {
      try {
        const projectId = params.projectId;
        if (!projectId) {
          return { success: false, error: "projectId is required" };
        }

        const limit = query.limit ? parseInt(query.limit as string, 10) : 20;
        const files = await symbolGraphService.getTopCentralFiles(projectId, limit);

        return {
          success: true,
          data: {
            projectId,
            files,
          },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
    {
      detail: {
        tags: ["symbol"],
        summary: "Get top central files",
        description: "Returns files ranked by PageRank centrality for a project",
      },
    },
  )

  .get(
    "/symbol/snippet",
    async ({ query }) => {
      try {
        const { projectId, file, lineStart = "1", lineEnd } = query as Record<string, string>;

        if (!projectId) return { success: false, error: "projectId is required" };
        if (!file) return { success: false, error: "file is required" };

        const workspace = await workspaceManager.getWorkspace(projectId);
        if (!workspace) {
          return { success: false, error: `Workspace '${projectId}' not found` };
        }

        const start = Math.max(1, parseInt(lineStart, 10));
        const end = lineEnd ? Math.max(start, parseInt(lineEnd, 10)) : start + 20;
        const absolutePath = path.join(workspace.project_path, file);
        const content = await fs.readFile(absolutePath, "utf-8");
        const lines = content.split(/\r?\n/);
        const slice = lines.slice(start - 1, Math.min(lines.length, end));

        const formatted = slice.map((text, idx) => ({
          lineNumber: start + idx,
          content: text,
        }));

        return {
          success: true,
          data: {
            file,
            projectId,
            startLine: start,
            endLine: start + slice.length - 1,
            lines: formatted,
          },
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
    {
      detail: {
        tags: ["symbol"],
        summary: "Get file snippet",
        description: "Returns code lines for the specified file and line range in a workspace",
      },
    },
  );
