/**
 * Memory Repository Factory
 * 
 * Returns PostgreSQL MemoryRepository implementation
 */

import { logger } from "@th0th-ai/shared";
import { MemoryRepositoryPg } from "./memory-repository-pg.js";

export function getMemoryRepository(): MemoryRepositoryPg {
  logger.info("Using PostgreSQL MemoryRepository");
  return MemoryRepositoryPg.getInstance();
}
