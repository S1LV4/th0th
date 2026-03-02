/**
 * Memory services barrel exports.
 *
 * Redundancy filtering and semantic clustering for memory quality.
 */

export { RedundancyFilter } from "./redundancy-filter.js";
export type { DuplicatePair, MergeResult, CleanupStats } from "./redundancy-filter.js";

export { MemoryClustering } from "./memory-clustering.js";
export type { MemoryCluster, ClusteringResult } from "./memory-clustering.js";

export { MemoryService } from "./memory-service.js";
export type { Memory, ScoredMemory } from "./memory-service.js";
