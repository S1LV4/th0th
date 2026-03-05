/**
 * Advanced Context Search Service
 * 
 * Multi-strategy context retrieval combining:
 * - Semantic search (vector similarity)
 * - Keyword search (BM25/FTS)
 * - Hybrid fusion (RRF - Reciprocal Rank Fusion)
 * - Caching layer for performance
 * 
 * Following RLM best practices for context window optimization
 */

import { logger } from '@th0th-ai/shared';
import { getModelsDevClient } from '../pricing/models-dev-client.js';

export interface SearchResult {
  content: string;
  source: string;
  score: number;
  metadata?: Record<string, any>;
}

export interface SearchOptions {
  query: string;
  maxResults?: number;
  minScore?: number;
  strategies?: ('semantic' | 'keyword' | 'hybrid')[];
  filters?: {
    source?: string[];
    dateRange?: { start: Date; end: Date };
    tags?: string[];
  };
}

export interface HybridSearchResult {
  results: SearchResult[];
  metadata: {
    totalResults: number;
    semanticResults: number;
    keywordResults: number;
    latency: number;
    cacheHit: boolean;
  };
}

/**
 * Advanced Context Search implementing RLM best practices
 */
export class AdvancedContextSearch {
  private cache: Map<string, { results: SearchResult[]; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private modelsDevClient = getModelsDevClient();

  /**
   * Perform hybrid search combining semantic and keyword approaches
   */
  async search(options: SearchOptions): Promise<HybridSearchResult> {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(options);
    
    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      logger.debug('Cache hit for search query', { query: options.query });
      return {
        results: cached.results,
        metadata: {
          totalResults: cached.results.length,
          semanticResults: 0,
          keywordResults: 0,
          latency: Date.now() - startTime,
          cacheHit: true,
        },
      };
    }

    const strategies = options.strategies || ['hybrid'];
    const allResults: SearchResult[] = [];
    let semanticCount = 0;
    let keywordCount = 0;

    // Semantic search (vector similarity)
    if (strategies.includes('semantic') || strategies.includes('hybrid')) {
      const semanticResults = await this.semanticSearch(options);
      allResults.push(...semanticResults);
      semanticCount = semanticResults.length;
    }

    // Keyword search (BM25/FTS)
    if (strategies.includes('keyword') || strategies.includes('hybrid')) {
      const keywordResults = await this.keywordSearch(options);
      allResults.push(...keywordResults);
      keywordCount = keywordResults.length;
    }

    // Apply RRF fusion for hybrid results
    let finalResults: SearchResult[];
    if (strategies.includes('hybrid') && allResults.length > 0) {
      finalResults = this.reciprocalRankFusion(allResults, options.maxResults || 10);
    } else {
      finalResults = this.deduplicateAndRank(allResults, options.maxResults || 10);
    }

    // Apply filters
    finalResults = this.applyFilters(finalResults, options.filters);

    // Apply minimum score threshold
    const minScore = options.minScore || 0.3;
    finalResults = finalResults.filter(r => r.score >= minScore);

    // Cache results
    this.cache.set(cacheKey, { results: finalResults, timestamp: Date.now() });

    const latency = Date.now() - startTime;
    logger.info('Search completed', {
      query: options.query,
      totalResults: finalResults.length,
      latency,
      cacheHit: false,
    });

    return {
      results: finalResults,
      metadata: {
        totalResults: finalResults.length,
        semanticResults: semanticCount,
        keywordResults: keywordCount,
        latency,
        cacheHit: false,
      },
    };
  }

  /**
   * Semantic search using vector similarity
   * Stub implementation - would use ChromaDB in production
   */
  private async semanticSearch(options: SearchOptions): Promise<SearchResult[]> {
    // In production: query ChromaDB with embeddings
    // For now: return mock results based on query similarity
    logger.debug('Performing semantic search', { query: options.query });
    
    // Mock implementation - would be replaced with actual vector search
    return [
      {
        content: `[Semantic] Related context for: ${options.query}`,
        source: 'vector-store',
        score: 0.85,
        metadata: { type: 'semantic' },
      },
    ];
  }

  /**
   * Keyword search using BM25/FTS
   * Stub implementation - would use SQLite FTS5 in production
   */
  private async keywordSearch(options: SearchOptions): Promise<SearchResult[]> {
    logger.debug('Performing keyword search', { query: options.query });
    
    // Mock implementation - would be replaced with actual FTS search
    return [
      {
        content: `[Keyword] Matches for: ${options.query}`,
        source: 'keyword-index',
        score: 0.75,
        metadata: { type: 'keyword' },
      },
    ];
  }

  /**
   * Reciprocal Rank Fusion (RRF) for combining search results
   * RLM best practice: k=60 provides good balance
   */
  private reciprocalRankFusion(results: SearchResult[], k: number = 60, maxResults: number = 10): SearchResult[] {
    const scores = new Map<string, number>();
    const items = new Map<string, SearchResult>();

    // Group by content to deduplicate
    results.forEach((result, index) => {
      const key = result.content.slice(0, 100); // Use first 100 chars as key
      const rank = index + 1;
      const rrfScore = 1 / (k + rank);
      
      scores.set(key, (scores.get(key) || 0) + rrfScore);
      if (!items.has(key)) {
        items.set(key, result);
      }
    });

    // Sort by RRF score
    const sorted = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxResults);

    return sorted.map(([key, score]) => ({
      ...items.get(key)!,
      score,
    }));
  }

  /**
   * Deduplicate and rank results by score
   */
  private deduplicateAndRank(results: SearchResult[], maxResults: number): SearchResult[] {
    const seen = new Set<string>();
    return results
      .filter(r => {
        const key = r.content.slice(0, 100);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Apply filters to search results
   */
  private applyFilters(results: SearchResult[], filters?: SearchOptions['filters']): SearchResult[] {
    if (!filters) return results;

    return results.filter(r => {
      // Source filter
      if (filters.source && filters.source.length > 0) {
        if (!filters.source.includes(r.source)) return false;
      }

      // Date range filter
      if (filters.dateRange && r.metadata?.date) {
        const date = new Date(r.metadata.date);
        if (date < filters.dateRange.start || date > filters.dateRange.end) {
          return false;
        }
      }

      // Tags filter
      if (filters.tags && filters.tags.length > 0) {
        const itemTags = r.metadata?.tags || [];
        if (!filters.tags.some(tag => itemTags.includes(tag))) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Generate cache key for search query
   */
  private generateCacheKey(options: SearchOptions): string {
    return JSON.stringify({
      q: options.query,
      s: options.strategies?.sort(),
      f: options.filters,
    });
  }

  /**
   * Clear search cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('Search cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; hitRate: number } {
    return {
      size: this.cache.size,
      hitRate: 0, // Would track actual hit rate in production
    };
  }
}

// Singleton instance
let instance: AdvancedContextSearch | null = null;

export function getAdvancedContextSearch(): AdvancedContextSearch {
  if (!instance) {
    instance = new AdvancedContextSearch();
  }
  return instance;
}
