/**
 * Configuration Management
 *
 * Centralized configuration for th0th Server
 *
 * Architecture:
 * - Global cache with projectId namespace (multi-tenant)
 * - All data isolated by project_id in the same SQLite database
 * - Optimized for multiple projects with embedding reuse
 */

// Load environment variables FIRST before any config
import "../env.js";

import path from "path";
import os from "os";

export interface ServerConfig {
  // Server Info
  name: string;
  version: string;

  // Data Directory (global cache location)
  dataDir: string;

  // Cache Configuration (multi-tenant with projectId namespace)
  cache: {
    l1: {
      maxSize: number; // bytes
      defaultTTL: number; // seconds
    };
    l2: {
      dbPath: string;
      maxSize: number;
      defaultTTL: number;
    };
    embedding: {
      dbPath: string;
      maxAgeHours: number;
    };
  };

  // Vector Store Configuration (SQLite-based com embeddings)
  vectorStore: {
    type: "sqlite";
    dbPath: string;
    collectionName: string;
    embeddingModel?: string;
  };

  // Keyword Search Configuration
  keywordSearch: {
    dbPath: string;
    ftsVersion: "fts5";
  };

  // Compression Configuration
  compression: {
    defaultStrategy: string;
    minTokensForCompression: number;
    targetCompressionRatio: number; // 0-1
    llm: {
      enabled: boolean;
      baseUrl: string;
      apiKey: string;
      model: string;
      temperature: number;
      maxOutputTokens: number;
      timeoutMs: number;
      prompt?: string;
    };
  };

  // Rate Limiting
  rateLimit: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };

  // Security
  security: {
    maxInputLength: number;
    sanitizeInputs: boolean;
    maxFileSize: number;
    maxIndexSize: number;
    allowedExtensions: string[];
    excludePatterns: string[];
  };

  // Logging
  logging: {
    level: "debug" | "info" | "warn" | "error";
    enableMetrics: boolean;
  };
}

/**
 * Get global data directory
 * Creates ~/.rlm/ directory for all projects
 */
function getGlobalDataDir(): string {
  const homeDir = os.homedir();
  const dataDir = path.join(homeDir, ".rlm");
  return dataDir;
}

/**
 * Default Configuration
 */
export const defaultConfig: ServerConfig = {
  name: "th0th-server",
  version: "1.0.0",

  dataDir: getGlobalDataDir(),

  cache: {
    l1: {
      maxSize: Number(process.env.L1_CACHE_MAX_SIZE) || 100 * 1024 * 1024,
      defaultTTL: Number(process.env.L1_CACHE_TTL) || 300,
    },
    l2: {
      dbPath: process.env.CACHE_DB_PATH || path.join(getGlobalDataDir(), "cache.db"),
      maxSize: Number(process.env.L2_CACHE_MAX_SIZE) || 500 * 1024 * 1024,
      defaultTTL: Number(process.env.L2_CACHE_TTL) || 3600,
    },
    embedding: {
      dbPath: process.env.EMBEDDING_CACHE_DB_PATH || path.join(getGlobalDataDir(), "embedding-cache.db"),
      maxAgeHours: 168, // 7 days
    },
  },

  vectorStore: {
    type: "sqlite",
    dbPath: path.join(getGlobalDataDir(), "vector-store.db"),
    collectionName: "rlm_memories",
    embeddingModel: "default",
  },

  keywordSearch: {
    dbPath: path.join(getGlobalDataDir(), "keyword-search.db"),
    ftsVersion: "fts5",
  },

  compression: {
    defaultStrategy: "code_structure",
    minTokensForCompression: Number(process.env.MIN_TOKENS_FOR_COMPRESSION) || 100,
    targetCompressionRatio: Number(process.env.TARGET_COMPRESSION_RATIO) || 0.7,
    llm: {
      enabled: process.env.RLM_LLM_ENABLED === "true",
      baseUrl: process.env.RLM_LLM_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.RLM_LLM_API_KEY || "",
      model: process.env.RLM_LLM_MODEL || "gpt-4o-mini",
      temperature: Number(process.env.RLM_LLM_TEMPERATURE || "0.2"),
      maxOutputTokens: Number(process.env.RLM_LLM_MAX_OUTPUT_TOKENS || "800"),
      timeoutMs: Number(process.env.RLM_LLM_TIMEOUT_MS || "20000"),
      prompt: process.env.RLM_LLM_PROMPT || undefined,
    },
  },

  rateLimit: {
    requestsPerMinute: Number(process.env.REQUESTS_PER_MINUTE) || 60,
    tokensPerMinute: Number(process.env.TOKENS_PER_MINUTE) || 100000,
  },

  security: {
    maxInputLength: Number(process.env.MAX_INPUT_LENGTH) || 100000,
    sanitizeInputs: process.env.SANITIZE_INPUTS !== "false",
    maxIndexSize: 100000, // max files to index
    maxFileSize: 1024 * 1024, // 1MB per file
    allowedExtensions: [
      ".ts",
      ".js",
      ".tsx",
      ".jsx",
      ".dart",
      ".py",
      ".java",
      ".go",
      ".rs",
      ".cpp",
      ".c",
      ".h",
      ".md",
      ".json",
      ".yaml",
      ".yml",
    ],
    excludePatterns: [
      "node_modules/**",
      ".git/**",
      "dist/**",
      "build/**",
      ".next/**",
      "coverage/**",
      "**/generated/**",
      "*.min.js",
      "*.min.css",
    ],
  },

  logging: {
    level: (process.env.LOG_LEVEL as any) || "info",
    enableMetrics: process.env.ENABLE_METRICS === "true",
  },
};

/**
 * Configuration Manager
 */
export class Config {
  private config: ServerConfig;

  constructor(overrides?: Partial<ServerConfig>) {
    this.config = this.mergeConfig(defaultConfig, overrides);
    this.validate();
  }

  /**
   * Merge default config with overrides
   */
  private mergeConfig(
    defaults: ServerConfig,
    overrides?: Partial<ServerConfig>,
  ): ServerConfig {
    if (!overrides) return defaults;

    return {
      ...defaults,
      ...overrides,
      cache: {
        l1: { ...defaults.cache.l1, ...overrides.cache?.l1 },
        l2: { ...defaults.cache.l2, ...overrides.cache?.l2 },
        embedding: {
          ...defaults.cache.embedding,
          ...overrides.cache?.embedding,
        },
      },
      vectorStore: { ...defaults.vectorStore, ...overrides.vectorStore },
      keywordSearch: { ...defaults.keywordSearch, ...overrides.keywordSearch },
      compression: {
        ...defaults.compression,
        ...overrides.compression,
        llm: { ...defaults.compression.llm, ...overrides.compression?.llm },
      },
      rateLimit: { ...defaults.rateLimit, ...overrides.rateLimit },
      security: { ...defaults.security, ...overrides.security },
      logging: { ...defaults.logging, ...overrides.logging },
    };
  }

  /**
   * Validate configuration
   */
  private validate(): void {
    if (
      this.config.compression.targetCompressionRatio < 0 ||
      this.config.compression.targetCompressionRatio > 1
    ) {
      throw new Error("targetCompressionRatio must be between 0 and 1");
    }
  }

  /**
   * Get configuration value
   */
  get<K extends keyof ServerConfig>(key: K): ServerConfig[K] {
    return this.config[key];
  }

  /**
   * Get nested configuration value
   */
  getNested(path: string): any {
    return path.split(".").reduce((obj: any, key) => obj?.[key], this.config);
  }

  /**
   * Get all configuration
   */
  getAll(): ServerConfig {
    return { ...this.config };
  }

  /**
   * Update configuration (runtime)
   */
  set<K extends keyof ServerConfig>(key: K, value: ServerConfig[K]): void {
    this.config[key] = value;
  }
}

/**
 * Global config instance
 */
export const config = new Config();

export {
  Th0thConfig,
  defaultTh0thConfig,
  configExamples,
} from "./th0th-config";

export {
  getConfigDir,
  getConfigPath,
  configExists,
  loadConfig,
  saveConfig,
  initConfig,
  getConfigForEnv,
} from "./config-loader";
