/*
  Migration: hnsw_ef_construction_128

  Rebuilds the HNSW BQ index on vector_documents_4096d with ef_construction=128
  (up from 64) — pgvector's recommended value for high-dim embeddings (4096d
  qwen3-embedding). Build time roughly doubles; runtime search latency is
  unaffected (controlled by hnsw.ef_search GUC, not ef_construction).

  Only affects 4096d because that is the only dimension whose HNSW index is
  created via migration. Indexes for 1024d and 3072d are created lazily at
  runtime by PostgresVectorStore.createVectorIndex() and pick up the new
  default (128) on next index creation.

  -- Note on CONCURRENTLY --
  Prisma wraps every migration in a transaction, which blocks CONCURRENTLY.
  This migration uses plain DROP/CREATE, which briefly locks the table. For
  production deploys against large tables, run the equivalent CONCURRENTLY
  statements manually before applying the migration, then mark this migration
  as already applied:

    -- Run manually against production (outside any transaction):
    DROP INDEX CONCURRENTLY IF EXISTS "idx_vector_documents_4096d_embedding_bq";
    CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_vector_documents_4096d_embedding_bq"
        ON "vector_documents_4096d"
        USING hnsw (embedding_bq bit_hamming_ops)
        WITH (m = 16, ef_construction = 128);

    -- Then tell Prisma to skip re-running it:
    prisma migrate resolve --applied 20260419193214_hnsw_ef_construction_128
*/

-- Drop the old BQ HNSW index (ef_construction=64) and recreate with 128
DROP INDEX IF EXISTS "idx_vector_documents_4096d_embedding_bq";

CREATE INDEX IF NOT EXISTS "idx_vector_documents_4096d_embedding_bq"
    ON "vector_documents_4096d"
    USING hnsw (embedding_bq bit_hamming_ops)
    WITH (m = 16, ef_construction = 128);
