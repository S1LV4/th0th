/**
 * Symbol Repository Factory
 *
 * Selects PostgreSQL only when DATABASE_URL points to Postgres.
 * Defaults to SQLite for local-first mode.
 */

import { logger } from "@th0th-ai/shared";
import { SymbolRepositoryPg } from "./symbol-repository-pg.js";
import { symbolRepository, SymbolRepository } from "./symbol-repository.js";

export function getSymbolRepository(): SymbolRepositoryPg | SymbolRepository {
  const databaseUrl = process.env.DATABASE_URL;
  const isPostgres =
    databaseUrl?.startsWith("postgresql://") ||
    databaseUrl?.startsWith("postgres://");

  if (isPostgres) {
    return SymbolRepositoryPg.getInstance();
  }

  logger.debug(
    "Using SQLite SymbolRepository (DATABASE_URL not set to postgres)",
  );
  return symbolRepository;
}

export async function resetSymbolRepository(): Promise<void> {
  // No-op: connection managed by singleton PrismaClient
}
