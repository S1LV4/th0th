/**
 * @th0th-ai/core - Lógica de negócio do th0th
 *
 * Contém tools, controllers, services, data e models
 * independente do protocolo de transporte (MCP, HTTP, etc.)
 *
 * Architecture (4 layers):
 *   tools/        → Thin MCP handlers (schema + delegation)
 *   controllers/  → Orchestration (composes services, side-effects)
 *   services/     → Domain logic (scoring, embedding, graph)
 *   data/         → Persistence (SQLite, FTS, migrations)
 */

// Tools
export * from "./tools/index.js";

// Controllers
export * from "./controllers/index.js";

// Services
export * from "./services/index.js";

// Data
export { MemoryRepository } from "./data/memory/memory-repository.js";
export type {
  MemoryRow,
  InsertMemoryInput,
  SearchFilters,
} from "./data/memory/memory-repository.js";
export { getVectorStore, resetVectorStore } from "./data/vector/index.js";
export { SQLiteVectorStore } from "./data/vector/index.js";

// Re-export types from shared for convenience
export type { ToolResponse, IToolHandler } from "@th0th-ai/shared";
