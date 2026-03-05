/**
 * Search Definitions Tool (th0th_search_definitions)
 *
 * Browse symbols (functions, classes, types, etc.) in a project.
 * Uses the Symbol Graph's SQLite index for fast, exact results.
 */

import { IToolHandler, ToolResponse } from "@th0th-ai/shared";
import { symbolGraphService } from "../services/symbol/symbol-graph.service.js";

interface SearchDefinitionsParams {
  projectId: string;
  query?: string;
  kind?: string[];
  file?: string;
  exportedOnly?: boolean;
  maxResults?: number;
}

export class SearchDefinitionsTool implements IToolHandler {
  name = "search_definitions";
  description =
    "Search for symbol definitions (functions, classes, variables, types, interfaces) in an indexed project. Returns name, kind, file location, and doc comments.";

  inputSchema = {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "The project ID to search in",
      },
      query: {
        type: "string",
        description: "Substring search on symbol name (case-insensitive)",
      },
      kind: {
        type: "array",
        items: {
          type: "string",
          enum: ["function", "class", "variable", "type", "interface", "export"],
        },
        description: "Filter by symbol kind",
      },
      file: {
        type: "string",
        description: "Filter by file path (relative to project root)",
      },
      exportedOnly: {
        type: "boolean",
        description: "Return only exported symbols",
        default: false,
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return (default: 20)",
        default: 20,
      },
    },
    required: ["projectId"],
  };

  async handle(params: unknown): Promise<ToolResponse> {
    const {
      projectId,
      query,
      kind,
      file,
      exportedOnly = false,
      maxResults = 20,
    } = params as SearchDefinitionsParams;

    try {
      const definitions = await symbolGraphService.listDefinitions(projectId, {
        search: query,
        kind,
        file,
        exportedOnly,
        limit: maxResults,
      });

      return {
        success: true,
        data: {
          definitions: definitions.map((d) => ({
            fqn: d.fqn,
            name: d.name,
            kind: d.kind,
            file: d.file,
            lineStart: d.lineStart,
            lineEnd: d.lineEnd,
            exported: d.exported,
            docComment: d.docComment,
            centralityScore: d.centralityScore,
          })),
          total: definitions.length,
          projectId,
          query: query ?? null,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to search definitions: ${(error as Error).message}`,
      };
    }
  }
}
