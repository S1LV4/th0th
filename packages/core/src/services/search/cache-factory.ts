/**
 * Cache Factory
 *
 * Provides unified cache implementation based on database configuration.
 */

import { SearchCache } from './search-cache.js';
import { SearchCachePg } from './search-cache-pg.js';
import { logger } from '@th0th-ai/shared';

let cachedCache: SearchCache | SearchCachePg | null = null;

export function getSearchCache(): SearchCache | SearchCachePg {
  if (cachedCache) return cachedCache;
  
  const dbType = process.env.DATABASE_URL?.startsWith('postgresql') ? 'postgres' : 'sqlite';
  
  if (dbType === 'postgres') {
    cachedCache = new SearchCachePg();
    logger.info('Using PostgreSQL search cache');
  } else {
    cachedCache = new SearchCache();
    logger.info('Using SQLite search cache');
  }
  
  return cachedCache;
}

export async function resetSearchCache(): Promise<void> {
  if (cachedCache) {
    await cachedCache.clear();
    cachedCache = null;
  }
}
