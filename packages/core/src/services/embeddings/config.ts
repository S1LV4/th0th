/**
 * Embedding Provider Configuration
 *
 * Multi-provider configuration using Vercel AI SDK
 * Supports: OpenAI, Google, Cohere, Ollama (local), Mistral
 */

export interface EmbeddingProviderConfig {
  provider: "openai" | "google" | "cohere" | "ollama" | "mistral" | "vercel" | "custom" | "litellm" | string;
  model: string;
  apiKey?: string;
  baseURL?: string; // For Ollama local server
  dimensions?: number; // Auto-detect if not specified
  priority: number; // Lower = higher priority (1 = try first)
  timeout?: number; // milliseconds
  maxRetries?: number;
  maxChars?: number; // Max characters to send per text (model-specific context limit)
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

function getMaxChars(providerPrefix: string, model: string): number {
  const fromEnv =
    Number(process.env[`${providerPrefix}_EMBEDDING_MAX_CHARS`]) ||
    Number(process.env.EMBEDDING_MAX_CHARS);
  if (fromEnv) return fromEnv;

  const lower = model.toLowerCase();
  // Strip common namespace prefixes (e.g. "alibaba/qwen3-embedding-8b" → "qwen3-embedding-8b")
  const bare = lower.includes("/") ? lower.split("/").pop()! : lower;
  if (bare.startsWith("qwen3-embedding")) return 8000;
  if (bare.startsWith("bge-m3")) return 4000;
  if (bare.startsWith("text-embedding-3")) return 8000;
  if (bare.startsWith("gemini-embedding")) return 8000;
  if (bare.startsWith("mistral-embed") || bare.startsWith("codestral-embed")) return 8000;
  if (bare.startsWith("embed-v-4")) return 500000; 
  return 4000;
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

  google: (() => {
    const model = process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
    return {
      provider: "google",
      model,
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY,
      dimensions: 3072,
      priority: process.env.EMBEDDING_PROVIDER === "google" ? 1 : 10,
      timeout: 60000,
      maxRetries: 3,
      maxChars: getMaxChars("GOOGLE", model),
      rateLimits: getRateLimits("GOOGLE"),
    };
  })(),

  vercel: (() => {
    const model = process.env.VERCEL_EMBEDDING_MODEL || "alibaba/qwen3-embedding-8b";
    return {
      provider: "vercel",
      model,
      apiKey: process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_API_KEY,
      baseURL: process.env.VERCEL_AI_GATEWAY_URL,
      dimensions: Number(process.env.VERCEL_EMBEDDING_DIMENSIONS || "4096"),
      priority: process.env.EMBEDDING_PROVIDER === "vercel" ? 1 : 20,
      timeout: 60000,
      maxRetries: 3,
      maxChars: getMaxChars("VERCEL", model),
      rateLimits: getRateLimits("VERCEL"),
    };
  })(),

  ollama: (() => {
    const model = process.env.OLLAMA_EMBEDDING_MODEL || "bge-m3";
    return {
      provider: "ollama",
      model,
      baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      dimensions: Number(process.env.OLLAMA_EMBEDDING_DIMENSIONS || "1024"),
      priority: process.env.EMBEDDING_PROVIDER === "ollama" || !process.env.EMBEDDING_PROVIDER ? 1 : 50, // Highest priority by default
      timeout: 300000, // 5 minutes (local can be slow on first run)
      maxRetries: 2,
      maxChars: getMaxChars("OLLAMA", model),
      rateLimits: getRateLimits("OLLAMA"),
    };
  })(),

  mistralText: (() => {
    const model = process.env.MISTRAL_TEXT_EMBEDDING_MODEL || "mistral-embed";
    return {
      provider: "mistral",
      model,
      apiKey: process.env.MISTRAL_API_KEY,
      dimensions: 1024,
      priority: process.env.EMBEDDING_PROVIDER === "mistral" ? 1 : 2, // Fallback to Mistral if Ollama is unavailable
      timeout: 60000,
      maxRetries: 3,
      maxChars: getMaxChars("MISTRAL", model),
      rateLimits: getRateLimits("MISTRAL"),
    };
  })(),

  mistralCode: (() => {
    const model = process.env.MISTRAL_CODE_EMBEDDING_MODEL || "codestral-embed";
    return {
      provider: "mistral",
      model,
      apiKey: process.env.MISTRAL_API_KEY,
      dimensions: 1536, // Default, can go up to 3072
      priority: process.env.EMBEDDING_PROVIDER === "mistral" ? 1 : 3,
      timeout: 60000,
      maxRetries: 3,
      maxChars: getMaxChars("MISTRAL", model),
      rateLimits: getRateLimits("MISTRAL"),
    };
  })(),
  litellm: (() => {
    const model = process.env.LITELLM_EMBEDDING_MODEL || "embed-v-4-0";
    return {
      provider: "litellm",
      model,
      apiKey: process.env.LITELLM_API_KEY,
      baseURL: process.env.LITELLM_BASE_URL,
      dimensions: Number(process.env.LITELLM_EMBEDDING_DIMENSIONS || "1024"),
      priority: process.env.EMBEDDING_PROVIDER === "litellm" ? 1 : 15,
      timeout: Number(process.env.LITELLM_EMBEDDING_TIMEOUT || "60000"),
      maxRetries: 3,
      maxChars: getMaxChars("LITELLM", model),
      rateLimits: getRateLimits("LITELLM"),
    };
  })(),

  custom: (() => {
    const model = process.env.CUSTOM_EMBEDDING_MODEL || "text-embedding-3-small";
    return {
      provider: "custom",
      model,
      apiKey: process.env.CUSTOM_API_KEY,
      baseURL: process.env.CUSTOM_EMBEDDING_BASE_URL,
      dimensions: Number(process.env.CUSTOM_EMBEDDING_DIMENSIONS || "1536"),
      priority: process.env.EMBEDDING_PROVIDER === "custom" ? 1 : 100,
      timeout: Number(process.env.CUSTOM_EMBEDDING_TIMEOUT || "60000"),
      maxRetries: 3,
      maxChars: getMaxChars("CUSTOM", model),
      rateLimits: getRateLimits("CUSTOM"),
    };
  })(),

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

  // Vercel AI Gateway — requires AI_GATEWAY_API_KEY
  if (config.provider === "vercel") {
    return !!config.apiKey;
  }

  // LiteLLM proxy — requires baseURL at minimum (API key optional)
  if (config.provider === "litellm") {
    return !!config.baseURL;
  }

  // Custom OpenAI-compatible provider — requires baseURL at minimum
  if (config.provider === "custom") {
    return !!config.baseURL;
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
