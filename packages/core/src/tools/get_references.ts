/**
 * Get References Tool (th0th_get_references)
 *
 * Find all usage sites of a symbol across the project.
 * Returns file, line, usage kind, and code context snippets.
 */

import { IToolHandler, ToolResponse } from "@th0th-ai/shared";
import { symbolGraphService } from "../services/symbol/symbol-graph.service.js";

interface GetReferencesParams {
  projectId: string;
  symbolName: string;
  fqn?: string;
  maxResults?: number;
}

export class GetReferencesTool implements IToolHandler {
  name = "get_references";
  description =
    "Find all references (usages) of a symbol in the project. Returns file paths, line numbers, reference kinds (call/import/type_ref/extend/implement), and code context.";

  inputSchema = {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "The project ID to search in",
      },
      symbolName: {
        type: "string",
        description: "Name of the symbol to find references for",
      },
      fqn: {
        type: "string",
        description:
          "Fully-qualified name (e.g. 'services/search/rlm.ts#ContextualSearchRLM') to disambiguate when multiple definitions share the same name",
      },
      maxResults: {
        type: "number",
        description: "Maximum references to return (default: 50)",
        default: 50,
      },
    },
    required: ["projectId", "symbolName"],
  };

  async handle(params: unknown): Promise<ToolResponse> {
    const {
      projectId,
      symbolName,
      fqn,
      maxResults = 50,
    } = params as GetReferencesParams;

    try {
      const refs = await symbolGraphService.getReferences(projectId, symbolName, fqn);
      const limited = refs.slice(0, maxResults);

      // Group by file for readability
      const byFile = new Map<string, typeof limited>();
      for (const ref of limited) {
        const arr = byFile.get(ref.fromFile) ?? [];
        arr.push(ref);
        byFile.set(ref.fromFile, arr);
      }

      return {
        success: true,
        data: {
          symbolName,
          fqn: fqn ?? null,
          total: refs.length,
          shown: limited.length,
          references: limited.map((r) => ({
            fromFile: r.fromFile,
            fromLine: r.fromLine,
            refKind: r.refKind,
            context: r.context,
          })),
          byFile: Object.fromEntries(
            Array.from(byFile.entries()).map(([file, fileRefs]) => [
              file,
              fileRefs.map((r) => ({ line: r.fromLine, kind: r.refKind })),
            ]),
          ),
          projectId,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get references: ${(error as Error).message}`,
      };
    }
  }
}
