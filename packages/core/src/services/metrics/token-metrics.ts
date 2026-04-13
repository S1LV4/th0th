import { logger, estimateTokens } from "@th0th-ai/shared";

// ── Types ────────────────────────────────────────────────────────

export interface ModelPricing {
  input: number;  // Cost per 1M tokens
  output: number; // Cost per 1M tokens
}

export interface TokenSavingsBreakdown {
  /** Tokens saved by session file cache (diff-only + reference tokens) */
  sessionCache: number;
  /** Tokens saved by redundancy filter (deduplicated memories) */
  redundancyFilter: number;
  /** Tokens saved by context compression */
  compression: number;
  /** Total tokens saved across all optimizations */
  total: number;
}

export interface TokenMetricsStats {
  /** Breakdown of token savings by source */
  savings: TokenSavingsBreakdown;
  /** Total tokens processed (input to optimization pipeline) */
  totalTokensProcessed: number;
  /** Total tokens delivered (output after optimizations) */
  totalTokensDelivered: number;
  /** Overall compression ratio (0-1, higher = more savings) */
  overallCompressionRatio: number;
  /** Number of context requests served */
  requestsServed: number;
  /** Estimated cost savings in USD (based on model pricing) */
  estimatedCostSavings: number;
  /** Model used for cost estimation */
  model: string;
}

export interface TokenMetricsTimeSeries {
  timestamp: number;
  savings: TokenSavingsBreakdown;
  compressionRatio: number;
}

// ── Constants ────────────────────────────────────────────────────

/** models.dev API endpoint */
const MODELS_DEV_API = "https://models.dev/api.json";

/** Cache duration for models.dev pricing data (1 hour) */
const PRICING_CACHE_TTL_MS = 60 * 60 * 1000;

/** Fallback pricing for common models when API is unavailable (per 1M tokens in USD) */
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  "gpt-4": { input: 30, output: 60 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-3-sonnet": { input: 3, output: 15 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-sonnet-4.5": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash-exp": { input: 0, output: 0 },
};

/** Maximum time-series history entries to keep */
const MAX_HISTORY_ENTRIES = 1000;

// ── Service ──────────────────────────────────────────────────────

/**
 * Singleton token metrics collector with models.dev integration.
 */
export class TokenMetrics {
  private static instance: TokenMetrics | null = null;

  private readonly counters = {
    sessionCache: 0,
    redundancyFilter: 0,
    compression: 0,
  };

  private totalTokensProcessed = 0;
  private totalTokensDelivered = 0;
  private requestsServed = 0;

  /** Time-series history for tracking trends */
  private readonly history: TokenMetricsTimeSeries[] = [];

  /** Pricing cache: model ID -> pricing data */
  private readonly pricingCache = new Map<string, { pricing: ModelPricing; timestamp: number }>();

  private constructor() {}

  static getInstance(): TokenMetrics {
    if (!TokenMetrics.instance) {
      TokenMetrics.instance = new TokenMetrics();
    }
    return TokenMetrics.instance;
  }

  // ── Pricing API (models.dev integration) ───────────────────────

  /**
   * Get model pricing from models.dev API with caching and fallback.
   * 
   * @param modelId - Model identifier (e.g., "gpt-4", "claude-3-5-sonnet")
   * @returns Pricing data or fallback if unavailable
   */
  async getModelPricing(modelId: string): Promise<ModelPricing> {
    // Check cache first
    const cached = this.pricingCache.get(modelId);
    if (cached && Date.now() - cached.timestamp < PRICING_CACHE_TTL_MS) {
      return cached.pricing;
    }

    try {
      // Fetch from models.dev API
      const response = await fetch(MODELS_DEV_API, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000), // 5s timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      // Search for model in all providers
      for (const provider of Object.values(data as Record<string, any>)) {
        if (!provider.models) continue;
        
        for (const [id, model] of Object.entries(provider.models as Record<string, any>)) {
          // Match by exact ID or simplified name
          const matches = 
            id === modelId || 
            id.endsWith(`/${modelId}`) ||
            model.name?.toLowerCase().includes(modelId.toLowerCase());

          if (matches && model.cost) {
            const pricing: ModelPricing = {
              input: model.cost.input || 0,
              output: model.cost.output || 0,
            };

            // Cache the result
            this.pricingCache.set(modelId, { pricing, timestamp: Date.now() });
            
            logger.debug("Fetched pricing from models.dev", { modelId, pricing });
            return pricing;
          }
        }
      }

      throw new Error("Model not found in models.dev");
    } catch (error) {
      logger.warn("Failed to fetch pricing from models.dev, using fallback", {
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Use fallback pricing
      const fallback = FALLBACK_PRICING[modelId] || FALLBACK_PRICING["gpt-4"];
      
      // Cache fallback with shorter TTL
      this.pricingCache.set(modelId, { 
        pricing: fallback, 
        timestamp: Date.now() - (PRICING_CACHE_TTL_MS * 0.9) // Expire sooner
      });

      return fallback;
    }
  }

  /**
   * Calculate cost savings for a given model.
   * 
   * @param tokensSaved - Number of tokens saved
   * @param modelId - Model identifier for pricing lookup
   * @returns Cost savings in USD
   */
  async calculateCostSavings(tokensSaved: number, modelId: string = "gpt-4"): Promise<number> {
    const pricing = await this.getModelPricing(modelId);
    // Use input pricing for savings (conservative estimate)
    return (tokensSaved / 1_000_000) * pricing.input;
  }

  // ── Recording API ──────────────────────────────────────────────

  /**
   * Record tokens saved by session file cache.
   * Called from SessionFileCache.check() when returning unchanged/changed chunks.
   */
  recordSessionCacheSavings(tokensSaved: number): void {
    this.counters.sessionCache += tokensSaved;
    logger.debug("Token metrics: session cache savings", { tokensSaved });
  }

  /**
   * Record tokens saved by redundancy filter.
   * Called from RedundancyFilter.merge() after deduplicating memories.
   * 
   * @param removedContent - Content of the removed duplicate memory
   */
  recordRedundancyFilterSavings(removedContent: string): void {
    const tokensSaved = estimateTokens(removedContent, "text");
    this.counters.redundancyFilter += tokensSaved;
    logger.debug("Token metrics: redundancy filter savings", { tokensSaved });
  }

  /**
   * Record tokens saved by context compression.
   * Called from ContextController after compression.
   */
  recordCompressionSavings(originalTokens: number, compressedTokens: number): void {
    const tokensSaved = Math.max(0, originalTokens - compressedTokens);
    this.counters.compression += tokensSaved;
    logger.debug("Token metrics: compression savings", { tokensSaved });
  }

  /**
   * Record a complete context request with all metrics.
   * Called from ContextController.getOptimizedContext().
   */
  recordContextRequest(
    tokensProcessed: number,
    tokensDelivered: number,
    sessionCacheSavings: number = 0,
    compressionSavings: number = 0,
  ): void {
    this.totalTokensProcessed += tokensProcessed;
    this.totalTokensDelivered += tokensDelivered;
    this.requestsServed++;

    // Update individual counters
    if (sessionCacheSavings > 0) {
      this.counters.sessionCache += sessionCacheSavings;
    }
    if (compressionSavings > 0) {
      this.counters.compression += compressionSavings;
    }

    // Add to time-series history
    const totalSavings =
      this.counters.sessionCache +
      this.counters.redundancyFilter +
      this.counters.compression;

    const compressionRatio =
      this.totalTokensProcessed > 0
        ? totalSavings / this.totalTokensProcessed
        : 0;

    this.history.push({
      timestamp: Date.now(),
      savings: {
        sessionCache: this.counters.sessionCache,
        redundancyFilter: this.counters.redundancyFilter,
        compression: this.counters.compression,
        total: totalSavings,
      },
      compressionRatio,
    });

    // Trim history if needed
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.shift();
    }

    logger.metric("token_savings_total", totalSavings);
    logger.metric("compression_ratio", compressionRatio);
  }

  // ── Query API ──────────────────────────────────────────────────

  /**
   * Get current token metrics statistics.
   * 
   * @param modelId - Model identifier for cost estimation (defaults to "gpt-4")
   */
  async getStats(modelId: string = "gpt-4"): Promise<TokenMetricsStats> {
    const totalSavings =
      this.counters.sessionCache +
      this.counters.redundancyFilter +
      this.counters.compression;

    const overallCompressionRatio =
      this.totalTokensProcessed > 0
        ? totalSavings / this.totalTokensProcessed
        : 0;

    const estimatedCostSavings = await this.calculateCostSavings(totalSavings, modelId);

    return {
      savings: {
        sessionCache: this.counters.sessionCache,
        redundancyFilter: this.counters.redundancyFilter,
        compression: this.counters.compression,
        total: totalSavings,
      },
      totalTokensProcessed: this.totalTokensProcessed,
      totalTokensDelivered: this.totalTokensDelivered,
      overallCompressionRatio,
      requestsServed: this.requestsServed,
      estimatedCostSavings,
      model: modelId,
    };
  }

  /**
   * Get time-series history of token savings.
   * Useful for charting trends over time.
   */
  getHistory(): TokenMetricsTimeSeries[] {
    return [...this.history];
  }

  /**
   * Get the most recent N history entries.
   */
  getRecentHistory(limit: number = 100): TokenMetricsTimeSeries[] {
    return this.history.slice(-limit);
  }

  /**
   * Reset all counters (useful for testing).
   */
  reset(): void {
    this.counters.sessionCache = 0;
    this.counters.redundancyFilter = 0;
    this.counters.compression = 0;
    this.totalTokensProcessed = 0;
    this.totalTokensDelivered = 0;
    this.requestsServed = 0;
    this.history.length = 0;
    logger.info("Token metrics reset");
  }

  /**
   * Get a human-readable summary of token savings.
   * 
   * @param modelId - Model identifier for cost estimation (defaults to "gpt-4")
   */
  async getSummary(modelId: string = "gpt-4"): Promise<string> {
    const stats = await this.getStats(modelId);
    const pct = (n: number, d: number) => d === 0 ? 0 : (n / d) * 100;
    const lines: string[] = [
      "Token Savings Summary",
      "━".repeat(50),
      `Total Saved: ${stats.savings.total.toLocaleString()} tokens`,
      `  └─ Session Cache: ${stats.savings.sessionCache.toLocaleString()} (${pct(stats.savings.sessionCache, stats.savings.total).toFixed(1)}%)`,
      `  └─ Redundancy Filter: ${stats.savings.redundancyFilter.toLocaleString()} (${pct(stats.savings.redundancyFilter, stats.savings.total).toFixed(1)}%)`,
      `  └─ Compression: ${stats.savings.compression.toLocaleString()} (${pct(stats.savings.compression, stats.savings.total).toFixed(1)}%)`,
      "",
      `Requests Served: ${stats.requestsServed}`,
      `Overall Compression: ${(stats.overallCompressionRatio * 100).toFixed(1)}%`,
      `Estimated Cost Savings: $${stats.estimatedCostSavings.toFixed(2)} (${stats.model} pricing)`,
    ];

    return lines.join("\n");
  }
}
