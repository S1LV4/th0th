/*
  Migration: add_vector_1536

  Adds vector_documents_1536d table for 1536-dimension embedding models.
  Primary use case: openai/text-embedding-3-small (native 1536 dims, MRL-capable).

  1536 < 2000, so pgvector supports HNSW directly on the vector column with
  vector_cosine_ops (no binary quantization needed — that path is reserved for
  dims > 2000 in vector_documents_4096d).

  Idempotent — safe to re-run.
*/

-- CreateTable
CREATE TABLE IF NOT EXISTS "vector_documents_1536d" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1536),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vector_documents_1536d_pkey" PRIMARY KEY ("id")
);

-- Project lookup index
CREATE INDEX IF NOT EXISTS "vector_documents_1536d_project_id_idx"
    ON "vector_documents_1536d"("project_id");
