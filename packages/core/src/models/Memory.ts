/**
 * Memory Model
 * 
 * Domain model for memory entities with business logic
 */

import { 
  Memory as IMemory, 
  MemoryType, 
  MemoryLevel, 
  MemoryMetadata 
} from '@th0th-ai/shared';

export class Memory implements IMemory {
  id: string;
  type: MemoryType;
  level: MemoryLevel;
  content: string;
  metadata: MemoryMetadata;
  embedding?: number[];
  importance: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;

  constructor(data: Partial<IMemory>) {
    this.id = data.id || this.generateId();
    this.type = data.type || MemoryType.CONVERSATION;
    this.level = data.level ?? MemoryLevel.SESSION;
    this.content = data.content || '';
    this.metadata = data.metadata || {};
    this.embedding = data.embedding;
    this.importance = data.importance ?? 0.5;
    this.createdAt = data.createdAt || new Date();
    this.updatedAt = data.updatedAt || new Date();
    this.expiresAt = data.expiresAt;
  }

  /**
   * Generate unique memory ID
   */
  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Check if memory is expired
   */
  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return new Date() > this.expiresAt;
  }

  /**
   * Calculate TTL based on memory type and importance
   */
  static calculateTTL(type: MemoryType, importance: number): number {
    const baseTTL: Record<MemoryType, number> = {
      [MemoryType.CODE]: 3600,        // 1 hour
      [MemoryType.CONVERSATION]: 300,  // 5 minutes
      [MemoryType.PREFERENCE]: 86400,  // 24 hours
      [MemoryType.DECISION]: 604800,   // 7 days
      [MemoryType.PATTERN]: 2592000    // 30 days
    };

    const base = baseTTL[type] || 1800; // default 30 min
    
    // Important memories live longer
    return Math.floor(base * (1 + importance));
  }

  /**
   * Set expiration based on TTL
   */
  setExpiration(ttl?: number): void {
    const finalTTL = ttl ?? Memory.calculateTTL(this.type, this.importance);
    this.expiresAt = new Date(Date.now() + finalTTL * 1000);
  }

  /**
   * Update importance score
   */
  updateImportance(newImportance: number): void {
    this.importance = Math.max(0, Math.min(1, newImportance));
    this.updatedAt = new Date();
  }

  /**
   * Add tag to metadata
   */
  addTag(tag: string): void {
    if (!this.metadata.tags) {
      this.metadata.tags = [];
    }
    if (!this.metadata.tags.includes(tag)) {
      this.metadata.tags.push(tag);
      this.updatedAt = new Date();
    }
  }

  /**
   * Add reference to another memory or file
   */
  addReference(ref: string): void {
    if (!this.metadata.references) {
      this.metadata.references = [];
    }
    if (!this.metadata.references.includes(ref)) {
      this.metadata.references.push(ref);
      this.updatedAt = new Date();
    }
  }

  /**
   * Convert to plain object for storage
   */
  toJSON(): IMemory {
    return {
      id: this.id,
      type: this.type,
      level: this.level,
      content: this.content,
      metadata: this.metadata,
      embedding: this.embedding,
      importance: this.importance,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      expiresAt: this.expiresAt
    };
  }

  /**
   * Create from plain object
   */
  static fromJSON(data: IMemory): Memory {
    return new Memory({
      ...data,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined
    });
  }

  /**
   * Factory: Create user preference memory
   */
  static createPreference(content: string, userId: string, importance = 0.8): Memory {
    return new Memory({
      type: MemoryType.PREFERENCE,
      level: MemoryLevel.USER,
      content,
      importance,
      metadata: { userId }
    });
  }

  /**
   * Factory: Create conversation memory
   */
  static createConversation(content: string, sessionId: string, importance = 0.5): Memory {
    return new Memory({
      type: MemoryType.CONVERSATION,
      level: MemoryLevel.SESSION,
      content,
      importance,
      metadata: { sessionId }
    });
  }

  /**
   * Factory: Create code memory
   */
  static createCode(
    content: string, 
    projectId: string, 
    filePath: string, 
    importance = 0.6
  ): Memory {
    return new Memory({
      type: MemoryType.CODE,
      level: MemoryLevel.PROJECT,
      content,
      importance,
      metadata: {
        projectId,
        references: [filePath]
      }
    });
  }

  /**
   * Factory: Create decision memory
   */
  static createDecision(content: string, userId: string, importance = 0.9): Memory {
    return new Memory({
      type: MemoryType.DECISION,
      level: MemoryLevel.USER,
      content,
      importance,
      metadata: { userId }
    });
  }
}
