/**
 * Core Types for th0th MCP Server
 * 
 * This file contains all fundamental type definitions following
 * the hierarchical memory architecture described in docs/02-architecture.md
 */

/**
 * Memory Hierarchy Levels
 * 
 * Level 4: Working Memory (Context Window)
 * Level 3: Session Memory (Local SQLite)
 * Level 2: User Memory (Local SQLite)
 * Level 1: Project Memory (Vector DB + SQLite)
 * Level 0: Persistent Memory (Files)
 */
export enum MemoryLevel {
  PERSISTENT = 0,  // Files, git history
  PROJECT = 1,     // Indexed code, ASTs
  USER = 2,        // User critical, patterns
  SESSION = 3,     // Current conversation
  WORKING = 4      // Active tokens in LLM
}

/**
 * Memory Types
 */
export enum MemoryType {
  CRITICAL = 'critical',
  CONVERSATION = 'conversation',
  CODE = 'code',
  DECISION = 'decision',
  PATTERN = 'pattern'
}

/**
 * Base Memory Interface
 */
export interface Memory {
  id: string;
  type: MemoryType;
  level: MemoryLevel;
  content: string;
  metadata: MemoryMetadata;
  embedding?: number[];
  importance: number; // 0-1
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

/**
 * Memory Metadata
 */
export interface MemoryMetadata {
  userId?: string;
  sessionId?: string;
  projectId?: string;
  tags?: string[];
  references?: string[]; // File paths or other memory IDs
  context?: Record<string, unknown>;
  accessCount?: number; // For popularity boosting
  createdAt?: Date | string; // For recency boosting
  
  // Code-specific metadata
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  language?: string;
  functionName?: string;
  className?: string;
}

/**
 * Cache Entry Interface
 */
export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  level: CacheLevel;
  ttl: number; // seconds
  createdAt: Date;
  accessCount: number;
  lastAccessed: Date;
  size: number; // bytes
}

/**
 * Cache Levels (L1 = fastest)
 */
export enum CacheLevel {
  L1 = 1, // In-memory Map
  L2 = 2  // SQLite
}

/**
 * Compressed Content
 */
export interface CompressedContent {
  original: string;
  compressed: string;
  compressionRatio: number; // 0-1
  tokensSaved: number;
  strategy: CompressionStrategy;
  metadata: CompressionMetadata;
}

/**
 * Compression Strategies
 */
export enum CompressionStrategy {
  CODE_STRUCTURE = 'code_structure',     // Keep only signatures
  CONVERSATION_SUMMARY = 'conversation_summary', // Summarize dialogue
  SEMANTIC_DEDUP = 'semantic_dedup',     // Remove redundant info
  HIERARCHICAL = 'hierarchical'          // Multi-level compression
}

/**
 * Compression Metadata
 */
export interface CompressionMetadata {
  language?: string;
  originalTokens: number;
  compressedTokens: number;
  preservedElements: string[];
  timestamp: Date;
}

/**
 * Score Explanation
 */
export interface ScoreExplanation {
  finalScore: number;
  vectorScore?: number;
  keywordScore?: number;
  rrfScore?: number;
  vectorRank?: number;
  keywordRank?: number;
  combinedRank?: number;
  breakdown: string;
}

/**
 * Search Result
 */
export interface SearchResult {
  id: string;
  content: string;
  score: number; // relevance score 0-1
  source: SearchSource;
  metadata: MemoryMetadata;
  highlights?: string[];
  explanation?: ScoreExplanation;
}

/**
 * Search Sources
 */
export enum SearchSource {
  VECTOR = 'vector',
  KEYWORD = 'keyword',
  HYBRID = 'hybrid',
  CACHE = 'cache'
}

/**
 * Security Context
 */
export interface SecurityContext {
  userId: string;
  projectId: string;
  sessionId: string;
  permissions: Permission[];
}

/**
 * Permissions
 */
export enum Permission {
  READ = 'read',
  WRITE = 'write',
  DELETE = 'delete',
  ADMIN = 'admin'
}

/**
 * Retrieval Options
 */
export interface RetrievalOptions {
  maxResults?: number;
  minScore?: number;
  sources?: SearchSource[];
  useCache?: boolean;
  compress?: boolean;
  explainScores?: boolean;
  securityContext?: SecurityContext;
}

/**
 * Storage Options
 */
export interface StorageOptions {
  level: MemoryLevel;
  ttl?: number;
  importance?: number;
  generateEmbedding?: boolean;
  securityContext: SecurityContext;
}

/**
 * MCP Tool Response
 */
export interface ToolResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: {
    tokensSaved?: number;
    compressionRatio?: number;
    cacheHit?: boolean;
    latency?: number;
  };
}

/**
 * Memory Edge Relation Types
 */
export enum MemoryRelationType {
  DERIVED_FROM = 'DERIVED_FROM',
  CONTRADICTS = 'CONTRADICTS',
  SUPPORTS = 'SUPPORTS',
  RELATES_TO = 'RELATES_TO',
  SUPERSEDES = 'SUPERSEDES',
  CAUSES = 'CAUSES',
  RESOLVES = 'RESOLVES'
}

/**
 * Memory Edge Interface
 */
export interface MemoryEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: MemoryRelationType;
  weight: number;
  evidence?: string;
  autoExtracted: boolean;
  createdAt: Date;
}

/**
 * Graph Query Options
 */
export interface GraphQueryOptions {
  maxDepth?: number;
  relationTypes?: MemoryRelationType[];
  minWeight?: number;
  limit?: number;
  includeEvidence?: boolean;
}

/**
 * Graph Path Result
 */
export interface GraphPath {
  nodes: Memory[];
  edges: MemoryEdge[];
  length: number;
  totalWeight: number;
}

/**
 * Contradiction Detection Result
 */
export interface ContradictionPair {
  memory1: Memory;
  memory2: Memory;
  edge?: MemoryEdge;
  evidence: string;
}

/**
 * Relation Extraction Result
 */
export interface ExtractedRelation {
  relation: MemoryRelationType | 'NONE';
  confidence: number;
  evidence: string;
}

// ── Checkpointing Types ──────────────────────────────────────

/**
 * Checkpoint types
 */
export enum CheckpointType {
  AUTO = 'auto',
  MANUAL = 'manual',
  MILESTONE = 'milestone',
}

/**
 * Task status for checkpointed tasks
 */
export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  PAUSED = 'paused',
}

/**
 * Progress tracking within a task
 */
export interface TaskProgress {
  total: number;
  completed: number;
  currentStep: string;
  percentage: number;
}

/**
 * Accumulated context during task execution
 */
export interface TaskContext {
  /** Memory IDs of decisions made during the task */
  decisions: string[];
  /** File paths read during the task */
  filesRead: string[];
  /** File paths modified during the task */
  filesModified: string[];
  /** Errors encountered */
  errors: Array<{ message: string; timestamp: number; step?: string }>;
  /** Key learnings or insights */
  learnings: string[];
}

/**
 * Agent execution state
 */
export interface AgentState {
  lastAction: string;
  nextAction?: string;
  pendingValidations: string[];
}

/**
 * Full serializable task state for checkpointing
 */
export interface TaskState {
  taskId: string;
  description: string;
  status: TaskStatus;
  progress: TaskProgress;
  context: TaskContext;
  agentState: AgentState;
  startedAt: number;
  lastCheckpointAt: number;
  checkpointCount: number;
}

/**
 * Stored checkpoint record
 */
export interface TaskCheckpoint {
  id: string;
  taskId: string;
  taskDescription?: string;
  agentId?: string;
  projectId?: string;
  state: TaskState;
  /** Memory IDs relevant to this checkpoint */
  memoryIds: string[];
  /** Files changed since last checkpoint */
  fileChanges: string[];
  checkpointType: CheckpointType;
  parentCheckpointId?: string;
  createdAt: number;
  expiresAt?: number;
}

/**
 * Result of restoring a checkpoint
 */
export interface RestoreResult {
  checkpoint: TaskCheckpoint;
  /** Memories that were referenced but still exist */
  validMemoryIds: string[];
  /** Memories that were referenced but no longer exist */
  missingMemoryIds: string[];
  /** Files that changed on disk since checkpoint */
  fileConflicts: string[];
  /** Human-readable restore instructions */
  restoreInstructions: string;
}
