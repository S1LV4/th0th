/**
 * Unit tests for TokenMetrics
 *
 * Tests unified token savings tracking across all optimization modules:
 * - SessionFileCache integration
 * - RedundancyFilter integration
 * - ContextController integration
 * - Aggregated statistics and cost estimates
 * - models.dev API integration with fallback pricing
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

// ── Mock fetch for models.dev API ─────────────────────────
const mockFetch = mock(() => {
  return Promise.reject(new Error("Network unavailable - use fallback"));
});
globalThis.fetch = mockFetch as any;

// ── Mock shared module ────────────────────────────────────────
mock.module("@th0th-ai/shared", () => {
  const actual = require("@th0th-ai/shared");
  return {
    ...actual,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      metric: () => {},
    },
    estimateTokens: (text: string, _type?: string) => {
      // Simple estimation: ~4 chars per token
      return Math.ceil(text.length / 4);
    },
  };
});

import { TokenMetrics } from "../services/metrics/token-metrics.js";

describe("TokenMetrics", () => {
  let metrics: TokenMetrics;

  beforeEach(() => {
    metrics = TokenMetrics.getInstance();
    metrics.reset(); // Clear counters between tests
  });

  // ── Recording API ──────────────────────────────────────────
  describe("Recording API", () => {
    test("recordSessionCacheSavings tracks session cache savings", async () => {
      metrics.recordSessionCacheSavings(150);
      metrics.recordSessionCacheSavings(250);

      const stats = await metrics.getStats();
      expect(stats.savings.sessionCache).toBe(400);
      expect(stats.savings.total).toBe(400);
    });

    test("recordRedundancyFilterSavings estimates tokens from content", async () => {
      // Content of 400 chars ~= 100 tokens
      const content = "a".repeat(400);
      
      metrics.recordRedundancyFilterSavings(content);

      const stats = await metrics.getStats();
      expect(stats.savings.redundancyFilter).toBeGreaterThan(0);
      expect(stats.savings.redundancyFilter).toBeLessThanOrEqual(100);
    });

    test("recordCompressionSavings tracks compression savings", async () => {
      metrics.recordCompressionSavings(1000, 400);

      const stats = await metrics.getStats();
      expect(stats.savings.compression).toBe(600);
      expect(stats.savings.total).toBe(600);
    });

    test("recordContextRequest aggregates all metrics", async () => {
      // Simulate a context request with 5000 tokens processed, 3000 delivered
      // Session cache saved 800, compression saved 1200
      metrics.recordContextRequest(5000, 3000, 800, 1200);

      const stats = await metrics.getStats();
      expect(stats.totalTokensProcessed).toBe(5000);
      expect(stats.totalTokensDelivered).toBe(3000);
      expect(stats.savings.sessionCache).toBe(800);
      expect(stats.savings.compression).toBe(1200);
      expect(stats.savings.total).toBe(2000);
      expect(stats.requestsServed).toBe(1);
    });
  });

  // ── Statistics ─────────────────────────────────────────────
  describe("Statistics", () => {
    test("getStats computes overall compression ratio", async () => {
      metrics.recordContextRequest(10000, 6000, 2000, 2000);

      const stats = await metrics.getStats();
      // Total savings = 4000 (2000 + 2000)
      // Processed = 10000
      // Ratio = 4000/10000 = 0.4
      expect(stats.overallCompressionRatio).toBeCloseTo(0.4, 2);
    });

    test("getStats estimates cost savings", async () => {
      // 1M tokens saved = $30 (GPT-4 pricing)
      // 100k tokens saved = $3
      metrics.recordSessionCacheSavings(100_000);

      const stats = await metrics.getStats();
      expect(stats.estimatedCostSavings).toBeCloseTo(3.0, 1);
    });

    test("getStats handles zero division gracefully", async () => {
      const stats = await metrics.getStats();
      
      expect(stats.overallCompressionRatio).toBe(0);
      expect(stats.savings.total).toBe(0);
      expect(stats.totalTokensProcessed).toBe(0);
      expect(stats.requestsServed).toBe(0);
    });

    test("getStats breaks down savings by source", async () => {
      metrics.recordSessionCacheSavings(1000);
      metrics.recordRedundancyFilterSavings("a".repeat(2000)); // ~500 tokens
      metrics.recordCompressionSavings(5000, 2500); // 2500 savings

      const stats = await metrics.getStats();
      expect(stats.savings.sessionCache).toBe(1000);
      expect(stats.savings.redundancyFilter).toBeGreaterThan(400);
      expect(stats.savings.compression).toBe(2500);
      expect(stats.savings.total).toBeGreaterThan(3900);
    });
  });

  // ── Time-Series History ────────────────────────────────────
  describe("Time-Series History", () => {
    test("recordContextRequest adds to history", () => {
      metrics.recordContextRequest(1000, 700, 150, 150);
      metrics.recordContextRequest(2000, 1600, 200, 200);

      const history = metrics.getHistory();
      expect(history.length).toBe(2);
      expect(history[0].savings.total).toBe(300);
      expect(history[1].savings.total).toBe(700);
    });

    test("getRecentHistory limits results", () => {
      // Add 10 entries
      for (let i = 0; i < 10; i++) {
        metrics.recordContextRequest(1000, 800, 100, 100);
      }

      const recent = metrics.getRecentHistory(5);
      expect(recent.length).toBe(5);
    });

    test("history includes timestamps", () => {
      const before = Date.now();
      metrics.recordContextRequest(1000, 700, 150, 150);
      const after = Date.now();

      const history = metrics.getHistory();
      expect(history[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(history[0].timestamp).toBeLessThanOrEqual(after);
    });

    test("history includes compression ratio", () => {
      metrics.recordContextRequest(10000, 6000, 2000, 2000);

      const history = metrics.getHistory();
      expect(history[0].compressionRatio).toBeCloseTo(0.4, 2);
    });
  });

  // ── Multiple Requests ──────────────────────────────────────
  describe("Multiple Requests", () => {
    test("accumulates savings across multiple requests", async () => {
      // Request 1
      metrics.recordContextRequest(5000, 3000, 800, 1200);
      // Request 2
      metrics.recordContextRequest(4000, 2500, 600, 900);
      // Request 3
      metrics.recordContextRequest(3000, 2000, 400, 600);

      const stats = await metrics.getStats();
      expect(stats.totalTokensProcessed).toBe(12000);
      expect(stats.totalTokensDelivered).toBe(7500);
      expect(stats.savings.sessionCache).toBe(1800);
      expect(stats.savings.compression).toBe(2700);
      expect(stats.savings.total).toBe(4500);
      expect(stats.requestsServed).toBe(3);
    });
  });

  // ── Reset ──────────────────────────────────────────────────
  describe("Reset", () => {
    test("reset clears all counters", async () => {
      metrics.recordSessionCacheSavings(1000);
      metrics.recordCompressionSavings(5000, 3000);
      metrics.recordContextRequest(10000, 7000, 1500, 1500);

      metrics.reset();

      const stats = await metrics.getStats();
      expect(stats.savings.total).toBe(0);
      expect(stats.totalTokensProcessed).toBe(0);
      expect(stats.requestsServed).toBe(0);
      expect(metrics.getHistory().length).toBe(0);
    });
  });

  // ── Summary ────────────────────────────────────────────────
  describe("Summary", () => {
    test("getSummary returns human-readable text", async () => {
      metrics.recordSessionCacheSavings(5000);
      metrics.recordRedundancyFilterSavings("a".repeat(8000)); // ~2000 tokens
      metrics.recordCompressionSavings(10000, 7000); // 3000 tokens
      metrics.recordContextRequest(20000, 12000, 5000, 3000);

      const summary = await metrics.getSummary();
      
      expect(summary).toContain("Token Savings Summary");
      expect(summary).toContain("Total Saved:");
      expect(summary).toContain("Session Cache:");
      expect(summary).toContain("Redundancy Filter:");
      expect(summary).toContain("Compression:");
      expect(summary).toContain("Requests Served:");
      expect(summary).toContain("Overall Compression:");
      expect(summary).toContain("Estimated Cost Savings:");
    });

    test("getSummary includes model name in output", async () => {
      metrics.recordSessionCacheSavings(1000);
      
      const summary = await metrics.getSummary("claude-3-5-sonnet");
      
      expect(summary).toContain("claude-3-5-sonnet");
    });
  });

  // ── models.dev Integration ─────────────────────────────────
  describe("models.dev API Integration", () => {
    test("getStats uses fallback pricing when API unavailable", async () => {
      // fetch is mocked to fail, so fallback should be used
      metrics.recordSessionCacheSavings(100_000);
      
      const stats = await metrics.getStats("gpt-4");
      
      // Fallback: gpt-4 input = $30/1M
      // 100k tokens = $3
      expect(stats.estimatedCostSavings).toBeCloseTo(3.0, 1);
      expect(stats.model).toBe("gpt-4");
    });

    test("getStats supports different models with fallback", async () => {
      metrics.recordSessionCacheSavings(1_000_000); // 1M tokens
      
      const gpt4Stats = await metrics.getStats("gpt-4");
      const claudeStats = await metrics.getStats("claude-3-5-sonnet");
      const gpt4oStats = await metrics.getStats("gpt-4o");
      
      // Fallback pricing:
      // gpt-4: $30/1M input
      // claude-3-5-sonnet: $3/1M input
      // gpt-4o: $2.5/1M input
      expect(gpt4Stats.estimatedCostSavings).toBeCloseTo(30, 1);
      expect(claudeStats.estimatedCostSavings).toBeCloseTo(3, 1);
      expect(gpt4oStats.estimatedCostSavings).toBeCloseTo(2.5, 1);
    });

    test("getStats supports opus models", async () => {
      metrics.recordSessionCacheSavings(1_000_000); // 1M tokens
      
      const opus1 = await metrics.getStats("claude-3-opus-20240229");
      const opus2 = await metrics.getStats("claude-opus-4-20250514");
      
      // Both opus models should use $15/1M input pricing
      expect(opus1.estimatedCostSavings).toBeCloseTo(15, 1);
      expect(opus2.estimatedCostSavings).toBeCloseTo(15, 1);
      expect(opus1.model).toBe("claude-3-opus-20240229");
      expect(opus2.model).toBe("claude-opus-4-20250514");
    });

    test("calculateCostSavings uses model-specific pricing", async () => {
      const gpt4Cost = await metrics.calculateCostSavings(1_000_000, "gpt-4");
      const claudeCost = await metrics.calculateCostSavings(1_000_000, "claude-3-5-sonnet");
      
      expect(gpt4Cost).toBeCloseTo(30, 1);
      expect(claudeCost).toBeCloseTo(3, 1);
    });

    test("getModelPricing caches results", async () => {
      mockFetch.mockClear();
      
      // First call attempts fetch (fails, uses fallback)
      const pricing1 = await metrics.getModelPricing("gpt-4");
      const callCount1 = mockFetch.mock.calls.length;
      
      // Second call should use cache
      const pricing2 = await metrics.getModelPricing("gpt-4");
      const callCount2 = mockFetch.mock.calls.length;
      
      expect(pricing1).toEqual(pricing2);
      expect(callCount2).toBe(callCount1); // No additional fetch
    });
  });
});
