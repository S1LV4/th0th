/**
 * Vector Store Factory
 * 
 * Provides unified access to vector stores with automatic configuration.
 * Maintains backward compatibility with existing singleton pattern.
 */

import { IVectorStore } from '@th0th-ai/shared';
import { logger } from '@th0th-ai/shared';
import { PostgresConfig } from './postgres-vector-store.js';

export type VectorStoreType = 'sqlite' | 'postgres';

export interface VectorStoreConfig {
  type: VectorStoreType;
  postgres?: PostgresConfig;
}

let cachedStore: IVectorStore | null = null;
let cachedConfig: VectorStoreConfig | null = null;
let initializationPromise: Promise<IVectorStore> | null = null;

export async function getVectorStore(config?: VectorStoreConfig): Promise<IVectorStore> {
  if (cachedStore && configMatches(config, cachedConfig)) {
    return cachedStore;
  }

  // Serialize concurrent initialization: reuse the in-flight promise
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    const resolvedConfig = config || getConfigFromEnv();

    let store: IVectorStore;
    if (resolvedConfig.type === 'postgres' && resolvedConfig.postgres?.connectionString) {
      const { PostgresVectorStore } = await import('./postgres-vector-store.js');
      const pg = new PostgresVectorStore(resolvedConfig.postgres);
      await pg.ensureInitialized();
      store = pg;
    } else {
      const { SQLiteVectorStore } = await import('./sqlite-vector-store.js');
      store = new SQLiteVectorStore();
    }

    const healthy = await Promise.race([
      store.healthCheck(),
      new Promise<boolean>(r => setTimeout(() => r(false), 5000)),
    ]);

    if (!healthy) {
      await store.close().catch(() => {});
      throw new Error(`Vector store ${resolvedConfig.type} health check failed`);
    }

    cachedStore = store;
    cachedConfig = resolvedConfig;
    logger.info('Vector store initialized', { type: resolvedConfig.type });
    return cachedStore;
  })().finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}

export async function resetVectorStore(): Promise<void> {
  if (cachedStore) {
    await cachedStore.close();
    cachedStore = null;
    cachedConfig = null;
  }
}

function configMatches(a?: VectorStoreConfig, b?: VectorStoreConfig | null): boolean {
  const resolvedA = a || getConfigFromEnv();
  const resolvedB = b || getConfigFromEnv();
  return resolvedA.type === resolvedB.type;
}

function getConfigFromEnv(): VectorStoreConfig {
  // Explicit override takes precedence
  const explicitType = process.env.VECTOR_STORE_TYPE as VectorStoreType | undefined;

  // Resolve connection string: prefer POSTGRES_VECTOR_URL, fall back to DATABASE_URL
  const postgresUrl = process.env.POSTGRES_VECTOR_URL || process.env.DATABASE_URL;
  const isPostgres =
    explicitType === 'postgres' ||
    (!explicitType && postgresUrl?.startsWith('postgresql'));

  if (isPostgres && postgresUrl) {
    const hnswM = Number(process.env.POSTGRES_HNSW_M);
    const hnswEfConstruction = Number(process.env.POSTGRES_HNSW_EF_CONSTRUCTION);
    const ivfflatLists = Number(process.env.POSTGRES_IVFFLAT_LISTS);

    const indexParams: { m?: number; efConstruction?: number; lists?: number } = {};
    if (hnswM) indexParams.m = hnswM;
    if (hnswEfConstruction) indexParams.efConstruction = hnswEfConstruction;
    if (ivfflatLists) indexParams.lists = ivfflatLists;

    return {
      type: 'postgres',
      postgres: {
        connectionString: postgresUrl,
        poolSize: parseInt(process.env.POSTGRES_VECTOR_POOL_SIZE || '10'),
        indexType: (process.env.POSTGRES_VECTOR_INDEX as 'ivfflat' | 'hnsw') || 'hnsw',
        ...(Object.keys(indexParams).length > 0 ? { indexParams } : {}),
      },
    };
  }

  return { type: 'sqlite' };
}
