/**
 * Logger Utility
 * 
 * Structured logging with levels and metadata support
 */

import { ILogger } from '../types/interfaces.js';
import { config } from '../config/index.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export class Logger implements ILogger {
  private _level?: LogLevel;
  private _enableMetrics?: boolean;
  private _initialized = false;

  constructor() {
    // Lazy initialization to avoid circular dependency with config
  }

  /**
   * Lazy initialize logger configuration
   */
  private ensureInitialized(): void {
    if (!this._initialized) {
      try {
        const configLevel = config.get('logging').level;
        this._level = this.parseLogLevel(configLevel);
        this._enableMetrics = config.get('logging').enableMetrics;
      } catch (error) {
        // Fallback if config is not available yet
        this._level = LogLevel.INFO;
        this._enableMetrics = false;
      }
      this._initialized = true;
    }
  }

  private get level(): LogLevel {
    this.ensureInitialized();
    return this._level!;
  }

  private get enableMetrics(): boolean {
    this.ensureInitialized();
    return this._enableMetrics!;
  }

  /**
   * Parse log level from string
   */
  private parseLogLevel(level: string): LogLevel {
    const levels: Record<string, LogLevel> = {
      'debug': LogLevel.DEBUG,
      'info': LogLevel.INFO,
      'warn': LogLevel.WARN,
      'error': LogLevel.ERROR
    };
    return levels[level.toLowerCase()] ?? LogLevel.INFO;
  }

  /**
   * Check if level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return level >= this.level;
  }

  /**
   * Format log message
   */
  private formatMessage(
    level: string,
    message: string,
    meta?: Record<string, unknown>
  ): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}`;
  }

  /**
   * Write to stderr (for MCP compatibility)
   */
  private write(message: string): void {
    // MCP servers use stderr for logs to avoid polluting stdout
    console.error(message);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      this.write(this.formatMessage('DEBUG', message, meta));
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.INFO)) {
      this.write(this.formatMessage('INFO', message, meta));
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.WARN)) {
      this.write(this.formatMessage('WARN', message, meta));
    }
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const errorMeta = error ? {
        ...meta,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      } : meta;
      this.write(this.formatMessage('ERROR', message, errorMeta));
    }
  }

  /**
   * Log metric (if enabled)
   */
  metric(name: string, value: number, unit?: string): void {
    if (this.enableMetrics) {
      this.info(`METRIC: ${name}`, { value, unit });
    }
  }

  /**
   * Create child logger with context
   */
  child(context: Record<string, unknown>): Logger {
    const childLogger = new Logger();
    // Wrap methods to include context
    const originalDebug = childLogger.debug.bind(childLogger);
    const originalInfo = childLogger.info.bind(childLogger);
    const originalWarn = childLogger.warn.bind(childLogger);
    const originalError = childLogger.error.bind(childLogger);

    childLogger.debug = (msg: string, meta?: Record<string, unknown>) => {
      originalDebug(msg, { ...context, ...meta });
    };
    childLogger.info = (msg: string, meta?: Record<string, unknown>) => {
      originalInfo(msg, { ...context, ...meta });
    };
    childLogger.warn = (msg: string, meta?: Record<string, unknown>) => {
      originalWarn(msg, { ...context, ...meta });
    };
    childLogger.error = (msg: string, err?: Error, meta?: Record<string, unknown>) => {
      originalError(msg, err, { ...context, ...meta });
    };

    return childLogger;
  }
}

/**
 * Global logger instance
 */
export const logger = new Logger();
