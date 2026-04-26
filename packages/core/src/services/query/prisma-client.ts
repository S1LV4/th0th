/**
 * Prisma Client Singleton
 * Fornece uma instância única do PrismaClient configurada com o adapter correto
 */

import { config, logger } from "@th0th-ai/shared";
import path from "path";
import { PrismaClient } from "../../generated/prisma/index.js";

let prismaInstance: PrismaClient | null = null;
let prismaPool: import("pg").Pool | null = null;

/**
 * @internal
 */
export const _adapters = {
  loadPg(): typeof import('pg') {
    return require('pg') as typeof import('pg');
  },
  loadPrismaPg(): typeof import('@prisma/adapter-pg') {
    return require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg');
  },
  loadPrismaBunSqlite(): typeof import('prisma-adapter-bun-sqlite') {
    return require('prisma-adapter-bun-sqlite') as typeof import('prisma-adapter-bun-sqlite');
  },
};

/** @internal — resets the singleton; call in afterEach during unit tests only */
export function _resetPrismaForTesting(): void {
  prismaInstance = null;
  prismaPool = null;
}

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    const databaseUrl = process.env.DATABASE_URL;

    // Check if using PostgreSQL or SQLite
    const isPostgres = databaseUrl?.startsWith("postgres");

    if (isPostgres) {
      let pool: import('pg').Pool;
      let PrismaPg: typeof import('@prisma/adapter-pg').PrismaPg;
      try {
        const pg = _adapters.loadPg();
        const adapterPg = _adapters.loadPrismaPg();
        pool = new pg.Pool({
          connectionString: databaseUrl,
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });
        pool.on("error", (err) => {
          logger.error("Unexpected PG pool error", err as Error);
        });
        PrismaPg = adapterPg.PrismaPg;
      } catch (e) {
        throw new Error(
          'pg or @prisma/adapter-pg is required for PostgreSQL mode but could not be loaded. Run: bun add pg @prisma/adapter-pg'
        );
      }
      prismaPool = pool;
      const adapter = new PrismaPg(pool as any);
      prismaInstance = new PrismaClient({ adapter });
      logger.info("Prisma Client initialized with PostgreSQL (pg adapter)");
    } else {
      let PrismaBunSqlite: typeof import('prisma-adapter-bun-sqlite').PrismaBunSqlite;
      try {
        const bunAdapter = _adapters.loadPrismaBunSqlite();
        PrismaBunSqlite = bunAdapter.PrismaBunSqlite;
      } catch (e) {
        throw new Error(
          'prisma-adapter-bun-sqlite is required for SQLite mode but could not be loaded. Run: bun add prisma-adapter-bun-sqlite'
        );
      }
      const dataDir = config.get("dataDir");
      const th0thDbPath = path.join(dataDir, "th0th.db");

      const adapter = new PrismaBunSqlite({
        url: `file:${th0thDbPath}`,
        safeIntegers: true,
      });

      prismaInstance = new PrismaClient({ adapter });
      logger.info("Prisma Client initialized with SQLite (Bun adapter)");
    }
  }

  return prismaInstance;
}

export async function disconnectPrisma() {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
  if (prismaPool) {
    await prismaPool.end();
    prismaPool = null;
  }
}
