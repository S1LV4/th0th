/**
 * Embedding Provider Factory with Auto-Fallback
 *
 * Main entry point for creating embedding providers with:
 * - Automatic provider selection based on availability
 * - Fallback chain: Mistral Text → Mistral Code
 * - Optional transparent caching
 * - Health checking before usage
 *
 * Usage:
 * ```typescript
 * // Auto-select first available provider with cache
 * const provider = await createEmbeddingProvider({ cache: true });
 *
 * // Specific provider with cache
 * const provider = await createEmbeddingProvider({
 *   provider: 'mistralText',
 *   cache: true
 * });
 *
 * // Use provider
 * const embedding = await provider.embedQuery("Hello world");
 * const embeddings = await provider.embedBatch(["Hello", "World"]);
 * ```
 */

import { EmbeddingProvider, createProvider } from "./provider.js";
import { CachedEmbeddingProvider, withCache } from "./cached-provider.js";
import { EmbeddingCache } from "../cache/embedding-cache.js";
import {
  embeddingProviders,
  getProvidersByPriority,
  hasApiKey,
  type EmbeddingProviderConfig,
} from "./config.js";
import { logger } from "@th0th-ai/shared";

/**
 * Options for creating an embedding provider
 */
export interface CreateProviderOptions {
  /**
   * Provider to use:
   * - 'auto': Try providers by priority until one works (Ollama first)
   * - 'ollama': Ollama local embeddings (768D, free, local-first)
   * - 'mistralText': Mistral text embeddings (1024D)
   * - 'mistralCode': Mistral code embeddings (1536D)
   *
   * Default: 'auto'
   */
  provider?: "auto" | "ollama" | "mistralText" | "mistralCode";

  /**
   * Enable transparent caching using SHA-256 content hashing
   *
   * Benefits:
   * - 0.09ms cache hit latency
   * - Reduce API calls by 60-80%
   * - Automatic cleanup of old entries
   *
   * Default: true
   */
  cache?: boolean;

  /**
   * Custom cache instance (optional)
   * If not provided, a new cache will be created with default settings
   */
  cacheInstance?: EmbeddingCache;

  /**
   * Skip health check before returning provider
   * Useful for testing or when you know provider is available
   *
   * Default: false
   */
  skipHealthCheck?: boolean;
}

/**
 * Try to create a provider from configuration
 * Returns null if provider is not available or configured
 */
async function tryCreateProvider(
  config: EmbeddingProviderConfig,
  providerId: string,
  skipHealthCheck: boolean,
): Promise<EmbeddingProvider | null> {
  // Check if API key is available (if needed)
  if (!hasApiKey(providerId)) {
    logger.debug(`[${providerId}] Skipping: No API key configured`);
    return null;
  }

  // Create provider
  const provider = createProvider(config, providerId);

  // Health check
  if (!skipHealthCheck) {
    const available = await provider.isAvailable();
    if (!available) {
      logger.debug(`[${providerId}] Health check failed`);
      return null;
    }
  }

  logger.info(
    `[${providerId}] Provider ready (model: ${config.model}, dimensions: ${config.dimensions})`,
  );
  return provider;
}

/**
 * Create embedding provider with auto-fallback
 *
 * Auto mode:
 * Tries providers in priority order until one succeeds:
 * 1. Mistral Text (general purpose embeddings)
 * 2. Mistral Code (code-specialized embeddings)
 *
 * Specific provider mode:
 * Creates the requested provider or throws if unavailable
 */
export async function createEmbeddingProvider(
  options: CreateProviderOptions = {},
): Promise<EmbeddingProvider> {
  const {
    provider: requestedProvider = "auto",
    cache: enableCache = true,
    cacheInstance,
    skipHealthCheck = false,
  } = options;

  let baseProvider: EmbeddingProvider | null = null;

  // Auto mode: try providers by priority
  if (requestedProvider === "auto") {
    logger.info("Auto-selecting embedding provider...");

    const providers = getProvidersByPriority();

    for (const [id, config] of providers) {
      logger.debug(`Trying provider: ${id} (priority: ${config.priority})`);

      baseProvider = await tryCreateProvider(config, id, skipHealthCheck);
      if (baseProvider) {
        logger.info(`Selected provider: ${id}`);
        break;
      }
    }

    if (!baseProvider) {
      throw new Error(
        "No embedding providers available. For local-first setup:\n" +
          "1. Install Ollama: curl -fsSL https://ollama.com/install.sh | sh\n" +
          "2. Start Ollama: ollama serve\n" +
          "3. Pull model: ollama pull nomic-embed-text:latest\n" +
          "\n" +
          "Or configure a remote provider:\n" +
          "- MISTRAL_API_KEY (Mistral AI text and code embeddings)",
      );
    }
  }
  // Specific provider mode
  else {
    const config = embeddingProviders[requestedProvider];
    if (!config) {
      throw new Error(`Unknown provider: ${requestedProvider}`);
    }

    baseProvider = await tryCreateProvider(
      config,
      requestedProvider,
      skipHealthCheck,
    );

    if (!baseProvider) {
      throw new Error(
        `Provider '${requestedProvider}' is not available. ` +
          `Please check configuration and ensure ${config.provider.toUpperCase()}_API_KEY is set.`,
      );
    }
  }

  // Wrap with cache if requested
  if (enableCache) {
    const cache =
      cacheInstance || new EmbeddingCache(baseProvider.id, baseProvider.model);

    const cachedProvider = withCache(baseProvider, cache);
    logger.info(`Cache enabled for ${baseProvider.id}`);

    return cachedProvider;
  }

  return baseProvider;
}

/**
 * Create all available providers (for testing/comparison)
 *
 * Returns an array of all providers that pass health checks.
 * Useful for benchmarking or testing multiple providers.
 */
export async function createAllProviders(
  options: { cache?: boolean; skipHealthCheck?: boolean } = {},
): Promise<EmbeddingProvider[]> {
  const { cache: enableCache = false, skipHealthCheck = false } = options;

  const providers = getProvidersByPriority();
  const results: EmbeddingProvider[] = [];

  for (const [id, config] of providers) {
    const provider = await tryCreateProvider(config, id, skipHealthCheck);
    if (provider) {
      if (enableCache) {
        const cache = new EmbeddingCache(provider.id, provider.model);
        results.push(withCache(provider, cache));
      } else {
        results.push(provider);
      }
    }
  }

  return results;
}

/**
 * Check which providers are available
 *
 * Returns a map of provider IDs to availability status.
 * Useful for diagnostics and configuration validation.
 */
export async function checkProviderAvailability(): Promise<
  Record<string, { available: boolean; reason?: string }>
> {
  const providers = getProvidersByPriority();
  const results: Record<string, { available: boolean; reason?: string }> = {};

  for (const [id, config] of providers) {
    // Check API key
    if (!hasApiKey(id)) {
      results[id] = {
        available: false,
        reason: "No API key configured",
      };
      continue;
    }

    // Check health
    try {
      const provider = createProvider(config, id);
      const available = await provider.isAvailable();

      results[id] = {
        available,
        reason: available ? undefined : "Health check failed",
      };
    } catch (error) {
      results[id] = {
        available: false,
        reason: (error as Error).message,
      };
    }
  }

  return results;
}

// Re-export types and utilities
export type { EmbeddingProvider } from "./provider.js";
export type { CachedEmbeddingProvider } from "./cached-provider.js";
export type { EmbeddingProviderConfig } from "./config.js";
export {
  embeddingProviders,
  getProvidersByPriority,
  hasApiKey,
} from "./config.js";
