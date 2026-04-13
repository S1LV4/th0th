/**
 * Core Interfaces for Service Layer
 * 
 * Defines contracts between different architectural layers
 * following the Repository and Strategy patterns
 */

import {
  Memory,
  CacheEntry,
  SearchResult,
  RetrievalOptions,
  StorageOptions,
  CompressedContent,
  CompressionStrategy,
  ToolResponse
} from './index.js';

/**
 * Memory Repository Interface
 * 
 * Abstracts storage operations across different backends
 */
export interface IMemoryRepository {
  store(memory: Memory, options: StorageOptions): Promise<void>;
  retrieve(id: string): Promise<Memory | null>;
  search(query: string, options: RetrievalOptions): Promise<SearchResult[]>;
  delete(id: string): Promise<boolean>;
  update(id: string, updates: Partial<Memory>): Promise<Memory>;
  list(filters: MemoryFilters): Promise<Memory[]>;
}

/**
 * Memory Filters
 */
export interface MemoryFilters {
  userId?: string;
  sessionId?: string;
  projectId?: string;
  types?: string[];
  levels?: number[];
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Cache Manager Interface
 * 
 * Manages hierarchical cache (L1, L2, L3)
 */
export interface ICacheManager {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(pattern?: string): Promise<void>;
  has(key: string): Promise<boolean>;
  invalidate(pattern: string): Promise<number>; // returns count
  getStats(): Promise<CacheStats>;
}

/**
 * Cache Statistics
 */
export interface CacheStats {
  l1: {
    hits: number;
    misses: number;
    size: number;
    entries: number;
  };
  l2: {
    hits: number;
    misses: number;
    size: number;
    entries: number;
  };
  l3: {
    hits: number;
    misses: number;
    entries: number;
  };
  totalHitRate: number;
}

/**
 * Compressor Interface
 * 
 * Strategy pattern for different compression approaches
 */
export interface ICompressor {
  compress(content: string, strategy?: CompressionStrategy): Promise<CompressedContent>;
  decompress(compressed: CompressedContent): Promise<string>;
  estimateCompression(content: string): Promise<number>; // ratio
  getStrategy(): CompressionStrategy;
}

/**
 * Vector Store Interface
 * 
 * Abstracts vector database operations (SQLite, PostgreSQL+pgvector)
 * Supports multiple backend implementations with consistent API.
 */
export interface IVectorStore {
  // Core document operations
  addDocument(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  addDocuments(documents: VectorDocument[]): Promise<void>;
  update(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteByProject(projectId: string): Promise<number>;
  
  // Search operations
  search(query: string, limit?: number, projectId?: string): Promise<SearchResult[]>;
  searchByEmbedding(embedding: number[], limit?: number, projectId?: string): Promise<SearchResult[]>;
  
  // Collection management
  getCollection(name: string): Promise<IVectorCollection>;
  
  // Statistics and metadata
  getStats(projectId?: string): Promise<VectorStoreStats>;
  listProjects(): Promise<ProjectInfo[]>;
  
  // Health and lifecycle
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Vector Store Statistics
 */
export interface VectorStoreStats {
  totalDocuments: number;
  totalSize: number;
  embeddingDimensions?: number;  // For validation (e.g., PostgreSQL schema vs provider)
  indexType?: string;            // 'none' | 'hnsw' | 'ivfflat'
  indexStatus?: 'building' | 'ready' | 'stale' | 'none';
}

/**
 * Project Information
 */
export interface ProjectInfo {
  projectId: string;
  projectPath: string | null;
  documentCount: number;
  totalSize: number;
  lastIndexed: string | null;
}

/**
 * Vector Collection Interface
 */
export interface IVectorCollection {
  name: string;
  count(): Promise<number>;
  query(params: VectorQueryParams): Promise<SearchResult[]>;
  add(documents: VectorDocument[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
}

/**
 * Vector Query Parameters
 */
export interface VectorQueryParams {
  queryEmbeddings?: number[][];
  queryTexts?: string[];
  nResults?: number;
  where?: Record<string, unknown>;
  whereDocument?: Record<string, unknown>;
}

/**
 * Vector Document
 */
export interface VectorDocument {
  id: string;
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

/**
 * Keyword Search Interface
 * 
 * SQLite FTS5 operations
 */
export interface IKeywordSearch {
  index(id: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  search(query: string, limit?: number): Promise<SearchResult[]>;
  delete(id: string): Promise<boolean>;
  update(id: string, content: string): Promise<void>;
}

/**
 * Hybrid Search Interface
 * 
 * Combines vector + keyword search
 */
export interface IHybridSearch {
  search(query: string, options: RetrievalOptions): Promise<SearchResult[]>;
  rerank(resultSets: SearchResult[][]): SearchResult[];
}

/**
 * Embedding Service Interface
 */
export interface IEmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  getSimilarity(embedding1: number[], embedding2: number[]): number;
}

/**
 * MCP Tool Handler Interface
 */
export interface IToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle(params: unknown): Promise<ToolResponse>;
}

/**
 * MCP Resource Handler Interface
 */
export interface IResourceHandler {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  fetch(): Promise<unknown>;
}

/**
 * Context Optimizer Interface
 */
export interface IContextOptimizer {
  optimize(context: string, maxTokens: number): Promise<CompressedContent>;
  getOptimizedContext(query: string, options: RetrievalOptions): Promise<ToolResponse>;
  estimateTokens(text: string): number;
}

/**
 * Logger Interface
 */
export interface ILogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
}

/**
 * Configuration Interface
 */
export interface IConfig {
  get<T>(key: string): T;
  set<T>(key: string, value: T): void;
  has(key: string): boolean;
  getAll(): Record<string, unknown>;
}
