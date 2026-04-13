/**
 * Embedding Provider Configuration
 *
 * Multi-provider configuration using Vercel AI SDK
 * Supports: OpenAI, Google, Cohere, Ollama (local), Mistral
 */

export interface EmbeddingProviderConfig {
  provider: "openai" | "google" | "cohere" | "ollama" | "mistral" | string; // Allow custom providers
  model: string;
  apiKey?: string;
  baseURL?: string; // For Ollama local server
  dimensions?: number; // Auto-detect if not specified
  priority: number; // Lower = higher priority (1 = try first)
  timeout?: number; // milliseconds
  maxRetries?: number;
  rateLimits?: {
    requestsPerMinute?: number; // RPM limit
    tokensPerMinute?: number; // TPM limit (approximate)
    requestsPerDay?: number; // RPD limit
    batchSize?: number; // Max texts per batch
    batchDelayMs?: number; // Delay between batches
  };
}

/**
 * Get rate limits from environment variables for a provider
 * 
 * Supports provider-specific env vars:
 * - {PROVIDER}_EMBEDDING_RPM - Requests per minute
 * - {PROVIDER}_EMBEDDING_TPM - Tokens per minute  
 * - {PROVIDER}_EMBEDDING_RPD - Requests per day
 * - {PROVIDER}_EMBEDDING_BATCH_SIZE - Max texts per batch
 * - {PROVIDER}_EMBEDDING_BATCH_DELAY - Delay between batches (ms)
 * 
 * Falls back to generic EMBEDDING_* vars if provider-specific not set
 */
function getRateLimits(providerPrefix: string): EmbeddingProviderConfig['rateLimits'] {
  const rpm = Number(process.env[`${providerPrefix}_EMBEDDING_RPM`]) || 
              Number(process.env.EMBEDDING_RPM);
  const tpm = Number(process.env[`${providerPrefix}_EMBEDDING_TPM`]) || 
              Number(process.env.EMBEDDING_TPM);
  const rpd = Number(process.env[`${providerPrefix}_EMBEDDING_RPD`]) || 
              Number(process.env.EMBEDDING_RPD);
  const batchSize = Number(process.env[`${providerPrefix}_EMBEDDING_BATCH_SIZE`]) || 
                    Number(process.env.EMBEDDING_BATCH_SIZE);
  const batchDelayMs = Number(process.env[`${providerPrefix}_EMBEDDING_BATCH_DELAY`]) || 
                       Number(process.env.EMBEDDING_BATCH_DELAY);

  // Only return rateLimits if at least one value is configured
  if (!rpm && !tpm && !rpd && !batchSize && !batchDelayMs) {
    return undefined;
  }

  return {
    requestsPerMinute: rpm || undefined,
    tokensPerMinute: tpm || undefined,
    requestsPerDay: rpd || undefined,
    batchSize: batchSize || undefined,
    batchDelayMs: batchDelayMs || undefined,
  };
}

/**
 * Provider configurations sorted by priority
 *
 * Priority order (default):
 * 1. Ollama (local, low latency) - ENABLED
 * 2. Mistral Text (general purpose, good quality) - ENABLED
 * 3. Mistral Code (specialized for code) - ENABLED
 * 4. Google (API key required) - ENABLED if GOOGLE_API_KEY is set
 * 
 * Override with EMBEDDING_PROVIDER env var:
 * - EMBEDDING_PROVIDER=google - Force Google
 * - EMBEDDING_PROVIDER=ollama - Force Ollama
 * - EMBEDDING_PROVIDER=mistral - Force Mistral
 * 
 * Rate Limiting (all providers):
 * Set provider-specific vars (e.g., GOOGLE_EMBEDDING_RPM) or generic vars (e.g., EMBEDDING_RPM)
 * 
 * DISABLED (no API keys configured):
 * - OpenAI (no API key)
 * - Cohere (no API key)
 */
export const embeddingProviders: Record<string, EmbeddingProviderConfig> = {
  // === ENABLED PROVIDERS ===

  google: {
    provider: "google",
    model: process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001",
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY,
    dimensions: 3072,
    priority: process.env.EMBEDDING_PROVIDER === "google" ? 1 : 10,
    timeout: 60000,
    maxRetries: 3,
    rateLimits: getRateLimits("GOOGLE"),
  },
  
  ollama: {
    provider: "ollama",
    model: process.env.OLLAMA_EMBEDDING_MODEL || "bge-m3",
    baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    dimensions: Number(process.env.OLLAMA_EMBEDDING_DIMENSIONS || "1024"),
    priority: process.env.EMBEDDING_PROVIDER === "ollama" || !process.env.EMBEDDING_PROVIDER ? 1 : 50, // Highest priority by default
    timeout: 300000, // 5 minutes (local can be slow on first run)
    maxRetries: 2,
    rateLimits: getRateLimits("OLLAMA"),
  },
  
  mistralText: {
    provider: "mistral",
    model: process.env.MISTRAL_TEXT_EMBEDDING_MODEL || "mistral-embed",
    apiKey: process.env.MISTRAL_API_KEY,
    dimensions: 1024,
    priority: process.env.EMBEDDING_PROVIDER === "mistral" ? 1 : 2, // Fallback to Mistral if Ollama is unavailable
    timeout: 60000,
    maxRetries: 3,
    rateLimits: getRateLimits("MISTRAL"),
  },

  mistralCode: {
    provider: "mistral",
    model: process.env.MISTRAL_CODE_EMBEDDING_MODEL || "codestral-embed",
    apiKey: process.env.MISTRAL_API_KEY,
    dimensions: 1536, // Default, can go up to 3072
    priority: process.env.EMBEDDING_PROVIDER === "mistral" ? 1 : 3,
    timeout: 60000,
    maxRetries: 3,
    rateLimits: getRateLimits("MISTRAL"),
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
