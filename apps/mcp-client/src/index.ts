#!/usr/bin/env node
/**
 * th0th MCP Client
 *
 * Cliente MCP que se conecta ao OpenCode via stdio
 * e faz proxy das tool calls para a Tools API via HTTP.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import { ApiClient } from "./api-client.js";
import { collectFiles } from "./file-collector.js";
import { TOOL_DEFINITIONS, getToolDefinition } from "./tool-definitions.js";
import {
  configExists,
  initConfig,
  loadConfig,
  getConfigPath,
  getConfigDir
} from "@th0th-ai/shared/config";

// Check for config-related flags before starting MCP server
const args = process.argv.slice(2);

if (args.includes("--config-show")) {
  try {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  } catch (error) {
    console.error("Error loading config:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (args.includes("--config-path")) {
  console.log(getConfigPath());
  process.exit(0);
}

if (args.includes("--config-dir")) {
  console.log(getConfigDir());
  process.exit(0);
}

if (args.includes("--config-init")) {
  try {
    initConfig();
    console.log(`Configuration initialized at: ${getConfigPath()}`);
    process.exit(0);
  } catch (error) {
    console.error("Error initializing config:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
th0th MCP Client

Usage:
  npx @th0th-ai/mcp-client [options]

Options:
  --config-show     Show current configuration
  --config-path     Show config file path
  --config-dir      Show config directory path
  --config-init     Initialize configuration
  --help, -h        Show this help message

For advanced configuration, use the config CLI:
  npx @th0th-ai/mcp-client th0th-config <command>

Examples:
  npx @th0th-ai/mcp-client --config-show
  npx @th0th-ai/mcp-client --config-path
`);
  process.exit(0);
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Auto-configure on first run
if (!configExists()) {
  initConfig();
  console.error(`
[th0th] Initialized with default configuration
[th0th] Config: ~/.config/th0th/config.json
[th0th] Provider: Ollama (local, free)
[th0th] To change: npx @th0th-ai/mcp-client th0th-config use mistral --api-key YOUR_KEY
`);
}

class McpProxyServer {
  private server: Server;
  private transport: StdioServerTransport;
  private apiClient: ApiClient;

  constructor() {
    this.server = new Server(
      {
        name: "th0th",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.transport = new StdioServerTransport();
    this.apiClient = new ApiClient();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List tools - return all tool definitions
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: TOOL_DEFINITIONS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    // Handle tool calls - proxy to Tools API
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === "th0th_index") {
          return await this.handleIndexTool((args ?? {}) as Record<string, unknown>);
        }

        const toolDef = getToolDefinition(name);
        if (!toolDef) {
          throw new Error(`Unknown tool: ${name}`);
        }

        // Proxy to API
        let response;
        if (toolDef.apiMethod === "GET") {
          // For GET requests: replace :pathParam placeholders, rest go as query params
          let endpoint = toolDef.apiEndpoint;
          const params = (args ?? {}) as Record<string, unknown>;
          const queryParams: Record<string, unknown> = {};

          for (const [key, value] of Object.entries(params)) {
            if (endpoint.includes(`:${key}`)) {
              // Path parameter
              endpoint = endpoint.replace(`:${key}`, encodeURIComponent(String(value)));
            } else {
              // Query parameter
              queryParams[key] = value;
            }
          }

          response = await this.apiClient.get(endpoint, queryParams);
        } else {
          // POST request with body
          response = await this.apiClient.post(toolDef.apiEndpoint, args);
        }

        // Format response for MCP
        const responseData = response as any;

        // If response has TOON format string in data, return directly
        if (responseData?.success && typeof responseData?.data === "string") {
          return {
            content: [
              {
                type: "text" as const,
                text: responseData.data,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    });
  }

  private async handleIndexTool(
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const projectPath = args.projectPath as string | undefined;

    if (!projectPath) {
      return textContent(JSON.stringify({ success: false, error: "projectPath is required" }));
    }

    try {
      if (!(await fs.stat(projectPath)).isDirectory()) {
        return textContent(JSON.stringify({ success: false, error: `${projectPath} is not a directory` }));
      }
    } catch {
      return textContent(JSON.stringify({ success: false, error: `Path not found: ${projectPath}` }));
    }

    console.error(`[th0th-mcp] Collecting files from ${projectPath}...`);
    const files = await collectFiles(projectPath);

    if (files.length === 0) {
      return textContent(JSON.stringify({
        success: false,
        error: `No indexable files found in ${projectPath}`,
      }));
    }

    console.error(`[th0th-mcp] Uploading ${files.length} files to remote API...`);

    const response = await this.apiClient.uploadAndIndex({
      projectPath,
      projectId: args.projectId as string | undefined,
      forceReindex: args.forceReindex as boolean | undefined,
      warmCache: args.warmCache as boolean | undefined,
      warmupQueries: args.warmupQueries as string[] | undefined,
      files,
    });

    return textContent(JSON.stringify(response, null, 2));
  }

  async start(): Promise<void> {
    // Check API health before starting
    const healthy = await this.apiClient.healthCheck();
    if (!healthy) {
      console.error(
        "[th0th-mcp] Warning: Tools API is not reachable. Requests will fail until API is available.",
      );
    }

    await this.server.connect(this.transport);
    console.error("[th0th-mcp] MCP Client running on stdio");
    console.error(
      `[th0th-mcp] Proxying to: ${process.env.TH0TH_API_URL || "http://localhost:3333"}`,
    );
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}

// Main
const client = new McpProxyServer();

client.start().catch((error) => {
  console.error("Failed to start MCP client:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await client.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await client.close();
  process.exit(0);
});
