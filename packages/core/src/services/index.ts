/**
 * @th0th/core - Services Export
 */

// Search
export { ContextualSearchRLM } from "./search/contextual-search-rlm.js";
export { SearchCache } from "./search/search-cache.js";
export { SearchAnalytics } from "./search/search-analytics.js";
export { SearchCacheWarmup } from "./search/search-warmup.js";
export { IndexManager } from "./search/index-manager.js";

// Cache
export { CacheManager } from "./cache/cache-manager.js";
export { L1MemoryCache } from "./cache/l1-memory-cache.js";
export { L2SQLiteCache } from "./cache/l2-sqlite-cache.js";
export { EmbeddingCache } from "./cache/embedding-cache.js";

// Compression
export { CodeCompressor } from "./compression/code-compressor.js";

// Embeddings
export {
  createEmbeddingProvider,
  checkProviderAvailability,
} from "./embeddings/index.js";
export type { EmbeddingProvider } from "./embeddings/provider.js";

// Health (local-first)
export {
  LocalHealthChecker,
  getHealthChecker,
} from "./health/local-health-checker.js";
export type {
  LocalHealthReport,
  ServiceStatus,
} from "./health/local-health-checker.js";

// Pricing (local-first with cache)
export {
  ModelsDevClient,
  getModelsDevClient,
} from "./pricing/models-dev-client.js";
export type { ModelPricing } from "./pricing/models-dev-client.js";

// Graph (knowledge graph over memories)
export { MemoryGraphService } from "./graph/memory-graph.service.js";
export { GraphStore } from "./graph/graph-store.js";
export { GraphQueries } from "./graph/graph-queries.js";
export { RelationExtractor } from "./graph/relation-extractor.js";
export type {
  MemoryRow as GraphMemoryRow,
  MemoryRowWithEmbedding,
  RelatedMemory,
} from "./graph/types.js";

// Memory (domain service + quality)
export { MemoryService } from "./memory/memory-service.js";
export type { Memory, ScoredMemory } from "./memory/memory-service.js";
export { RedundancyFilter } from "./memory/redundancy-filter.js";
export type { DuplicatePair, MergeResult, CleanupStats } from "./memory/redundancy-filter.js";
export { MemoryClustering } from "./memory/memory-clustering.js";
export type { MemoryCluster, ClusteringResult } from "./memory/memory-clustering.js";

// Checkpoint (task state persistence)
export { CheckpointManager } from "./checkpoint/checkpoint-manager.js";
export { AutoCheckpointer } from "./checkpoint/auto-checkpointer.js";
export type { AutoCheckpointerOptions, CheckpointTrigger } from "./checkpoint/auto-checkpointer.js";
