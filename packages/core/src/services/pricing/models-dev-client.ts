/**
 * Client for fetching model pricing from models.dev API
 *
 * Local-First Strategy:
 * 1. Try persistent local cache (JSON file on disk)
 * 2. Try remote API (if online)
 * 3. Fallback to bundled defaults (always works offline)
 *
 * API: https://models.dev/api.json
 * Returns real-time pricing for 1900+ models from multiple providers
 */

import { logger } from "@th0th-ai/shared";
import { config } from "@th0th-ai/shared";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";

export interface ModelPricing {
  id: string;
  name: string;
  provider: string;
  family?: string;
  /** Input cost per 1M tokens (in USD) */
  inputCostPerMillion: number;
  /** Output cost per 1M tokens (in USD) */
  outputCostPerMillion: number;
  /** Cache read cost per 1M tokens (optional) */
  cacheReadCostPerMillion?: number;
  /** Context window size */
  contextWindow?: number;
  /** Max output tokens */
  maxOutputTokens?: number;
  /** Last updated timestamp */
  lastUpdated?: string;
}

export interface ModelsDevResponse {
  [providerId: string]: {
    id: string;
    name: string;
    models: {
      [modelId: string]: {
        id: string;
        name: string;
        family?: string;
        cost: {
          input: number;
          output: number;
          cache_read?: number;
        };
        limit?: {
          context?: number;
          output?: number;
        };
        last_updated?: string;
      };
    };
  };
}

/**
 * Structure for persistent local cache file
 */
interface LocalCacheData {
  timestamp: number;
  version: string;
  models: Record<string, ModelPricing>;
}

export class ModelsDevClient {
  private static readonly API_URL = "https://models.dev/api.json";
  private static readonly MEMORY_CACHE_TTL = 3600 * 1000; // 1 hour in-memory
  private static readonly LOCAL_CACHE_TTL = 24 * 3600 * 1000; // 24 hours on-disk
  private static readonly LOCAL_CACHE_FILE = "pricing-cache.json";

  private memoryCache: Map<string, ModelPricing> | null = null;
  private memoryCacheTimestamp = 0;

  /**
   * Get the local cache file path
   */
  private getLocalCachePath(): string {
    const dataDir = config.get("dataDir");
    return path.join(dataDir, ModelsDevClient.LOCAL_CACHE_FILE);
  }

  /**
   * Load pricing from persistent local cache (JSON on disk)
   */
  private async loadLocalCache(): Promise<Map<string, ModelPricing> | null> {
    const cachePath = this.getLocalCachePath();

    try {
      if (!existsSync(cachePath)) {
        return null;
      }

      const content = await fs.readFile(cachePath, "utf-8");
      const data = JSON.parse(content) as LocalCacheData;

      // Check cache age
      const age = Date.now() - data.timestamp;
      if (age > ModelsDevClient.LOCAL_CACHE_TTL) {
        logger.debug("Local pricing cache expired", {
          ageHours: Math.round(age / 3600000),
        });
        // Return expired cache anyway - will try to refresh
        // but still usable as fallback
      }

      const models = new Map<string, ModelPricing>();
      for (const [key, value] of Object.entries(data.models)) {
        models.set(key, value);
      }

      logger.debug("Loaded pricing from local cache", {
        models: models.size,
        ageHours: Math.round(age / 3600000),
      });

      return models;
    } catch (error) {
      logger.debug("Failed to load local pricing cache", {
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Save pricing to persistent local cache
   */
  private async saveLocalCache(
    models: Map<string, ModelPricing>,
  ): Promise<void> {
    const cachePath = this.getLocalCachePath();

    try {
      // Ensure data directory exists
      const dir = path.dirname(cachePath);
      await fs.mkdir(dir, { recursive: true });

      const data: LocalCacheData = {
        timestamp: Date.now(),
        version: "1.0.0",
        models: Object.fromEntries(models),
      };

      await fs.writeFile(cachePath, JSON.stringify(data), "utf-8");

      logger.debug("Saved pricing to local cache", {
        models: models.size,
        path: cachePath,
      });
    } catch (error) {
      logger.warn("Failed to save local pricing cache", {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Get bundled default pricing (always available offline)
   *
   * Contains common models with approximate pricing as of 2025.
   * Used as last-resort fallback when both remote and local cache fail.
   */
  private getBundledDefaults(): Map<string, ModelPricing> {
    const models = new Map<string, ModelPricing>();

    const defaults: ModelPricing[] = [
      // === LOCAL (Free) ===
      {
        id: "ollama/nomic-embed-text",
        name: "Nomic Embed Text",
        provider: "Ollama",
        family: "nomic",
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        contextWindow: 8192,
      },
      {
        id: "ollama/all-minilm",
        name: "All MiniLM",
        provider: "Ollama",
        family: "minilm",
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        contextWindow: 512,
      },
      {
        id: "ollama/mxbai-embed-large",
        name: "MxBai Embed Large",
        provider: "Ollama",
        family: "mxbai",
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        contextWindow: 512,
      },

      // === Mistral ===
      {
        id: "mistral-embed",
        name: "Mistral Embed",
        provider: "Mistral",
        family: "mistral",
        inputCostPerMillion: 0.1,
        outputCostPerMillion: 0,
        contextWindow: 8192,
      },
      {
        id: "codestral-embed",
        name: "Codestral Embed",
        provider: "Mistral",
        family: "codestral",
        inputCostPerMillion: 0.1,
        outputCostPerMillion: 0,
        contextWindow: 32768,
      },
      {
        id: "mistral-small-latest",
        name: "Mistral Small",
        provider: "Mistral",
        family: "mistral",
        inputCostPerMillion: 0.2,
        outputCostPerMillion: 0.6,
        contextWindow: 32768,
        maxOutputTokens: 8192,
      },

      // === OpenAI ===
      {
        id: "text-embedding-3-small",
        name: "Text Embedding 3 Small",
        provider: "OpenAI",
        family: "embedding",
        inputCostPerMillion: 0.02,
        outputCostPerMillion: 0,
        contextWindow: 8191,
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        provider: "OpenAI",
        family: "gpt-4",
        inputCostPerMillion: 0.15,
        outputCostPerMillion: 0.6,
        contextWindow: 128000,
        maxOutputTokens: 16384,
      },

      // === Anthropic ===
      {
        id: "claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
        provider: "Anthropic",
        family: "claude-3",
        inputCostPerMillion: 0.25,
        outputCostPerMillion: 1.25,
        contextWindow: 200000,
        maxOutputTokens: 4096,
      },
      {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        provider: "Anthropic",
        family: "claude-3.5",
        inputCostPerMillion: 3.0,
        outputCostPerMillion: 15.0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },

      // === Google ===
      {
        id: "gemini-1.5-flash",
        name: "Gemini 1.5 Flash",
        provider: "Google",
        family: "gemini",
        inputCostPerMillion: 0.075,
        outputCostPerMillion: 0.3,
        contextWindow: 1000000,
        maxOutputTokens: 8192,
      },

      // === Cohere ===
      {
        id: "embed-english-v3.0",
        name: "Embed English v3",
        provider: "Cohere",
        family: "embed",
        inputCostPerMillion: 0.1,
        outputCostPerMillion: 0,
        contextWindow: 512,
      },
    ];

    for (const pricing of defaults) {
      models.set(pricing.id, pricing);
    }

    logger.info("Using bundled pricing defaults (offline mode)", {
      models: models.size,
    });

    return models;
  }

  /**
   * Fetch all models with pricing
   *
   * Local-First Strategy:
   * 1. Check in-memory cache (fastest)
   * 2. Check persistent local cache on disk
   * 3. Try remote API (if online)
   * 4. Fallback to bundled defaults (always works)
   */
  async fetchAllModels(): Promise<Map<string, ModelPricing>> {
    // 1. Check in-memory cache
    if (
      this.memoryCache &&
      Date.now() - this.memoryCacheTimestamp <
        ModelsDevClient.MEMORY_CACHE_TTL
    ) {
      logger.debug("Using in-memory pricing cache");
      return this.memoryCache;
    }

    // 2. Check persistent local cache
    const localCache = await this.loadLocalCache();

    // 3. Try remote API
    let remoteModels: Map<string, ModelPricing> | null = null;
    try {
      remoteModels = await this.fetchRemote();

      // Save to local cache for future offline use
      await this.saveLocalCache(remoteModels);
    } catch (error) {
      logger.debug("Remote pricing fetch failed (offline?)", {
        error: (error as Error).message,
      });
    }

    // Determine best available data
    let result: Map<string, ModelPricing>;

    if (remoteModels) {
      result = remoteModels;
      logger.debug("Using remote pricing data");
    } else if (localCache) {
      result = localCache;
      logger.info("Using local pricing cache (offline mode)");
    } else {
      result = this.getBundledDefaults();
    }

    // Update in-memory cache
    this.memoryCache = result;
    this.memoryCacheTimestamp = Date.now();

    return result;
  }

  /**
   * Fetch pricing from remote API
   */
  private async fetchRemote(): Promise<Map<string, ModelPricing>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      logger.info("Fetching pricing data from models.dev API");

      const response = await fetch(ModelsDevClient.API_URL, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as ModelsDevResponse;

      // Parse and normalize
      const models = new Map<string, ModelPricing>();
      let totalModels = 0;
      let modelsWithPricing = 0;

      for (const [providerId, provider] of Object.entries(data)) {
        for (const [modelId, model] of Object.entries(
          provider.models || {},
        )) {
          totalModels++;

          const cost = model.cost || { input: 0, output: 0 };

          // Skip models with zero cost (free/unknown pricing)
          if (cost.input === 0 && cost.output === 0) {
            continue;
          }

          modelsWithPricing++;

          // Normalize model ID (remove provider prefix if present)
          const normalizedId = this.normalizeModelId(modelId);

          const pricing: ModelPricing = {
            id: normalizedId,
            name: model.name || modelId,
            provider: provider.name || providerId,
            family: model.family,
            inputCostPerMillion: cost.input,
            outputCostPerMillion: cost.output,
            cacheReadCostPerMillion: cost.cache_read,
            contextWindow: model.limit?.context,
            maxOutputTokens: model.limit?.output,
            lastUpdated: model.last_updated,
          };

          // Store with both original and normalized IDs
          models.set(modelId, pricing);
          if (normalizedId !== modelId) {
            models.set(normalizedId, pricing);
          }

          // Also store common aliases
          this.addCommonAliases(models, modelId, pricing);
        }
      }

      logger.info(
        `Loaded ${modelsWithPricing} models with pricing (out of ${totalModels} total)`,
      );

      return models;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get pricing for a specific model
   */
  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const models = await this.fetchAllModels();

    // Try exact match
    let pricing = models.get(modelId);
    if (pricing) return pricing;

    // Try normalized ID
    const normalized = this.normalizeModelId(modelId);
    pricing = models.get(normalized);
    if (pricing) return pricing;

    // Try case-insensitive search
    const lowerModelId = modelId.toLowerCase();
    for (const [key, value] of models.entries()) {
      if (key.toLowerCase() === lowerModelId) {
        return value;
      }
    }

    logger.warn(`Model pricing not found: ${modelId}`);
    return null;
  }

  /**
   * Search models by name, provider, or family
   */
  async searchModels(query: string): Promise<ModelPricing[]> {
    const models = await this.fetchAllModels();
    const lowerQuery = query.toLowerCase();

    const results: ModelPricing[] = [];
    const seen = new Set<string>();

    for (const pricing of models.values()) {
      // Skip duplicates (same model with different IDs)
      const key = `${pricing.provider}:${pricing.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Search in ID, name, provider, family
      if (
        pricing.id.toLowerCase().includes(lowerQuery) ||
        pricing.name.toLowerCase().includes(lowerQuery) ||
        pricing.provider.toLowerCase().includes(lowerQuery) ||
        (pricing.family &&
          pricing.family.toLowerCase().includes(lowerQuery))
      ) {
        results.push(pricing);
      }
    }

    // Sort by input cost (descending)
    results.sort((a, b) => b.inputCostPerMillion - a.inputCostPerMillion);

    return results;
  }

  /**
   * Get top N most expensive models
   */
  async getTopExpensiveModels(limit = 10): Promise<ModelPricing[]> {
    const models = await this.fetchAllModels();

    const unique = new Map<string, ModelPricing>();
    for (const pricing of models.values()) {
      const key = `${pricing.provider}:${pricing.name}`;
      if (!unique.has(key)) {
        unique.set(key, pricing);
      }
    }

    return Array.from(unique.values())
      .sort((a, b) => b.inputCostPerMillion - a.inputCostPerMillion)
      .slice(0, limit);
  }

  /**
   * Get statistics about available models
   */
  async getStatistics(): Promise<{
    totalModels: number;
    totalProviders: number;
    avgInputCost: number;
    avgOutputCost: number;
    cheapestModel: ModelPricing | null;
    mostExpensiveModel: ModelPricing | null;
  }> {
    const models = await this.fetchAllModels();

    const unique = new Map<string, ModelPricing>();
    const providers = new Set<string>();

    let totalInputCost = 0;
    let totalOutputCost = 0;

    for (const pricing of models.values()) {
      const key = `${pricing.provider}:${pricing.name}`;
      if (!unique.has(key)) {
        unique.set(key, pricing);
        providers.add(pricing.provider);
        totalInputCost += pricing.inputCostPerMillion;
        totalOutputCost += pricing.outputCostPerMillion;
      }
    }

    const modelList = Array.from(unique.values());
    modelList.sort(
      (a, b) => a.inputCostPerMillion - b.inputCostPerMillion,
    );

    return {
      totalModels: modelList.length,
      totalProviders: providers.size,
      avgInputCost: modelList.length > 0 ? totalInputCost / modelList.length : 0,
      avgOutputCost: modelList.length > 0 ? totalOutputCost / modelList.length : 0,
      cheapestModel: modelList[0] || null,
      mostExpensiveModel: modelList[modelList.length - 1] || null,
    };
  }

  /**
   * Normalize model ID (remove provider prefix, standardize format)
   */
  private normalizeModelId(modelId: string): string {
    let normalized = modelId
      .replace(
        /^(openai|anthropic|google|meta|mistral|cohere)\//i,
        "",
      )
      .replace(/^(claude-|gpt-|gemini-|llama-)/i, (match) =>
        match.toLowerCase(),
      );

    return normalized;
  }

  /**
   * Add common aliases for a model
   */
  private addCommonAliases(
    models: Map<string, ModelPricing>,
    modelId: string,
    pricing: ModelPricing,
  ): void {
    // GPT-4 aliases
    if (modelId.includes("gpt-4") && !modelId.includes("turbo")) {
      models.set("gpt-4", pricing);
    }
    if (modelId.includes("gpt-4-turbo")) {
      models.set("gpt-4-turbo", pricing);
    }
    if (modelId.includes("gpt-3.5-turbo")) {
      models.set("gpt-3.5-turbo", pricing);
    }

    // Claude aliases
    if (modelId.includes("claude-3-opus")) {
      models.set("claude-3-opus", pricing);
    }
    if (modelId.includes("claude-3-sonnet")) {
      models.set("claude-3-sonnet", pricing);
    }
    if (modelId.includes("claude-3-haiku")) {
      models.set("claude-3-haiku", pricing);
    }

    // Gemini aliases
    if (modelId.includes("gemini-pro")) {
      models.set("gemini-pro", pricing);
    }
    if (modelId.includes("gemini-1.5-pro")) {
      models.set("gemini-1.5-pro", pricing);
    }
    if (modelId.includes("gemini-1.5-flash")) {
      models.set("gemini-1.5-flash", pricing);
    }
  }

  /**
   * Clear all caches (memory + local file)
   */
  clearCache(): void {
    this.memoryCache = null;
    this.memoryCacheTimestamp = 0;
    logger.debug("Models.dev pricing memory cache cleared");
  }

  /**
   * Clear all caches including persistent local cache
   */
  async clearAllCaches(): Promise<void> {
    this.clearCache();

    const cachePath = this.getLocalCachePath();
    try {
      if (existsSync(cachePath)) {
        await fs.unlink(cachePath);
        logger.debug("Local pricing cache file deleted");
      }
    } catch (error) {
      logger.warn("Failed to delete local pricing cache", {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Check if local cache exists and is valid
   */
  async hasLocalCache(): Promise<boolean> {
    const cachePath = this.getLocalCachePath();
    return existsSync(cachePath);
  }
}

// Singleton instance
let clientInstance: ModelsDevClient | null = null;

/**
 * Get the shared ModelsDevClient instance
 */
export function getModelsDevClient(): ModelsDevClient {
  if (!clientInstance) {
    clientInstance = new ModelsDevClient();
  }
  return clientInstance;
}
