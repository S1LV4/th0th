/**
 * Prisma Client Singleton
 * Fornece uma instância única do PrismaClient configurada com o adapter correto
 */

import { config, logger } from "@th0th-ai/shared";
import path from "path";
import { PrismaClient } from "../../generated/prisma/index.js";

let prismaInstance: PrismaClient | null = null;
let prismaPool: import("pg").Pool | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    const databaseUrl = process.env.DATABASE_URL;

    // Check if using PostgreSQL or SQLite
    const isPostgres = databaseUrl?.startsWith("postgres");

    if (isPostgres) {
      // Bun supports require() in ESM modules as a synchronous dynamic import.
      // We use it here intentionally: getPrismaClient() is called synchronously
      // at module init time in many places, making async import() impractical.
      // This is Bun-specific and will not work in vanilla Node.js ESM.
      let pool: import("pg").Pool;
      let PrismaPg: typeof import("@prisma/adapter-pg").PrismaPg;
      try {
        const pg = require("pg") as typeof import("pg");
        const adapterPg =
          require("@prisma/adapter-pg") as typeof import("@prisma/adapter-pg");
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
        logger.error(
          "pg or @prisma/adapter-pg not available for PostgreSQL Prisma client",
          e as Error,
        );
        throw new Error(
          'Prisma PostgreSQL adapter is unavailable. Install optional dependency "pg" and ensure "@prisma/adapter-pg" is available.',
        );
      }
      prismaPool = pool;
      const adapter = new PrismaPg(pool as any);
      prismaInstance = new PrismaClient({ adapter });
      logger.info("Prisma Client initialized with PostgreSQL (pg adapter)");
    } else {
      // Same pattern: synchronous require() for Bun ESM compatibility.
      let PrismaBunSqlite: typeof import("prisma-adapter-bun-sqlite").PrismaBunSqlite;
      try {
        const bunAdapter =
          require("prisma-adapter-bun-sqlite") as typeof import("prisma-adapter-bun-sqlite");
        PrismaBunSqlite = bunAdapter.PrismaBunSqlite;
      } catch (e) {
        logger.error(
          "prisma-adapter-bun-sqlite not available for SQLite Prisma client",
          e as Error,
        );
        throw new Error(
          'Prisma SQLite adapter is unavailable. Install dependency "prisma-adapter-bun-sqlite".',
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
