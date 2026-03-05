/**
 * Hybrid Search
 *
 * Combines vector search (semantic) with keyword search (lexical)
 * using Reciprocal Rank Fusion (RRF) for reranking
 */

import { IHybridSearch } from '@th0th-ai/shared';
import { SearchResult, RetrievalOptions } from '@th0th-ai/shared';
import { VectorStore } from '../chromadb/vector-store.js';
import { KeywordSearch } from '../sqlite/keyword-search.js';
import { logger } from '@th0th-ai/shared';

/**
 * Reciprocal Rank Fusion constant
 * Higher k = more smoothing (less impact of exact rank position)
 */
const RRF_K = 60;

/**
 * Hybrid Search implementation
 */
export class HybridSearch implements IHybridSearch {
  private vectorStore: VectorStore;
  private keywordSearch: KeywordSearch;

  constructor() {
    this.vectorStore = new VectorStore();
    this.keywordSearch = new KeywordSearch();

    logger.info('Hybrid Search initialized');
  }

  /**
   * Search using both vector and keyword search
   */
  async search(query: string, options: RetrievalOptions): Promise<SearchResult[]> {
    const maxResults = options.maxResults || 10;
    const minScore = options.minScore || 0;

    try {
      logger.debug('Starting hybrid search', {
        query: query.slice(0, 50),
        maxResults
      });

      // Execute searches in parallel (2x results to have buffer for fusion)
      const [vectorResults, keywordResults] = await Promise.all([
        this.vectorStore.search(query, maxResults * 2),
        this.keywordSearch.search(query, maxResults * 2)
      ]);

      logger.debug('Search results retrieved', {
        vectorCount: vectorResults.length,
        keywordCount: keywordResults.length
      });

      // Combine and rerank using RRF
      const fusedResults = this.rerank([vectorResults, keywordResults]);

      // Filter by minimum score and limit
      const filtered = fusedResults
        .filter(result => result.score >= minScore)
        .slice(0, maxResults);

      logger.info('Hybrid search completed', {
        totalResults: filtered.length,
        avgScore: this.calculateAvgScore(filtered)
      });

      return filtered;

    } catch (error) {
      logger.error('Hybrid search failed', error as Error, { query });
      return [];
    }
  }

  /**
   * Rerank results using Reciprocal Rank Fusion (RRF)
   *
   * RRF formula: score(d) = Σ 1 / (k + rank(d))
   * where k is a constant (typically 60) and rank is the position in each list
   */
  rerank(resultSets: SearchResult[][]): SearchResult[] {
    const scoreMap = new Map<string, { result: SearchResult; rrfScore: number }>();

    // Calculate RRF score for each result
    for (const results of resultSets) {
      results.forEach((result, rank) => {
        const rrfScore = 1 / (RRF_K + rank + 1); // +1 because rank is 0-indexed

        if (scoreMap.has(result.id)) {
          // Result appears in multiple lists - accumulate scores
          const existing = scoreMap.get(result.id)!;
          existing.rrfScore += rrfScore;
        } else {
          // First time seeing this result
          scoreMap.set(result.id, {
            result: { ...result },
            rrfScore
          });
        }
      });
    }

    // Sort entries by RRF score descending
    const sorted = Array.from(scoreMap.values()).sort(
      (a, b) => b.rrfScore - a.rrfScore,
    );

    // Normalize all scores in a single pass using the observed max
    const normalizedMap = this.normalizeRRFScores(
      sorted.map(({ result, rrfScore }) => ({ id: result.id, rrfScore })),
    );

    const reranked = sorted.map(({ result }) => ({
      ...result,
      score: normalizedMap.get(result.id) ?? 0,
    }));

    logger.debug('Results reranked using RRF', {
      uniqueResults: reranked.length,
      topScore: reranked[0]?.score
    });

    return reranked;
  }

  /**
   * Normalize RRF scores to 0-1 range using the actual max in the result set.
   *
   * The theoretical max per result per list is 1/(k+1). With N lists the
   * absolute ceiling is N/(k+1). But actual maxima vary, so we use the
   * observed max to give the best-ranked result a score of 1 and scale
   * everything else relative to it. Falls back to the theoretical ceiling
   * when all scores are equal (e.g. single-result sets).
   */
  private normalizeRRFScores(values: { id: string; rrfScore: number }[]): Map<string, number> {
    if (values.length === 0) return new Map();

    const maxRRF = Math.max(...values.map((v) => v.rrfScore));
    // Theoretical max for k=60 with 2 lists
    const theoreticalMax = 2 / (RRF_K + 1);
    const divisor = maxRRF > 0 ? maxRRF : theoreticalMax;

    return new Map(values.map((v) => [v.id, Math.min(1, v.rrfScore / divisor)]));
  }

  /**
   * @deprecated Use normalizeRRFScores (batch) instead
   */
  private normalizeRRFScore(rrfScore: number): number {
    // Kept for backwards compatibility; single-value path.
    const theoreticalMax = 2 / (RRF_K + 1);
    return Math.min(1, rrfScore / theoreticalMax);
  }

  /**
   * Calculate average score
   */
  private calculateAvgScore(results: SearchResult[]): number {
    if (results.length === 0) return 0;
    const sum = results.reduce((acc, r) => acc + r.score, 0);
    return sum / results.length;
  }

  /**
   * Search with custom weights for vector vs keyword
   */
  async searchWeighted(
    query: string,
    options: RetrievalOptions,
    weights: { vector: number; keyword: number } = { vector: 0.7, keyword: 0.3 }
  ): Promise<SearchResult[]> {
    const maxResults = options.maxResults || 10;

    try {
      // Get results from both sources
      const [vectorResults, keywordResults] = await Promise.all([
        this.vectorStore.search(query, maxResults * 2),
        this.keywordSearch.search(query, maxResults * 2)
      ]);

      // Apply weights to scores
      const weightedVector = vectorResults.map(r => ({
        ...r,
        score: r.score * weights.vector
      }));

      const weightedKeyword = keywordResults.map(r => ({
        ...r,
        score: r.score * weights.keyword
      }));

      // Combine by ID, summing weighted scores
      const combined = new Map<string, SearchResult>();

      for (const result of [...weightedVector, ...weightedKeyword]) {
        if (combined.has(result.id)) {
          const existing = combined.get(result.id)!;
          existing.score += result.score;
        } else {
          combined.set(result.id, { ...result });
        }
      }

      // Sort and limit
      const sorted = Array.from(combined.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      logger.debug('Weighted hybrid search completed', {
        weights,
        resultsCount: sorted.length
      });

      return sorted;

    } catch (error) {
      logger.error('Weighted hybrid search failed', error as Error);
      return [];
    }
  }

  /**
   * Search with boost for specific sources
   */
  async searchWithBoost(
    query: string,
    options: RetrievalOptions,
    boosts: { recency?: number; popularity?: number } = {}
  ): Promise<SearchResult[]> {
    const results = await this.search(query, options);

    // Apply boosts based on metadata
    const boosted = results.map(result => {
      let boostFactor = 1.0;

      // Recency boost (newer items score higher)
      if (boosts.recency && result.metadata?.createdAt) {
        const createdAt = result.metadata.createdAt as any;
        const ageInDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
        boostFactor *= Math.max(0.5, 1 - (ageInDays / 365) * boosts.recency);
      }

      // Popularity boost (frequently accessed items score higher)
      if (boosts.popularity && result.metadata?.accessCount) {
        const accessCount = result.metadata.accessCount as number;
        boostFactor *= 1 + (Math.log(accessCount + 1) / 10) * boosts.popularity;
      }

      return {
        ...result,
        score: Math.min(1, result.score * boostFactor)
      };
    });

    // Re-sort after boosting
    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Diversify results to reduce redundancy
   */
  diversifyResults(
    results: SearchResult[],
    maxSimilarityThreshold: number = 0.85
  ): SearchResult[] {
    if (results.length === 0) return results;

    const diversified: SearchResult[] = [results[0]]; // Always include top result

    for (let i = 1; i < results.length; i++) {
      const candidate = results[i];

      // Check if candidate is too similar to any already selected result
      const isTooSimilar = diversified.some(selected => {
        return this.calculateContentSimilarity(selected.content, candidate.content)
          > maxSimilarityThreshold;
      });

      if (!isTooSimilar) {
        diversified.push(candidate);
      }
    }

    logger.debug('Results diversified', {
      original: results.length,
      diversified: diversified.length
    });

    return diversified;
  }

  /**
   * Calculate simple content similarity (Jaccard similarity of words)
   */
  private calculateContentSimilarity(content1: string, content2: string): number {
    const words1 = new Set(content1.toLowerCase().split(/\s+/));
    const words2 = new Set(content2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }
}
