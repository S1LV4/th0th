/**
 * Multi-Provider Embedding Service using Vercel AI SDK
 *
 * Provides a unified interface for embedding generation across multiple providers
 * (OpenAI, Google, Cohere, Ollama) with automatic retry and timeout handling.
 *
 * Inspired by OpenClaw's provider system with improvements:
 * - Uses Vercel AI SDK for provider abstraction
 * - Exponential backoff retry (500ms base, 8s max)
 * - Configurable timeouts (60s remote, 5min local)
 * - Health checks before usage
 * - Batch operations with token limits
 */

import { embed, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { cohere } from "@ai-sdk/cohere";
import { mistral } from "@ai-sdk/mistral";
import { ollama } from "ollama-ai-provider";
import type { EmbeddingProviderConfig } from "./config.js";
import { metrics } from "../monitoring/metrics.js";
import { EmbeddingRateLimiter } from "./rate-limiter.js";
import { logger } from "@th0th-ai/shared";

/**
 * Base interface for embedding providers
 */
export interface EmbeddingProvider {
  /** Unique provider identifier */
  id: string;

  /** Model identifier */
  model: string;

  /** Embedding dimensions */
  dimensions: number;

  /** Embed a single text query */
  embedQuery(text: string): Promise<number[]>;

  /** Embed multiple texts in batch */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** Check if provider is available and configured */
  isAvailable(): Promise<boolean>;

  /** Get provider configuration */
  getConfig(): EmbeddingProviderConfig;
}

/**
 * Retry configuration for failed embedding requests
 */
interface RetryConfig {
  maxRetries: number;
  baseDelay: number; // ms
  maxDelay: number; // ms
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function getRetryDelay(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelay * Math.pow(2, attempt);
  return Math.min(delay, config.maxDelay);
}

/**
 * Execute a function with retry logic
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  context: string,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < config.maxRetries) {
        const delay = getRetryDelay(attempt, config);
        logger.warn(
          `[EmbeddingProvider] ${context} failed (attempt ${attempt + 1}/${config.maxRetries + 1}), retrying in ${delay}ms`,
          { error: lastError.message },
        );
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `${context} failed after ${config.maxRetries + 1} attempts: ${lastError?.message}`,
  );
}

/**
 * Execute with timeout
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  context: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${context} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

/**
 * AI SDK-based embedding provider implementation
 *
 * Supports OpenAI, Google, Cohere, and Ollama via Vercel AI SDK
 * with automatic retry, timeout, and health checking.
 */
export class AISDKEmbeddingProvider implements EmbeddingProvider {
  public readonly id: string;
  public readonly model: string;
  public readonly dimensions: number;

  private readonly providerType:
    | "openai"
    | "google"
    | "cohere"
    | "ollama"
    | "mistral";
  private readonly apiKey?: string;
  private readonly baseURL?: string;
  private readonly timeout: number;
  private readonly retryConfig: RetryConfig;
  private readonly rateLimiter?: EmbeddingRateLimiter;
  
  // Ollama rate limiting: Mutex to prevent overwhelming the server
  private static ollamaMutex: Promise<void> = Promise.resolve();
  private static readonly OLLAMA_DELAY_MS = 50; // 50ms between requests

  constructor(
    private readonly config: EmbeddingProviderConfig,
    private readonly providerId: string,
  ) {
    this.id = providerId;
    this.model = config.model;
    this.dimensions = config.dimensions || 768; // Default to common dimension
    this.providerType = config.provider as "openai" | "google" | "cohere" | "ollama" | "mistral";
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL;
    this.timeout = config.timeout || 60000; // Default 60s

    this.retryConfig = {
      maxRetries: config.maxRetries || 3,
      baseDelay: 500,
      maxDelay: 8000,
    };

    // Initialize rate limiter if configured
    if (config.rateLimits) {
      this.rateLimiter = new EmbeddingRateLimiter(providerId, {
        requestsPerMinute: config.rateLimits.requestsPerMinute,
        tokensPerMinute: config.rateLimits.tokensPerMinute,
        requestsPerDay: config.rateLimits.requestsPerDay,
      });
      logger.info(`[${providerId}] Rate limiter initialized`, config.rateLimits);
    }
  }

  /**
   * Get AI SDK provider instance based on configuration
   */
  private getSDKProvider() {
    switch (this.providerType) {
      case "openai":
        return openai;

      case "google":
        return google;

      case "cohere":
        return cohere;

      case "mistral":
        return mistral;

      case "ollama":
        return ollama;

      default:
        throw new Error(`Unsupported provider: ${this.providerType}`);
    }
  }

  /**
   * Get provider options (API key, base URL)
   */
  private getProviderOptions(): Record<string, any> {
    const options: Record<string, any> = {};

    if (this.apiKey) {
      options.apiKey = this.apiKey;
    }

    if (this.baseURL) {
      options.baseURL = this.baseURL;
    }

    return options;
  }

  /**
   * Truncate text to fit model context length
   *
   * BGE-M3 has an 8192 token context window.
   * With smart chunking, chunks are much smaller and more semantic,
   * so we can afford a higher character limit.
   *
   * Token estimation: ~4 chars/token for English text, ~2-3 for code.
   * 4000 chars ≈ 1000-2000 tokens, well within 8192 limit.
   */
  private truncateText(text: string): string {
    const MAX_CHARS = 4000; // ~1000-2000 tokens, safe for 8192 token context
    
    if (text.length <= MAX_CHARS) {
      return text;
    }
    
    // Truncate and add marker
    const truncated = text.substring(0, MAX_CHARS);
    logger.warn(
      `[${this.id}] Text truncated to fit context`,
      { originalLength: text.length, maxChars: MAX_CHARS },
    );

    return truncated;
  }

  /**
   * Sanitize text to prevent NaN errors in embedding models
   * 
   * Removes:
   * - Control characters (U+0000 to U+001F, U+007F)
   * - Replacement character U+FFFD (indicates broken UTF-8)
   * - ONLY unpaired surrogate halves (invalid UTF-16)
   * - Zero-width and non-printable characters
   * 
   * Preserves valid Unicode (emojis, accented chars, CJK, etc.)
   */
  private sanitizeText(text: string): string {
    // Step 1: Remove control characters and replacement char
    let sanitized = text
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .replace(/\uFFFD/g, " ");
    
    // Step 2: Remove UNPAIRED surrogate halves only (preserve valid pairs for emojis)
    // Valid pair: High surrogate (D800-DBFF) followed by Low surrogate (DC00-DFFF)
    sanitized = sanitized.replace(
      /([\uD800-\uDBFF](?![\uDC00-\uDFFF]))|((?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g,
      " "
    );
    
    // Step 3: Remove zero-width and non-printable chars
    sanitized = sanitized
      .replace(/[\u200B-\u200D\uFEFF]/g, "") // Zero-width spaces
      .replace(/\u00A0/g, " "); // Non-breaking space → normal space
    
    return sanitized;
  }

  /**
   * Queue Ollama requests to prevent overwhelming the server
   */
  private async queueOllamaRequest<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prev = AISDKEmbeddingProvider.ollamaMutex;
    AISDKEmbeddingProvider.ollamaMutex = gate;

    await prev;
    await sleep(AISDKEmbeddingProvider.OLLAMA_DELAY_MS);

    try {
      return await fn();
    } finally {
      release!();
    }
  }

  /**
   * Embed a single text query
   */
  async embedQuery(text: string): Promise<number[]> {
    const startTime = Date.now();
    let error = false;
    
    try {
      const result = await withTimeout(
        () =>
          withRetry(
            async () => {
              // Ollama: Custom direct API call (no AI SDK) with rate limiting
              if (this.providerType === "ollama") {
                return this.queueOllamaRequest(async () => {
                  const inputText = this.sanitizeText(this.truncateText(text));
                  
                  const response = await fetch(`${this.baseURL}/api/embed`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      model: this.model,
                      input: inputText,
                    }),
                  });

                  if (!response.ok) {
                    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
                  }

                  const data = await response.json() as {
                    embeddings?: number[][];
                    embedding?: number[];
                  };
                  const embedding = Array.isArray(data.embeddings)
                    ? data.embeddings[0]
                    : data.embedding;
                  
                  // Validate embedding: check for NaN or invalid values
                  if (!embedding || !Array.isArray(embedding)) {
                    throw new Error("Invalid embedding response: missing or invalid embedding array");
                  }
                  
                  if (embedding.some(v => isNaN(v) || !isFinite(v))) {
                    throw new Error("Invalid embedding response: contains NaN or Infinity values");
                  }
                  
                  return embedding;
                });
              }

              // Other providers: Use AI SDK
              const provider = this.getSDKProvider();
              const options = this.getProviderOptions();

              const { embedding } = await embed({
                model: provider.embedding(this.model, options) as any,
                value: text,
              });

              return Array.from(embedding);
            },
            this.retryConfig,
            `[${this.id}] embedQuery`,
          ),
        this.timeout,
        `[${this.id}] embedQuery`,
      );
      
      // Record metrics (will be marked as cache miss by cached-provider if not cached)
      const latency = Date.now() - startTime;
      const tokens = Math.ceil(text.length / 4); // Rough estimate
      metrics.recordEmbedding({
        provider: this.id,
        tokens,
        latency,
        cached: false, // Provider level doesn't know about cache
        error: false,
      });
      
      return result;
    } catch (err) {
      error = true;
      const latency = Date.now() - startTime;
      const tokens = Math.ceil(text.length / 4);
      metrics.recordEmbedding({
        provider: this.id,
        tokens,
        latency,
        cached: false,
        error: true,
      });
      throw err;
    }
  }

  /**
   * Embed multiple texts in batch with intelligent rate limiting
   *
   * Features:
   * - Rate limiting for RPM/TPM/RPD
   * - Sub-batching to respect provider limits
   * - Sequential processing with delays between batches
   * - Progress logging for large batches
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // Get batch size from config or use default
    const batchSize = this.config.rateLimits?.batchSize || texts.length;
    const batchDelay = this.config.rateLimits?.batchDelayMs || 0;

    // If no rate limiting configured or batch fits in single request, use original logic
    if (!this.rateLimiter || texts.length <= batchSize) {
      return this.embedBatchDirect(texts);
    }

    // Process in sub-batches with rate limiting
    logger.info(`[${this.id}] Processing ${texts.length} texts in batches of ${batchSize}`, {
      totalBatches: Math.ceil(texts.length / batchSize),
      batchDelayMs: batchDelay,
    });

    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(texts.length / batchSize);

      // Estimate tokens for this batch
      const estimatedTokens = batch.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);

      // Wait for rate limit capacity
      await this.rateLimiter.waitForCapacity(estimatedTokens);

      // Process batch
      logger.debug(`[${this.id}] Processing batch ${batchNum}/${totalBatches} (${batch.length} texts)`);
      const batchEmbeddings = await this.embedBatchDirect(batch);
      allEmbeddings.push(...batchEmbeddings);

      // Record request for rate limiting
      this.rateLimiter.recordRequest(estimatedTokens);

      // Delay between batches (if configured and not last batch)
      if (batchDelay > 0 && i + batchSize < texts.length) {
        logger.debug(`[${this.id}] Waiting ${batchDelay}ms before next batch`);
        await sleep(batchDelay);
      }
    }

    logger.info(`[${this.id}] Completed batch processing`, {
      totalTexts: texts.length,
      totalBatches: Math.ceil(texts.length / batchSize),
      rateLimitStatus: this.rateLimiter.getStatus(),
    });

    return allEmbeddings;
  }

  /**
   * Direct batch embedding without rate limiting (used internally)
   */
  private async embedBatchDirect(texts: string[]): Promise<number[][]> {
    // Ollama: Prefer native batch endpoint (/api/embed with input array)
    if (this.providerType === "ollama") {
      try {
        return await withTimeout(
          () =>
            withRetry(
              async () => {
                const response = await fetch(`${this.baseURL}/api/embed`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: this.model,
                    input: texts.map((t) => this.sanitizeText(this.truncateText(t))),
                  }),
                });

                if (!response.ok) {
                  throw new Error(
                    `Ollama batch API error: ${response.status} ${response.statusText}`,
                  );
                }

                const data = (await response.json()) as {
                  embeddings?: number[][];
                  embedding?: number[];
                };

                const output = Array.isArray(data.embeddings)
                  ? data.embeddings
                  : Array.isArray(data.embedding)
                    ? [data.embedding]
                    : null;

                if (!output || output.length !== texts.length) {
                  throw new Error(
                    `Invalid Ollama batch embedding response (expected ${texts.length} embeddings)`
                  );
                }

                for (const emb of output) {
                  if (!Array.isArray(emb)) {
                    throw new Error("Invalid embedding in batch response");
                  }
                  if (emb.some((v) => isNaN(v) || !isFinite(v))) {
                    throw new Error(
                      "Invalid embedding response: contains NaN or Infinity values",
                    );
                  }
                }

                return output;
              },
              this.retryConfig,
              `[${this.id}] embedBatchDirect (${texts.length} texts)`,
            ),
          this.timeout,
          `[${this.id}] embedBatchDirect`,
        );
      } catch (error) {
        logger.warn(
          `[${this.id}] Ollama batch endpoint unavailable, falling back to sequential embeds: ${(error as Error).message}`,
        );
        const embeddings: number[][] = [];
        let consecutiveFailures = 0;
        for (const text of texts) {
          try {
            const embedding = await this.embedQuery(text);
            embeddings.push(embedding);
            consecutiveFailures = 0;
          } catch (singleErr) {
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
              throw new Error(
                `[${this.id}] Ollama batch fallback aborted after 3 consecutive failures: ${(singleErr as Error).message}`,
              );
            }
            embeddings.push(new Array(this.dimensions).fill(0));
          }
        }
        return embeddings;
      }
    }

    // Other providers: Use AI SDK batch
    return withTimeout(
      () =>
        withRetry(
          async () => {
            const provider = this.getSDKProvider();
            const options = this.getProviderOptions();

            const { embeddings } = await embedMany({
              model: provider.embedding(this.model, options) as any,
              values: texts,
            });

            return embeddings.map((e) => Array.from(e));
          },
          this.retryConfig,
          `[${this.id}] embedBatchDirect (${texts.length} texts)`,
        ),
      this.timeout,
      `[${this.id}] embedBatchDirect`,
    );
  }

  /**
   * Check if provider is available and configured correctly
   *
   * For Ollama: performs a fast 2s connectivity check first to avoid
   * long timeouts when the service is offline (issue #15).
   *
   * Then validates with a test embedding:
   * - API key is valid
   * - Model is accessible
   * - Network connectivity
   * - Service is responding
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Ollama: fast connectivity pre-check (2s timeout) to avoid
      // blocking for minutes when service is offline
      if (this.providerType === "ollama") {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          const response = await fetch(`${this.baseURL}/api/tags`, {
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (!response.ok) {
            logger.error(
              `[${this.id}] Ollama API returned ${response.status}`,
            );
            return false;
          }
        } catch {
          logger.error(
            `[${this.id}] Ollama service unreachable`,
            undefined,
            { baseURL: this.baseURL, timeoutMs: 2000 },
          );
          return false;
        }
      }

      // Test with a simple query (reduced timeout for local providers)
      const testText = "test";
      const embedding = await this.embedQuery(testText);

      // Validate embedding format
      if (!Array.isArray(embedding) || embedding.length !== this.dimensions) {
        logger.error(
          `[${this.id}] Invalid embedding dimensions`,
          undefined,
          { expected: this.dimensions, got: embedding.length },
        );
        return false;
      }

      // Validate embedding values (should be numbers)
      if (!embedding.every((v) => typeof v === "number" && !isNaN(v))) {
        logger.error(`[${this.id}] Invalid embedding values (not numbers)`);
        return false;
      }

      return true;
    } catch (error) {
      logger.error(
        `[${this.id}] Provider unavailable`,
        error as Error,
      );
      return false;
    }
  }

  /**
   * Get provider configuration
   */
  getConfig(): EmbeddingProviderConfig {
    return this.config;
  }

  /**
   * Get rate limiter status (if configured)
   */
  getRateLimitStatus() {
    if (!this.rateLimiter) {
      return null;
    }
    return this.rateLimiter.getStatus();
  }
}

/**
 * Factory function to create embedding providers from configuration
 */
export function createProvider(
  config: EmbeddingProviderConfig,
  providerId: string,
): EmbeddingProvider {
  return new AISDKEmbeddingProvider(config, providerId);
}

/**
 * Create multiple providers from configurations
 */
export function createProviders(
  configs: Array<[string, EmbeddingProviderConfig]>,
): EmbeddingProvider[] {
  return configs.map(([id, config]) => createProvider(config, id));
}
