/**
 * Graph Store Factory
 *
 * Provides unified graph store implementation based on database configuration.
 */

import { GraphStore } from "./graph-store.js";
import { GraphStorePg } from "./graph-store-pg.js";
import { logger } from "@th0th-ai/shared";

let cachedStore: GraphStore | GraphStorePg | null = null;

export function getGraphStore(): GraphStore | GraphStorePg {
  if (cachedStore) return cachedStore;
  
  const dbType = process.env.DATABASE_URL?.startsWith('postgresql') ? 'postgres' : 'sqlite';
  
  if (dbType === 'postgres') {
    cachedStore = GraphStorePg.getInstance();
    logger.info('Using PostgreSQL graph store');
  } else {
    cachedStore = GraphStore.getInstance();
    logger.info('Using SQLite graph store');
  }
  
  return cachedStore;
}

export async function resetGraphStore(): Promise<void> {
  if (cachedStore) {
    if ('clear' in cachedStore) {
      await cachedStore.clear();
    }
    cachedStore = null;
  }
}
