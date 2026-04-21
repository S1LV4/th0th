/**
 * Symbol Repository Factory
 *
 * Always returns the PostgreSQL implementation.
 */

import { symbolRepositoryPg, SymbolRepositoryPg } from "./symbol-repository-pg.js";

export function getSymbolRepository(): SymbolRepositoryPg {
  return symbolRepositoryPg;
}

export async function resetSymbolRepository(): Promise<void> {
  // No-op: connection managed by singleton PrismaClient
}
