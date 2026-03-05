/**
 * @th0th-ai/core - Controllers Export
 *
 * Orchestration layer between tools (thin MCP handlers) and
 * services/data (domain logic + persistence).
 */

export { MemoryController } from "./memory-controller.js";
export type {
  StoreMemoryInput,
  StoreMemoryResult,
  SearchMemoryInput,
  SearchMemoryResult,
} from "./memory-controller.js";

export { SearchController } from "./search-controller.js";
export type {
  ProjectSearchInput,
  ProjectSearchResult,
} from "./search-controller.js";

export { ContextController } from "./context-controller.js";
export type {
  GetOptimizedContextInput,
  OptimizedContextResult,
} from "./context-controller.js";
