/*
  Migration: add_workspaces_symbol_graph
  Idempotent version — safe to re-run after partial failures.
*/

-- Enable pgvector extension (required for vector(N) columns)
CREATE EXTENSION IF NOT EXISTS vector;

-- DropIndex (may have been dropped already by a previous run)
DROP INDEX IF EXISTS "projects_project_id_idx";

-- AlterTable memories — add new columns only if they don't exist yet
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding" BYTEA;
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "last_accessed" TIMESTAMP(3);
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- AlterTable cache_stats
ALTER TABLE "cache_stats" ALTER COLUMN "last_hit_at" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable workspaces
CREATE TABLE IF NOT EXISTS "workspaces" (
    "project_id" TEXT NOT NULL,
    "project_path" TEXT NOT NULL,
    "display_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "last_indexed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "files_count" INTEGER NOT NULL DEFAULT 0,
    "chunks_count" INTEGER NOT NULL DEFAULT 0,
    "symbols_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable symbol_files
CREATE TABLE IF NOT EXISTS "symbol_files" (
    "project_id" TEXT NOT NULL,
    "relative_path" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "mtime" BIGINT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMP(3) NOT NULL,
    "symbol_count" INTEGER NOT NULL DEFAULT 0,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "symbol_files_pkey" PRIMARY KEY ("project_id","relative_path")
);

-- CreateTable symbol_definitions
CREATE TABLE IF NOT EXISTS "symbol_definitions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "line_start" INTEGER NOT NULL,
    "line_end" INTEGER NOT NULL,
    "exported" BOOLEAN NOT NULL DEFAULT false,
    "doc_comment" TEXT,
    "indexed_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "symbol_definitions_pkey" PRIMARY KEY ("project_id","id")
);

-- CreateTable symbol_references
CREATE TABLE IF NOT EXISTS "symbol_references" (
    "id" SERIAL NOT NULL,
    "project_id" TEXT NOT NULL,
    "from_file" TEXT NOT NULL,
    "from_line" INTEGER NOT NULL,
    "symbol_name" TEXT NOT NULL,
    "target_fqn" TEXT NOT NULL,
    "ref_kind" TEXT NOT NULL,
    CONSTRAINT "symbol_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable symbol_imports
CREATE TABLE IF NOT EXISTS "symbol_imports" (
    "id" SERIAL NOT NULL,
    "project_id" TEXT NOT NULL,
    "from_file" TEXT NOT NULL,
    "to_file" TEXT,
    "specifier" TEXT NOT NULL,
    "imported_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_external" BOOLEAN NOT NULL DEFAULT false,
    "is_type_only" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "symbol_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable symbol_centrality
CREATE TABLE IF NOT EXISTS "symbol_centrality" (
    "project_id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "symbol_centrality_pkey" PRIMARY KEY ("project_id","file_path")
);

-- CreateTable memory_edges
CREATE TABLE IF NOT EXISTS "memory_edges" (
    "id" SERIAL NOT NULL,
    "from_id" TEXT NOT NULL,
    "to_id" TEXT NOT NULL,
    "edge_type" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable embedding_cache
CREATE TABLE IF NOT EXISTS "embedding_cache" (
    "text_hash" TEXT NOT NULL,
    "embedding" BYTEA NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'nomic-embed-text',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hit_count" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "embedding_cache_pkey" PRIMARY KEY ("text_hash")
);

-- CreateTable vector_documents_1024d
CREATE TABLE IF NOT EXISTS "vector_documents_1024d" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1024),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vector_documents_1024d_pkey" PRIMARY KEY ("id")
);

-- CreateTable vector_documents_3072d
CREATE TABLE IF NOT EXISTS "vector_documents_3072d" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(3072),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vector_documents_3072d_pkey" PRIMARY KEY ("id")
);

-- CreateTable vector_documents (legacy)
CREATE TABLE IF NOT EXISTS "vector_documents" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1024),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vector_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (IF NOT EXISTS where supported via DO block)
CREATE INDEX IF NOT EXISTS "workspaces_status_idx" ON "workspaces"("status");
CREATE INDEX IF NOT EXISTS "workspaces_project_path_idx" ON "workspaces"("project_path");
CREATE INDEX IF NOT EXISTS "symbol_files_project_id_idx" ON "symbol_files"("project_id");
CREATE INDEX IF NOT EXISTS "symbol_definitions_project_id_idx" ON "symbol_definitions"("project_id");
CREATE INDEX IF NOT EXISTS "symbol_definitions_project_id_file_path_idx" ON "symbol_definitions"("project_id", "file_path");
CREATE INDEX IF NOT EXISTS "symbol_definitions_project_id_name_idx" ON "symbol_definitions"("project_id", "name");
CREATE INDEX IF NOT EXISTS "symbol_references_project_id_idx" ON "symbol_references"("project_id");
CREATE INDEX IF NOT EXISTS "symbol_references_project_id_target_fqn_idx" ON "symbol_references"("project_id", "target_fqn");
CREATE INDEX IF NOT EXISTS "symbol_references_project_id_from_file_idx" ON "symbol_references"("project_id", "from_file");
CREATE INDEX IF NOT EXISTS "symbol_imports_project_id_from_file_idx" ON "symbol_imports"("project_id", "from_file");
CREATE INDEX IF NOT EXISTS "symbol_imports_project_id_to_file_idx" ON "symbol_imports"("project_id", "to_file");
CREATE INDEX IF NOT EXISTS "symbol_imports_imported_names_idx" ON "symbol_imports"("imported_names");
CREATE INDEX IF NOT EXISTS "memory_edges_from_id_idx" ON "memory_edges"("from_id");
CREATE INDEX IF NOT EXISTS "memory_edges_to_id_idx" ON "memory_edges"("to_id");
CREATE INDEX IF NOT EXISTS "memory_edges_edge_type_idx" ON "memory_edges"("edge_type");
CREATE UNIQUE INDEX IF NOT EXISTS "memory_edges_from_id_to_id_edge_type_key" ON "memory_edges"("from_id", "to_id", "edge_type");
CREATE INDEX IF NOT EXISTS "embedding_cache_model_idx" ON "embedding_cache"("model");
CREATE INDEX IF NOT EXISTS "embedding_cache_accessed_at_idx" ON "embedding_cache"("accessed_at" DESC);
CREATE INDEX IF NOT EXISTS "vector_documents_1024d_project_id_idx" ON "vector_documents_1024d"("project_id");
CREATE INDEX IF NOT EXISTS "vector_documents_3072d_project_id_idx" ON "vector_documents_3072d"("project_id");
CREATE INDEX IF NOT EXISTS "vector_documents_project_id_idx" ON "vector_documents"("project_id");
CREATE INDEX IF NOT EXISTS "memories_tags_idx" ON "memories"("tags");

-- AddForeignKey (only if not exists)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'symbol_files_project_id_fkey') THEN
    ALTER TABLE "symbol_files" ADD CONSTRAINT "symbol_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "workspaces"("project_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'symbol_definitions_project_id_fkey') THEN
    ALTER TABLE "symbol_definitions" ADD CONSTRAINT "symbol_definitions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "workspaces"("project_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'symbol_references_project_id_fkey') THEN
    ALTER TABLE "symbol_references" ADD CONSTRAINT "symbol_references_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "workspaces"("project_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'symbol_imports_project_id_fkey') THEN
    ALTER TABLE "symbol_imports" ADD CONSTRAINT "symbol_imports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "workspaces"("project_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'symbol_centrality_project_id_fkey') THEN
    ALTER TABLE "symbol_centrality" ADD CONSTRAINT "symbol_centrality_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "workspaces"("project_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_edges_from_id_fkey') THEN
    ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_edges_to_id_fkey') THEN
    ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
