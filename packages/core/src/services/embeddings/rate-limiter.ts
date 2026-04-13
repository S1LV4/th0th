/**
 * Rate Limiter for Embedding Providers
 * 
 * Implements sliding window rate limiting for:
 * - RPM (Requests Per Minute)
 * - TPM (Tokens Per Minute)
 * - RPD (Requests Per Day)
 * 
 * Prevents hitting API rate limits by tracking requests and enforcing delays.
 */

import { logger } from "@th0th-ai/shared";

interface RateLimitConfig {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  requestsPerDay?: number;
}

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

export class EmbeddingRateLimiter {
  private readonly requestsWindow: RequestRecord[] = [];
  private readonly dailyRequestsWindow: RequestRecord[] = [];
  private readonly config: RateLimitConfig;
  private readonly providerId: string;

  constructor(providerId: string, config: RateLimitConfig) {
    this.providerId = providerId;
    this.config = config;
  }

  /**
   * Wait until rate limits allow the next request
   * @param estimatedTokens Estimated tokens for this request (content.length / 4)
   */
  async waitForCapacity(estimatedTokens: number = 0): Promise<void> {
    const MAX_ATTEMPTS = 60;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const now = Date.now();

      this.cleanWindow(this.requestsWindow, now, 60_000);
      this.cleanWindow(this.dailyRequestsWindow, now, 86_400_000);

      // Check RPM limit
      if (this.config.requestsPerMinute && this.requestsWindow.length >= this.config.requestsPerMinute) {
        const oldestRequest = this.requestsWindow[0];
        if (oldestRequest) {
          const waitTime = 60_000 - (now - oldestRequest.timestamp);
          if (waitTime > 0) {
            logger.debug(`[${this.providerId}] RPM limit reached, waiting ${waitTime}ms`, {
              rpm: this.config.requestsPerMinute,
              current: this.requestsWindow.length,
            });
            await this.sleep(waitTime);
            continue;
          }
        }
      }

      // Check TPM limit (skip if single request exceeds limit -- it would never pass)
      if (this.config.tokensPerMinute && estimatedTokens > 0 && estimatedTokens <= this.config.tokensPerMinute) {
        const tokensInLastMinute = this.requestsWindow.reduce((sum, r) => sum + r.tokens, 0);
        if (tokensInLastMinute + estimatedTokens > this.config.tokensPerMinute) {
          const oldestRequest = this.requestsWindow[0];
          if (oldestRequest) {
            const waitTime = 60_000 - (now - oldestRequest.timestamp);
            if (waitTime > 0) {
              logger.debug(`[${this.providerId}] TPM limit reached, waiting ${waitTime}ms`, {
                tpm: this.config.tokensPerMinute,
                current: tokensInLastMinute,
                requested: estimatedTokens,
              });
              await this.sleep(waitTime);
              continue;
            }
          }
        }
      }

      // Check RPD limit
      if (this.config.requestsPerDay && this.dailyRequestsWindow.length >= this.config.requestsPerDay) {
        logger.warn(`[${this.providerId}] RPD limit reached, waiting 60s`, {
          rpd: this.config.requestsPerDay,
          current: this.dailyRequestsWindow.length,
        });
        await this.sleep(60_000);
        continue;
      }

      return; // All checks passed
    }

    throw new Error(
      `[${this.providerId}] Rate limiter: max wait attempts (${MAX_ATTEMPTS}) exceeded for ${estimatedTokens} estimated tokens`
    );
  }

  /**
   * Record a request for rate limiting
   */
  recordRequest(tokens: number = 0): void {
    const now = Date.now();
    const record: RequestRecord = { timestamp: now, tokens };
    this.requestsWindow.push(record);
    this.dailyRequestsWindow.push(record);

    // Periodic cleanup to prevent unbounded array growth
    if (this.requestsWindow.length % 100 === 0) {
      this.cleanWindow(this.requestsWindow, now, 60_000);
      this.cleanWindow(this.dailyRequestsWindow, now, 86_400_000);
    }
  }

  /**
   * Get current rate limit status
   */
  getStatus() {
    const now = Date.now();
    this.cleanWindow(this.requestsWindow, now, 60_000);
    this.cleanWindow(this.dailyRequestsWindow, now, 86_400_000);

    const requestsInLastMinute = this.requestsWindow.length;
    const tokensInLastMinute = this.requestsWindow.reduce((sum, r) => sum + r.tokens, 0);
    const requestsToday = this.dailyRequestsWindow.length;

    return {
      rpm: {
        current: requestsInLastMinute,
        limit: this.config.requestsPerMinute || Infinity,
        percentage: this.config.requestsPerMinute 
          ? (requestsInLastMinute / this.config.requestsPerMinute) * 100 
          : 0,
      },
      tpm: {
        current: tokensInLastMinute,
        limit: this.config.tokensPerMinute || Infinity,
        percentage: this.config.tokensPerMinute 
          ? (tokensInLastMinute / this.config.tokensPerMinute) * 100 
          : 0,
      },
      rpd: {
        current: requestsToday,
        limit: this.config.requestsPerDay || Infinity,
        percentage: this.config.requestsPerDay 
          ? (requestsToday / this.config.requestsPerDay) * 100 
          : 0,
      },
    };
  }

  private cleanWindow(window: RequestRecord[], now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    let i = 0;
    while (i < window.length && window[i].timestamp < cutoff) i++;
    if (i > 0) window.splice(0, i);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
