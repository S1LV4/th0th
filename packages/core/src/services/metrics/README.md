# Token Metrics - Unified Observability

Comprehensive token savings tracking across all th0th optimization modules.

## Overview

The `TokenMetrics` service provides a unified interface for tracking token savings from:

1. **SessionFileCache**: Diff-only context delivery (unchanged/changed chunks)
2. **RedundancyFilter**: Memory deduplication
3. **ContextController**: Compression and aggregation

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      TokenMetrics                            │
│                   (Singleton Service)                        │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │
      ┌────────────────────┼────────────────────┐
      │                    │                    │
      │                    │                    │
┌─────▼──────┐  ┌──────────▼───────┐  ┌────────▼──────────┐
│SessionFile │  │RedundancyFilter  │  │ContextController  │
│   Cache    │  │                  │  │                   │
└────────────┘  └──────────────────┘  └───────────────────┘
```

### Data Flow

1. **Session Cache**: Records savings on each `check()` call when chunks are unchanged/changed
2. **Redundancy Filter**: Records savings during `mergeDuplicates()` when removing duplicate memories
3. **Context Controller**: Aggregates all savings at the end of each `getOptimizedContext()` request

## API Reference

### Recording Methods

```typescript
// Record session cache savings (automatic from SessionFileCache)
TokenMetrics.getInstance().recordSessionCacheSavings(tokensSaved: number): void

// Record redundancy filter savings (automatic from RedundancyFilter)
TokenMetrics.getInstance().recordRedundancyFilterSavings(removedContent: string): void

// Record compression savings (automatic from ContextController)
TokenMetrics.getInstance().recordCompressionSavings(
  originalTokens: number,
  compressedTokens: number
): void

// Record complete context request (automatic from ContextController)
TokenMetrics.getInstance().recordContextRequest(
  tokensProcessed: number,
  tokensDelivered: number,
  sessionCacheSavings?: number,
  compressionSavings?: number
): void
```

### Query Methods

```typescript
// Get current statistics with model-specific pricing
const stats = await TokenMetrics.getInstance().getStats("gpt-4");
/*
{
  savings: {
    sessionCache: 45000,
    redundancyFilter: 12000,
    compression: 28000,
    total: 85000
  },
  totalTokensProcessed: 250000,
  totalTokensDelivered: 165000,
  overallCompressionRatio: 0.34,
  requestsServed: 42,
  estimatedCostSavings: 2.55,  // USD (model-specific pricing)
  model: "gpt-4"
}
*/

// Compare costs across different models
const gpt4Stats = await TokenMetrics.getInstance().getStats("gpt-4");
const claudeStats = await TokenMetrics.getInstance().getStats("claude-3-5-sonnet");
const gpt4oStats = await TokenMetrics.getInstance().getStats("gpt-4o");

// Get time-series history
const history = TokenMetrics.getInstance().getHistory();
/*
[
  {
    timestamp: 1709625600000,
    savings: { sessionCache: 1000, redundancyFilter: 500, compression: 800, total: 2300 },
    compressionRatio: 0.25
  },
  ...
]
*/

// Get recent history (last N entries)
const recent = TokenMetrics.getInstance().getRecentHistory(10);

// Get human-readable summary with model-specific pricing
const summary = await TokenMetrics.getInstance().getSummary("gpt-4");
console.log(summary);
/*
Token Savings Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Saved: 85,000 tokens
  └─ Session Cache: 45,000 (52.9%)
  └─ Redundancy Filter: 12,000 (14.1%)
  └─ Compression: 28,000 (32.9%)

Requests Served: 42
Overall Compression: 34.0%
Estimated Cost Savings: $2.55 (gpt-4 pricing)
*/

// Reset all counters (for testing)
TokenMetrics.getInstance().reset();
```

## models.dev Integration

TokenMetrics automatically fetches real-time pricing from the [models.dev API](https://models.dev/api.json) to provide accurate cost estimates across different AI models.

### How It Works

1. **Dynamic Pricing**: Fetches current pricing from models.dev on first use
2. **1-Hour Cache**: Caches pricing data with 1-hour TTL to reduce API calls
3. **Fallback Pricing**: Uses hardcoded prices if API is unavailable
4. **Multi-Provider**: Supports models from OpenAI, Anthropic, Google, and others

### Supported Models

The service includes fallback pricing for common models:

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|-------|---------------------|----------------------|
| gpt-4 | $30 | $60 |
| gpt-4-turbo | $10 | $30 |
| gpt-4o | $2.5 | $10 |
| gpt-4o-mini | $0.15 | $0.6 |
| claude-3-opus-20240229 | $15 | $75 |
| claude-opus-4-20250514 | $15 | $75 |
| claude-3-5-sonnet | $3 | $15 |
| claude-sonnet-4.5 | $3 | $15 |
| claude-3-5-haiku | $0.8 | $4 |
| gemini-1.5-pro | $1.25 | $5 |
| gemini-2.0-flash-exp | Free | Free |

### Pricing API

```typescript
// Get pricing for a specific model
const pricing = await TokenMetrics.getInstance().getModelPricing("gpt-4");
/*
{
  input: 30,   // USD per 1M tokens
  output: 60   // USD per 1M tokens
}
*/

// Calculate cost savings for a specific model
const cost = await TokenMetrics.getInstance().calculateCostSavings(
  100_000,  // tokens saved
  "claude-3-5-sonnet"
);
// Returns: 0.3 (100k tokens * $3/1M = $0.30)
```

### Caching Behavior

- **Cache Duration**: 1 hour (configurable via `PRICING_CACHE_TTL_MS`)
- **Cache Key**: Model ID
- **Fallback TTL**: Fallback prices expire faster (54 minutes) to retry API
- **Network Timeout**: 5 seconds per request

### Example: Multi-Model Cost Analysis

```typescript
const metrics = TokenMetrics.getInstance();

// Record some savings
metrics.recordSessionCacheSavings(500_000);
metrics.recordRedundancyFilterSavings("..."); // 250k tokens
metrics.recordCompressionSavings(1_000_000, 750_000);

// Compare costs across models
const models = ["gpt-4", "gpt-4o", "claude-3-5-sonnet", "claude-3-5-haiku"];
for (const model of models) {
  const stats = await metrics.getStats(model);
  console.log(`${model}: $${stats.estimatedCostSavings.toFixed(2)} saved`);
}

/*
gpt-4: $30.00 saved
gpt-4o: $2.50 saved
claude-3-5-sonnet: $3.00 saved
claude-3-5-haiku: $0.80 saved
*/
```

## Integration Points

### 1. SessionFileCache

**Location**: `packages/core/src/services/context/session-file-cache.ts:176,186,197,203`

**When**: Automatically records savings on each `check()` call when:
- Chunk is unchanged (reference token used)
- Chunk is changed (diff delivered instead of full content)

```typescript
// In SessionFileCache.check()
if (existing.hash === hash) {
  const saved = estimateTokens(content, "code") - REFERENCE_TOKEN_COST;
  TokenMetrics.getInstance().recordSessionCacheSavings(saved);
  return { status: "unchanged", tokensSaved: saved };
}
```

### 2. RedundancyFilter

**Location**: `packages/core/src/services/memory/redundancy-filter.ts:228`

**When**: Automatically records savings during `mergeDuplicates()` when removing duplicate memories

```typescript
// In RedundancyFilter.mergeDuplicates()
if (removed) {
  // Record token savings before deletion
  tokenMetrics.recordRedundancyFilterSavings(removed.content);
  // ... delete memory
}
```

### 3. ContextController

**Location**: `packages/core/src/controllers/context-controller.ts:319-326`

**When**: Automatically records full request metrics at the end of `getOptimizedContext()`

```typescript
// In ContextController.getOptimizedContext()
const finalTokens = estimateTokens(finalContext, "code");
TokenMetrics.getInstance().recordContextRequest(
  rawTokens,
  finalTokens,
  tokensSavedBySessionCache,
  compressionSavings
);
```

## Metrics Breakdown

### Session Cache Savings

**Sources**:
- Reference tokens: `[CACHED: path:L1-L2]` (~8 tokens) vs full chunk (100-500 tokens)
- Diff delivery: Line-level diffs (20-100 tokens) vs full changed content (100-500 tokens)

**Typical savings**: 80-95% per cached chunk

### Redundancy Filter Savings

**Sources**:
- Duplicate memory removal (content no longer stored or delivered)

**Typical savings**: Depends on duplicate rate (5-15% of total memories in active projects)

### Compression Savings

**Sources**:
- Semantic compression of code context
- Structure-preserving token reduction

**Typical savings**: 30-50% of raw context

## Performance Characteristics

- **Recording overhead**: O(1) per operation (simple counter increments)
- **Query complexity**: O(1) for `getStats()`, O(N) for history queries
- **Memory footprint**: ~1-2KB per 100 requests (history entries)
- **History limit**: 1000 entries (automatic FIFO eviction)

## Cost Estimation

Token savings are converted to USD cost savings using GPT-4 input pricing:
- **Base rate**: $30 per 1M tokens
- **Formula**: `(totalTokensSaved / 1_000_000) × $30`

Example:
- 100K tokens saved = $3.00
- 1M tokens saved = $30.00
- 10M tokens saved = $300.00

## Testing

Run token metrics tests:

```bash
bun test packages/core/src/__tests__/token-metrics.test.ts
```

Coverage:
- ✅ 15/15 tests passing
- ✅ 100% code coverage
- ✅ All recording and query methods tested
- ✅ Time-series and aggregation validated

## Best Practices

### 1. Don't Record Manually

The system automatically records savings at all integration points. Manual recording is only needed for new optimization modules.

### 2. Query Periodically

For dashboards or monitoring, query `getStats()` periodically (e.g., every 5 minutes):

```typescript
setInterval(() => {
  const stats = TokenMetrics.getInstance().getStats();
  console.log(`Total savings: ${stats.savings.total} tokens ($${stats.estimatedCostSavings.toFixed(2)})`);
}, 5 * 60 * 1000);
```

### 3. Use History for Trends

For visualizations, use `getRecentHistory()` to show savings trends:

```typescript
const recent = TokenMetrics.getInstance().getRecentHistory(50);
const chartData = recent.map(entry => ({
  time: entry.timestamp,
  savings: entry.savings.total,
  ratio: entry.compressionRatio
}));
```

### 4. Reset Only in Tests

The `reset()` method should only be used in test setup. Production metrics should never be reset to preserve historical data.

## Future Enhancements

Potential additions (not yet implemented):

1. **Persistence**: Store metrics to disk for cross-session aggregation
2. **Alerts**: Notify when compression ratio drops below threshold
3. **Per-user metrics**: Track savings by user/project/session
4. **Export**: CSV/JSON export for external analytics
5. **Dashboards**: Web UI for real-time metrics visualization

## Related Modules

- `SessionFileCache`: packages/core/src/services/context/session-file-cache.ts
- `RedundancyFilter`: packages/core/src/services/memory/redundancy-filter.ts
- `ContextController`: packages/core/src/controllers/context-controller.ts
- `MetricsCollector`: packages/shared/dist/utils/metrics.js (for LLM usage tracking)
