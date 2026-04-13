/**
 * Centralized Database Connection Manager
 * 
 * Provides unified PostgreSQL connection pooling for all services.
 * Falls back to SQLite only if PostgreSQL is not configured.
 */

import { Pool, PoolConfig } from 'pg';
import { Database } from 'bun:sqlite';
import { logger } from '@th0th-ai/shared';
import path from 'path';
import os from 'os';
import fs from 'fs';

export type DbType = 'postgres' | 'sqlite';

export interface DbConfig {
  type: DbType;
  postgres?: {
    connectionString: string;
    poolSize?: number;
  };
  sqlite?: {
    dbPath: string;
  };
}

let pgPool: Pool | null = null;
let sqliteConnections: Map<string, Database> = new Map();

export function getDbConfig(): DbConfig {
  const isPostgres = process.env.DATABASE_URL?.startsWith('postgresql') || 
                     process.env.DATABASE_URL?.startsWith('postgres');
  const type = (process.env.DATABASE_TYPE as DbType) || 
    (isPostgres ? 'postgres' : 'sqlite');
  
  if (type === 'postgres' && process.env.DATABASE_URL) {
    return {
      type: 'postgres',
      postgres: {
        connectionString: process.env.DATABASE_URL,
        poolSize: parseInt(process.env.DB_POOL_SIZE || '10'),
      },
    };
  }
  
  return { type: 'sqlite' };
}

export async function getPgPool(): Promise<Pool> {
  if (pgPool) return pgPool;
  
  const config = getDbConfig();
  
  if (config.type !== 'postgres' || !config.postgres) {
    throw new Error('PostgreSQL not configured. Set DATABASE_URL.');
  }
  
  const pg = await import('pg');
  const PgPool = pg.default?.Pool || pg.Pool;
  
  const poolConfig: PoolConfig = {
    connectionString: config.postgres.connectionString,
    max: config.postgres.poolSize || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
  
  pgPool = new PgPool(poolConfig);
  
  logger.info('PostgreSQL pool initialized', {
    poolSize: poolConfig.max,
  });
  
  return pgPool;
}

export function getSqliteDb(dbName: string): Database {
  const existing = sqliteConnections.get(dbName);
  if (existing) return existing;
  
  const defaultDir = path.join(os.homedir(), '.rlm');
  const dbPath = path.join(defaultDir, `${dbName}.db`);
  
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }
  
  const db = new Database(dbPath);
  sqliteConnections.set(dbName, db);
  
  logger.info('SQLite database initialized', { dbName, dbPath });
  
  return db;
}

export async function closeConnections(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  
  for (const [name, db] of sqliteConnections) {
    db.close();
  }
  sqliteConnections.clear();
  
  logger.info('All database connections closed');
}
