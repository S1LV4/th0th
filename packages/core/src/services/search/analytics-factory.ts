/**
 * Search Analytics Factory
 *
 * Provides unified analytics implementation based on database configuration.
 */

import { SearchAnalytics } from "./search-analytics.js";
import { SearchAnalyticsPg } from "./search-analytics-pg.js";
import { logger } from "@th0th-ai/shared";

let cachedAnalytics: SearchAnalytics | SearchAnalyticsPg | null = null;

export function getSearchAnalytics(): SearchAnalytics | SearchAnalyticsPg {
  if (cachedAnalytics) return cachedAnalytics;
  
  const dbType = process.env.DATABASE_URL?.startsWith('postgresql') ? 'postgres' : 'sqlite';
  
  if (dbType === 'postgres') {
    cachedAnalytics = new SearchAnalyticsPg();
    logger.info('Using PostgreSQL search analytics');
  } else {
    cachedAnalytics = new SearchAnalytics();
    logger.info('Using SQLite search analytics');
  }
  
  return cachedAnalytics;
}

export async function resetSearchAnalytics(): Promise<void> {
  if (cachedAnalytics) {
    if ('close' in cachedAnalytics) {
      await cachedAnalytics.close();
    }
    cachedAnalytics = null;
  }
}
