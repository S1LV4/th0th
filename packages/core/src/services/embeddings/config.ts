/**
 * Embedding Provider Configuration
 *
 * Multi-provider configuration using Vercel AI SDK
 * Supports: OpenAI, Google, Cohere, Ollama (local), Mistral
 */

export interface EmbeddingProviderConfig {
  provider: "openai" | "google" | "cohere" | "ollama" | "mistral";
  model: string;
  apiKey?: string;
  baseURL?: string; // For Ollama local server
  dimensions?: number; // Auto-detect if not specified
  priority: number; // Lower = higher priority (1 = try first)
  timeout?: number; // milliseconds
  maxRetries?: number;
}

/**
 * Provider configurations sorted by priority
 *
 * Priority order:
 * 1. Ollama (local, low latency) - ENABLED
 * 2. Mistral Text (general purpose, good quality) - ENABLED
 * 3. Mistral Code (specialized for code) - ENABLED
 * 
 * DISABLED (no API keys configured):
 * - OpenAI (no API key)
 * - Google (no API key)
 * - Cohere (no API key)
 */
export const embeddingProviders: Record<string, EmbeddingProviderConfig> = {
  // === ENABLED PROVIDERS ===
  
  ollama: {
    provider: "ollama",
    model: process.env.OLLAMA_EMBEDDING_MODEL || "bge-m3",
    baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    dimensions: Number(process.env.OLLAMA_EMBEDDING_DIMENSIONS || "1024"),
    priority: 1, // Highest priority (local, fast, free)
    timeout: 300000, // 5 minutes (local can be slow on first run)
    maxRetries: 2,
  },
  
  mistralText: {
    provider: "mistral",
    model: process.env.MISTRAL_TEXT_EMBEDDING_MODEL || "mistral-embed",
    apiKey: process.env.MISTRAL_API_KEY,
    dimensions: 1024,
    priority: 2, // Fallback to Mistral if Ollama is unavailable
    timeout: 60000,
    maxRetries: 3,
  },

  mistralCode: {
    provider: "mistral",
    model: process.env.MISTRAL_CODE_EMBEDDING_MODEL || "codestral-embed",
    apiKey: process.env.MISTRAL_API_KEY,
    dimensions: 1536, // Default, can go up to 3072
    priority: 3,
    timeout: 60000,
    maxRetries: 3,
  },

  // === DISABLED PROVIDERS (uncomment and configure to enable) ===
  
  /*

  openai: {
    provider: "openai",
    model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    apiKey: process.env.OPENAI_API_KEY,
    dimensions: 1536,
    priority: 10,
    timeout: 60000, // 60 seconds
    maxRetries: 3,
  },

  google: {
    provider: "google",
    model: process.env.GOOGLE_EMBEDDING_MODEL || "text-embedding-004",
    apiKey: process.env.GOOGLE_API_KEY,
    dimensions: 768,
    priority: 10,
    timeout: 60000,
    maxRetries: 3,
  },

  cohere: {
    provider: "cohere",
    model: process.env.COHERE_EMBEDDING_MODEL || "embed-english-v3.0",
    apiKey: process.env.COHERE_API_KEY,
    dimensions: 1024,
    priority: 10,
    timeout: 60000,
    maxRetries: 3,
  },
  */
};

/**
 * Get providers sorted by priority
 */
export function getProvidersByPriority(): Array<
  [string, EmbeddingProviderConfig]
> {
  return Object.entries(embeddingProviders).sort(
    ([, a], [, b]) => a.priority - b.priority,
  );
}

/**
 * Check if provider has required API key or is a local provider
 */
export function hasApiKey(providerName: string): boolean {
  const config = embeddingProviders[providerName];
  
  if (!config) {
    return false;
  }

  // Ollama doesn't need an API key (local)
  if (config.provider === "ollama") {
    return true;
  }

  // Mistral requires API key
  if (config.provider === "mistral") {
    return !!config.apiKey;
  }

  // All other providers need API keys
  return !!config.apiKey;
}

/**
 * Retry configuration (OpenClaw pattern)
 */
export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 500,
  MAX_DELAY_MS: 8000,
  BACKOFF_MULTIPLIER: 2,
};

/**
 * Batching configuration (OpenClaw pattern)
 */
export const BATCH_CONFIG = {
  MAX_TOKENS: 8000,
  APPROX_CHARS_PER_TOKEN: 4,
  CONCURRENCY: 4,
};
