/**
 * Prisma Client Singleton
 * Fornece uma instância única do PrismaClient configurada com o adapter correto
 */

import { PrismaClient } from "../../generated/prisma/index.js";
import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
import { config } from "@th0th-ai/shared";
import path from "path";

let prismaInstance: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    const dataDir = config.get("dataDir");
    const th0thDbPath = path.join(dataDir, "th0th.db");

    const adapter = new PrismaBunSqlite({
      url: `file:${th0thDbPath}`,
      safeIntegers: true,
    });

    prismaInstance = new PrismaClient({ adapter });
  }

  return prismaInstance;
}

export async function disconnectPrisma() {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
}
