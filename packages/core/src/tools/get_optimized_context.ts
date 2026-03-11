/**
 * Get Optimized Context Tool
 *
 * Thin MCP tool layer — validates input and delegates to ContextController.
 * All business logic lives in controllers/context-controller.ts.
 */

import { IToolHandler, ToolResponse } from "@th0th-ai/shared";
import { logger } from "@th0th-ai/shared";
import { ContextController } from "../controllers/context-controller.js";

interface GetOptimizedContextParams {
  query: string;
  projectId: string;
  projectPath?: string;
  maxTokens?: number;
  maxResults?: number;
  workingMemoryBudget?: number;
  userId?: string;
  sessionId?: string;
  includeMemories?: boolean;
  memoryBudgetRatio?: number;
}

export class GetOptimizedContextTool implements IToolHandler {
  name = "get_optimized_context";
  description =
    "Retrieve code context + persistent memories with maximum token efficiency (search + memories + compress)";
  inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query to find relevant context",
      },
      projectId: {
        type: "string",
        description: "Project ID for code context",
      },
      projectPath: {
        type: "string",
        description: "Project path (for auto-reindex)",
      },
      maxTokens: {
        type: "number",
        description: "Maximum tokens in returned context",
        default: 4000,
      },
      maxResults: {
        type: "number",
        description: "Maximum search results to include",
        default: 5,
      },
      workingMemoryBudget: {
        type: "number",
        description:
          "Token budget for active working set before compression (defaults to 80% of maxTokens)",
      },
      userId: {
        type: "string",
        description: "User ID for memory search (filters memories by user)",
      },
      sessionId: {
        type: "string",
        description:
          "Session ID for memory search (includes current session memories)",
      },
      includeMemories: {
        type: "boolean",
        description:
          "Include persistent memories from previous sessions (default: true)",
        default: true,
      },
      memoryBudgetRatio: {
        type: "number",
        description:
          "Fraction of maxTokens allocated for memories (0-1, default: 0.2 = 20%)",
        default: 0.2,
      },
    },
    required: ["query", "projectId"],
  };

  private controller: ContextController;

  constructor() {
    this.controller = ContextController.getInstance();
  }

  async handle(params: unknown): Promise<ToolResponse> {
    const p = params as GetOptimizedContextParams;

    try {
      const result = await this.controller.getOptimizedContext(p);

      return {
        success: true,
        data: {
          context: result.context,
          sources: result.sources,
          resultsCount: result.resultsCount,
          memoriesCount: result.memoriesCount,
          sessionCacheHits: result.sessionCacheHits,
        },
        metadata: {
          tokensSaved: result.tokensSaved,
          compressionRatio: result.compressionRatio,
          tokensSavedBySessionCache: result.tokensSavedBySessionCache,
          cacheHit: result.sessionCacheHits > 0,
        } as any,
      };
    } catch (error) {
      logger.error("Failed to get optimized context", error as Error, {
        query: p.query,
        projectId: p.projectId,
      });

      return {
        success: false,
        error: `Failed to retrieve context: ${(error as Error).message}`,
      };
    }
  }
}
