/**
 * Compressed Content Model
 * 
 * Represents semantically compressed content with metadata
 */

import {
  CompressedContent as ICompressedContent,
  CompressionStrategy,
  CompressionMetadata
} from '@th0th-ai/shared';

export class CompressedContent implements ICompressedContent {
  original: string;
  compressed: string;
  compressionRatio: number;
  tokensSaved: number;
  strategy: CompressionStrategy;
  metadata: CompressionMetadata;

  constructor(data: ICompressedContent) {
    this.original = data.original;
    this.compressed = data.compressed;
    this.compressionRatio = data.compressionRatio;
    this.tokensSaved = data.tokensSaved;
    this.strategy = data.strategy;
    this.metadata = data.metadata;
  }

  /**
   * Calculate compression ratio
   */
  static calculateRatio(originalTokens: number, compressedTokens: number): number {
    if (originalTokens === 0) return 0;
    return Number(((originalTokens - compressedTokens) / originalTokens).toFixed(3));
  }

  /**
   * Check if compression was effective
   */
  isEffective(threshold: number = 0.3): boolean {
    // Consider effective if saved at least 30% of tokens
    return this.compressionRatio >= threshold;
  }

  /**
   * Get compression quality score (0-1)
   */
  getQualityScore(): number {
    // Quality is high if we save many tokens while preserving structure
    const tokenSavingScore = Math.min(this.compressionRatio, 0.9); // Cap at 90%
    const preservationScore = this.metadata.preservedElements.length > 0 ? 1 : 0.5;
    
    return (tokenSavingScore + preservationScore) / 2;
  }

  /**
   * Estimate tokens in text (rough approximation)
   */
  static estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token for code
    // More accurate with actual tokenizer, but good enough for estimation
    return Math.ceil(text.length / 4);
  }

  /**
   * Create compressed content from original and compressed strings
   */
  static create(
    original: string,
    compressed: string,
    strategy: CompressionStrategy,
    language?: string,
    preservedElements: string[] = []
  ): CompressedContent {
    const originalTokens = CompressedContent.estimateTokens(original);
    const compressedTokens = CompressedContent.estimateTokens(compressed);
    const ratio = CompressedContent.calculateRatio(originalTokens, compressedTokens);
    const tokensSaved = originalTokens - compressedTokens;

    return new CompressedContent({
      original,
      compressed,
      compressionRatio: ratio,
      tokensSaved,
      strategy,
      metadata: {
        language,
        originalTokens,
        compressedTokens,
        preservedElements,
        timestamp: new Date()
      }
    });
  }

  /**
   * Convert to plain object
   */
  toJSON(): ICompressedContent {
    return {
      original: this.original,
      compressed: this.compressed,
      compressionRatio: this.compressionRatio,
      tokensSaved: this.tokensSaved,
      strategy: this.strategy,
      metadata: this.metadata
    };
  }

  /**
   * Get human-readable compression summary
   */
  getSummary(): string {
    const ratio = (this.compressionRatio * 100).toFixed(1);
    return `Compressed using ${this.strategy}: ${ratio}% reduction, saved ${this.tokensSaved} tokens`;
  }

  /**
   * Validate compression result
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (this.compressed.length > this.original.length) {
      errors.push('Compressed version is larger than original');
    }

    if (this.compressionRatio < 0 || this.compressionRatio > 1) {
      errors.push('Invalid compression ratio (must be 0-1)');
    }

    if (this.tokensSaved < 0) {
      errors.push('Negative tokens saved');
    }

    if (this.compressed.trim().length === 0) {
      errors.push('Compressed content is empty');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Create a null/identity compression (no compression applied)
   */
  static identity(content: string): CompressedContent {
    const tokens = CompressedContent.estimateTokens(content);
    return new CompressedContent({
      original: content,
      compressed: content,
      compressionRatio: 0,
      tokensSaved: 0,
      strategy: CompressionStrategy.CODE_STRUCTURE, // arbitrary
      metadata: {
        originalTokens: tokens,
        compressedTokens: tokens,
        preservedElements: [],
        timestamp: new Date()
      }
    });
  }

  /**
   * Merge multiple compressed contents
   */
  static merge(contents: CompressedContent[]): CompressedContent {
    if (contents.length === 0) {
      return CompressedContent.identity('');
    }

    if (contents.length === 1) {
      return contents[0];
    }

    const original = contents.map(c => c.original).join('\n\n');
    const compressed = contents.map(c => c.compressed).join('\n\n');
    const totalOriginalTokens = contents.reduce((sum, c) => sum + c.metadata.originalTokens, 0);
    const totalCompressedTokens = contents.reduce((sum, c) => sum + c.metadata.compressedTokens, 0);
    const allPreserved = contents.flatMap(c => c.metadata.preservedElements);

    return new CompressedContent({
      original,
      compressed,
      compressionRatio: CompressedContent.calculateRatio(totalOriginalTokens, totalCompressedTokens),
      tokensSaved: totalOriginalTokens - totalCompressedTokens,
      strategy: CompressionStrategy.HIERARCHICAL,
      metadata: {
        originalTokens: totalOriginalTokens,
        compressedTokens: totalCompressedTokens,
        preservedElements: [...new Set(allPreserved)],
        timestamp: new Date()
      }
    });
  }
}
