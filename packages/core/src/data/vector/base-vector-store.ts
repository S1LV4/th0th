/**
 * Base Vector Store
 * 
 * Abstract base class for vector store implementations.
 * Provides shared functionality and fixes critical issues:
 * - Thread-safe lazy loading of embedding provider (fixes race condition)
 * - Common similarity/distance conversion utilities
 * - Embedding dimension discovery
 * 
 * Implementations: SQLiteVectorStore, PostgresVectorStore
 */

import { IVectorStore, SearchResult, VectorDocument, VectorStoreStats, ProjectInfo } from '@th0th-ai/shared';
import { createEmbeddingProvider, EmbeddingProvider } from '../../services/embeddings/index.js';
import { logger } from '@th0th-ai/shared';

/**
 * Base class for all vector store implementations
 * 
 * Subclasses must implement all abstract methods from IVectorStore.
 * This base class provides:
 * 1. Thread-safe embedding provider initialization
 * 2. Shared similarity calculation utilities
 * 3. Dimension discovery for dynamic schema creation
 */
export abstract class BaseVectorStore implements IVectorStore {
  /**
   * Shared promise for embedding provider initialization
   * 
   * CRITICAL: This fixes a race condition where concurrent calls to
   * getEmbeddingProvider() could create multiple provider instances.
   * By storing a single promise, all concurrent callers wait for the
   * same initialization to complete.
   * 
   * Example race condition (without this fix):
   * - Thread A calls getEmbeddingProvider() → starts initialization
   * - Thread B calls getEmbeddingProvider() → starts ANOTHER initialization
   * - Result: Two provider instances, doubled memory, potential conflicts
   * 
   * With this fix:
   * - Thread A calls getEmbeddingProvider() → creates promise, starts init
   * - Thread B calls getEmbeddingProvider() → returns same promise
   * - Result: Single provider instance shared by all callers
   */
  private embeddingProviderPromise: Promise<EmbeddingProvider> | null = null;

  /**
   * Get or create the embedding provider (thread-safe lazy loading)
   * 
   * This method ensures that only one embedding provider is created,
   * even when called concurrently from multiple contexts.
   * 
   * @returns Promise that resolves to the shared embedding provider
   */
  protected getEmbeddingProvider(): Promise<EmbeddingProvider> {
    if (!this.embeddingProviderPromise) {
      this.embeddingProviderPromise = createEmbeddingProvider({ cache: true });
    }
    return this.embeddingProviderPromise;
  }

  /**
   * Get embedding dimensions from the current provider
   * 
   * Used by PostgreSQL implementation to create schema with correct vector size.
   * Different embedding models have different dimensions:
   * - text-embedding-ada-002: 1536
   * - text-embedding-3-small: 1536
   * - text-embedding-3-large: 3072
   * - nomic-embed-text: 768
   * - all-minilm-l6-v2: 384
   * 
   * @returns Promise that resolves to the embedding dimension
   */
  protected async getEmbeddingDimensions(): Promise<number> {
    const provider = await this.getEmbeddingProvider();
    return provider.dimensions;
  }

  /**
   * Calculate cosine similarity between two vectors
   * 
   * Cosine similarity ranges from -1 to 1:
   * - 1: Vectors point in same direction (identical semantic meaning)
   * - 0: Vectors are orthogonal (no semantic relationship)
   * - -1: Vectors point in opposite directions (opposite meaning)
   * 
   * Formula: similarity = (a · b) / (||a|| * ||b||)
   * 
   * @param a First vector
   * @param b Second vector
   * @returns Similarity score (0-1 in practice, as embeddings are typically positive)
   */
  protected cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Convert pgvector cosine distance to similarity score
   * 
   * pgvector's <=> operator returns cosine distance, not similarity.
   * Distance = 1 - similarity, so we need to convert:
   * - distance 0 → similarity 1 (identical)
   * - distance 1 → similarity 0 (orthogonal)
   * - distance 2 → similarity -1 (opposite)
   * 
   * We clamp to [0, 1] for consistency with SQLite implementation.
   * 
   * @param distance Cosine distance from pgvector (0-2)
   * @returns Similarity score (0-1)
   */
  protected distanceToSimilarity(distance: number): number {
    return Math.max(0, 1 - distance);
  }

  /**
   * Convert similarity score to cosine distance
   * 
   * Inverse of distanceToSimilarity for when you need to go the other way.
   * 
   * @param similarity Similarity score (0-1)
   * @returns Cosine distance (0-2, but typically 0-1)
   */
  protected similarityToDistance(similarity: number): number {
    return 1 - similarity;
  }

  /**
   * Generate embedding for text content
   * 
   * Convenience method that wraps provider.embedQuery() with error handling.
   * 
   * @param content Text to embed
   * @returns Promise that resolves to embedding vector
   */
  protected async embedContent(content: string): Promise<number[]> {
    try {
      const provider = await this.getEmbeddingProvider();
      return await provider.embedQuery(content);
    } catch (error) {
      logger.error('Failed to generate embedding', error as Error, { content: content.slice(0, 100) });
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts (batched)
   * 
   * More efficient than calling embedQuery() in a loop.
   * Uses the provider's batch API if available.
   * 
   * @param contents Array of texts to embed
   * @returns Promise that resolves to array of embedding vectors
   */
  protected async embedBatch(contents: string[]): Promise<number[][]> {
    try {
      const provider = await this.getEmbeddingProvider();
      return await provider.embedBatch(contents);
    } catch (error) {
      logger.error('Failed to generate batch embeddings', error as Error, { count: contents.length });
      throw error;
    }
  }

  // Abstract methods - must be implemented by subclasses

  abstract addDocument(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  abstract addDocuments(documents: VectorDocument[]): Promise<void>;
  abstract search(query: string, limit?: number, projectId?: string): Promise<SearchResult[]>;
  abstract searchByEmbedding(embedding: number[], limit?: number, projectId?: string): Promise<SearchResult[]>;
  abstract delete(id: string): Promise<boolean>;
  abstract deleteByProject(projectId: string): Promise<number>;
  abstract update(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  abstract getCollection(name: string): Promise<any>; // IVectorCollection
  abstract getStats(projectId?: string): Promise<VectorStoreStats>;
  abstract listProjects(): Promise<ProjectInfo[]>;
  abstract healthCheck(): Promise<boolean>;
  abstract close(): Promise<void>;
}
