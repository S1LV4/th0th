/**
 * Go To Definition Tool (th0th_go_to_definition)
 *
 * Resolves where a symbol is declared, with disambiguation by calling context.
 * Returns file path, line range, doc comment, and code snippet.
 */

import { IToolHandler, ToolResponse } from "@th0th-ai/shared";
import { symbolGraphService } from "../services/symbol/symbol-graph.service.js";

interface GoToDefinitionParams {
  projectId: string;
  symbolName: string;
  fromFile?: string;
}

export class GoToDefinitionTool implements IToolHandler {
  name = "go_to_definition";
  description =
    "Find the definition of a symbol (function, class, variable, type, etc.) in the project. Disambiguates by calling file context. Returns file location, line numbers, doc comment, and code snippet.";

  inputSchema = {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "The project ID to search in",
      },
      symbolName: {
        type: "string",
        description: "Name of the symbol to find the definition for",
      },
      fromFile: {
        type: "string",
        description:
          "Relative path of the file where the symbol is used. Helps prioritize the correct definition when multiple exist.",
      },
    },
    required: ["projectId", "symbolName"],
  };

  async handle(params: unknown): Promise<ToolResponse> {
    const { projectId, symbolName, fromFile } = params as GoToDefinitionParams;

    try {
      const definitions = await symbolGraphService.goToDefinition(
        projectId,
        symbolName,
        fromFile,
      );

      if (definitions.length === 0) {
        return {
          success: true,
          data: {
            found: false,
            symbolName,
            message: `No definition found for '${symbolName}' in project '${projectId}'`,
            projectId,
          },
        };
      }

      return {
        success: true,
        data: {
          found: true,
          symbolName,
          fromFile: fromFile ?? null,
          definitions: definitions.map((d) => ({
            fqn: d.fqn,
            name: d.name,
            kind: d.kind,
            file: d.file,
            lineStart: d.lineStart,
            lineEnd: d.lineEnd,
            exported: d.exported,
            docComment: d.docComment,
            snippet: d.snippet,
            centralityScore: d.centralityScore,
          })),
          total: definitions.length,
          projectId,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to go to definition: ${(error as Error).message}`,
      };
    }
  }
}
