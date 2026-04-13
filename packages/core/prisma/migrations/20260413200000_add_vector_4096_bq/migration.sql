/*
  Migration: add_vector_4096_bq
  Adds vector_documents_4096d table with binary-quantized column for HNSW indexing.
  pgvector 0.8+ supports HNSW on bit columns (any dimension) via bit_hamming_ops.
  Idempotent — safe to re-run.
*/

-- CreateTable vector_documents_4096d (idempotent)
CREATE TABLE IF NOT EXISTS "vector_documents_4096d" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(4096),
    "embedding_bq" bit(4096),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vector_documents_4096d_pkey" PRIMARY KEY ("id")
);

-- AddColumn: add embedding_bq if the table already existed without it
ALTER TABLE "vector_documents_4096d" ADD COLUMN IF NOT EXISTS "embedding_bq" bit(4096);

-- CreateIndex: project lookup
CREATE INDEX IF NOT EXISTS "vector_documents_4096d_project_id_idx"
    ON "vector_documents_4096d"("project_id");

-- CreateIndex: HNSW on binary-quantized column (bit_hamming_ops, no dimension limit)
-- This replaces the unavailable cosine HNSW on the 4096-dim float column.
CREATE INDEX IF NOT EXISTS "idx_vector_documents_4096d_embedding_bq"
    ON "vector_documents_4096d"
    USING hnsw (embedding_bq bit_hamming_ops)
    WITH (m = 16, ef_construction = 64);
