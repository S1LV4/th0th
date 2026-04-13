/**
 * Keyword Search Factory
 *
 * Provides unified keyword search implementation based on database configuration.
 */

import { KeywordSearch } from "./keyword-search.js";
import { KeywordSearchPg } from "./keyword-search-pg.js";
import { logger } from "@th0th-ai/shared";

let cachedSearch: KeywordSearch | KeywordSearchPg | null = null;

export function getKeywordSearch(): KeywordSearch | KeywordSearchPg {
  if (cachedSearch) return cachedSearch;
  
  const dbType = process.env.DATABASE_URL?.startsWith('postgresql') ? 'postgres' : 'sqlite';
  
  if (dbType === 'postgres') {
    cachedSearch = new KeywordSearchPg();
    logger.info('Using PostgreSQL keyword search');
  } else {
    cachedSearch = new KeywordSearch();
    logger.info('Using SQLite keyword search');
  }
  
  return cachedSearch;
}

export async function resetKeywordSearch(): Promise<void> {
  if (cachedSearch) {
    if ('close' in cachedSearch) {
      await cachedSearch.close();
    }
    cachedSearch = null;
  }
}
