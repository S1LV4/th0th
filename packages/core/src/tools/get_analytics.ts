/**
 * Get Analytics Tool
 *
 * Retrieves search analytics and performance metrics
 */

import { IToolHandler } from "@th0th-ai/shared";
import { ToolResponse } from "@th0th-ai/shared";
import { getSearchAnalytics } from "../services/search/analytics-factory.js";
import { logger } from "@th0th-ai/shared";

interface GetAnalyticsParams {
  type: "summary" | "project" | "query" | "cache" | "recent";
  projectId?: string;
  query?: string;
  limit?: number;
}

export class GetAnalyticsTool implements IToolHandler {
  name = "get_analytics";
  description =
    "Get search analytics and performance metrics (usage patterns, cache performance, etc)";
  inputSchema = {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["summary", "project", "query", "cache", "recent"],
        description:
          "Type of analytics: 'summary' (overall), 'project' (specific project), 'query' (specific query), 'cache' (cache performance), 'recent' (recent searches)",
      },
      projectId: {
        type: "string",
        description: "Project ID (required for type='project' or 'cache')",
      },
      query: {
        type: "string",
        description: "Search query (required for type='query')",
      },
      limit: {
        type: "number",
        description: "Limit for results (default: 10 for most, 50 for recent)",
        default: 10,
      },
    },
    required: ["type"],
  };

  constructor() {}

  async handle(params: unknown): Promise<ToolResponse> {
    const { type, projectId, query, limit = 10 } = params as GetAnalyticsParams;

    try {
      const analytics = getSearchAnalytics();

      logger.info("Getting analytics", { type, projectId, query });

      let data: any;

      switch (type) {
        case "summary":
          data = await analytics.getSummary(limit);
          break;

        case "project":
          if (!projectId) {
            return {
              success: false,
              error: "projectId is required for type='project'",
            };
          }
          data = await analytics.getProjectStats(projectId, limit);
          if (!data) {
            return {
              success: false,
              error: `No analytics found for project: ${projectId}`,
            };
          }
          break;

        case "query":
          if (!query) {
            return {
              success: false,
              error: "query is required for type='query'",
            };
          }
          data = await analytics.getQueryStats(query, projectId);
          if (!data) {
            return {
              success: false,
              error: `No analytics found for query: ${query}`,
            };
          }
          break;

        case "cache":
          data = await analytics.getCachePerformance(projectId);
          break;

        case "recent": {
          const recentLimit = limit || 50;
          data = await analytics.getRecentSearches(recentLimit, projectId);
          break;
        }

        default:
          return {
            success: false,
            error: `Invalid analytics type: ${type}`,
          };
      }

      logger.info("Analytics retrieved", {
        type,
        dataSize: JSON.stringify(data).length,
      });

      return {
        success: true,
        data: {
          type,
          ...(projectId && { projectId }),
          ...(query && { query }),
          result: data,
        },
      };
    } catch (error) {
      logger.error("Failed to get analytics", error as Error, {
        type,
        projectId,
        query,
      });

      return {
        success: false,
        error: `Failed to get analytics: ${(error as Error).message}`,
      };
    }
  }
}
