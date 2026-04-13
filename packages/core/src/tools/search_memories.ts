/**
 * Search Memories Tool
 *
 * Thin MCP tool layer — validates input and delegates to MemoryController.
 * All business logic lives in controllers/memory-controller.ts.
 */

import { IToolHandler, ToolResponse, MemoryType } from "@th0th-ai/shared";
import { logger } from "@th0th-ai/shared";
import { encode as toTOON } from "@toon-format/toon";
import { MemoryController } from "../controllers/memory-controller.js";

interface SearchMemoriesParams {
  query: string;
  userId?: string;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
  types?: MemoryType[];
  minImportance?: number;
  limit?: number;
  includePersistent?: boolean;
  includeRelated?: boolean;
  format?: "json" | "toon";
}

export class SearchMemoriesTool implements IToolHandler {
  name = "search_memories";
  description =
    "Search stored memories across sessions using semantic search (recovers context from previous conversations)";
  inputSchema = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (what to remember)" },
      userId: { type: "string", description: "Filter by user ID" },
      sessionId: { type: "string", description: "Filter by session ID" },
      projectId: { type: "string", description: "Filter by project ID" },
      agentId: {
        type: "string",
        description: "Filter by agent ID (orchestrator, implementer, architect, optimizer)",
      },
      types: {
        type: "array",
        items: {
          type: "string",
          enum: ["critical", "conversation", "code", "decision", "pattern"],
        },
        description: "Filter by memory types",
      },
      minImportance: {
        type: "number",
        description: "Minimum importance (0-1)",
        default: 0.3,
      },
      limit: {
        type: "number",
        description: "Maximum results to return",
        default: 10,
      },
      includePersistent: {
        type: "boolean",
        description: "Include persistent memories from other sessions",
        default: true,
      },
      includeRelated: {
        type: "boolean",
        description: "Expand results with graph-related memories (follows knowledge graph edges)",
        default: false,
      },
      format: {
        type: "string",
        enum: ["json", "toon"],
        description: "Output format (json or toon)",
        default: "toon",
      },
    },
    required: ["query"],
  };

  private controller: MemoryController;

  constructor() {
    this.controller = MemoryController.getInstance();
  }

  async handle(params: unknown): Promise<ToolResponse> {
    const {
      query,
      userId,
      sessionId,
      projectId,
      agentId,
      types,
      minImportance,
      limit,
      includePersistent,
      includeRelated,
      format = "toon",
    } = params as SearchMemoriesParams;

    try {
      const result = await this.controller.search({
        query,
        userId,
        sessionId,
        projectId,
        agentId,
        types,
        minImportance,
        limit,
        includePersistent,
        includeRelated,
      });

      const responseData = {
        memories: result.memories.map((m) => ({
          id: m.id,
          content: m.content,
          type: m.type,
          level: m.level,
          agentId: m.agentId,
          importance: m.importance,
          tags: m.tags,
          score: m.score,
          createdAt: new Date(m.createdAt).toISOString(),
          accessCount: m.accessCount,
          ...(result.relatedSummaries[m.id]
            ? { relatedContext: result.relatedSummaries[m.id] }
            : {}),
        })),
        query: result.query,
        total: result.total,
      };

      return format === "toon"
        ? { success: true, data: toTOON(responseData) }
        : { success: true, data: responseData };
    } catch (error) {
      logger.error("Failed to search memories", error as Error, { query });
      return {
        success: false,
        error: `Failed to search memories: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
