-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "user_id" TEXT,
    "session_id" TEXT,
    "project_id" TEXT,
    "agent_id" TEXT,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "tags" TEXT,
    "metadata" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "access_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "document_count" INTEGER NOT NULL DEFAULT 0,
    "total_size" INTEGER NOT NULL DEFAULT 0,
    "last_indexed" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_type" TEXT,
    "size" INTEGER NOT NULL DEFAULT 0,
    "indexed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_queries" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "project_id" TEXT,
    "results_count" INTEGER NOT NULL DEFAULT 0,
    "duration" INTEGER NOT NULL,
    "cache_hit" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cache_stats" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "query_hash" TEXT NOT NULL,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_hit_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cache_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memories_user_id_idx" ON "memories"("user_id");

-- CreateIndex
CREATE INDEX "memories_session_id_idx" ON "memories"("session_id");

-- CreateIndex
CREATE INDEX "memories_project_id_idx" ON "memories"("project_id");

-- CreateIndex
CREATE INDEX "memories_agent_id_idx" ON "memories"("agent_id");

-- CreateIndex
CREATE INDEX "memories_type_idx" ON "memories"("type");

-- CreateIndex
CREATE INDEX "memories_importance_idx" ON "memories"("importance" DESC);

-- CreateIndex
CREATE INDEX "memories_created_at_idx" ON "memories"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "projects_project_id_key" ON "projects"("project_id");

-- CreateIndex
CREATE INDEX "projects_project_id_idx" ON "projects"("project_id");

-- CreateIndex
CREATE INDEX "projects_last_indexed_idx" ON "projects"("last_indexed" DESC);

-- CreateIndex
CREATE INDEX "documents_project_id_idx" ON "documents"("project_id");

-- CreateIndex
CREATE INDEX "documents_file_type_idx" ON "documents"("file_type");

-- CreateIndex
CREATE INDEX "documents_indexed_at_idx" ON "documents"("indexed_at" DESC);

-- CreateIndex
CREATE INDEX "search_queries_project_id_idx" ON "search_queries"("project_id");

-- CreateIndex
CREATE INDEX "search_queries_timestamp_idx" ON "search_queries"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "cache_stats_project_id_idx" ON "cache_stats"("project_id");

-- CreateIndex
CREATE INDEX "cache_stats_hit_count_idx" ON "cache_stats"("hit_count" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cache_stats_project_id_query_hash_key" ON "cache_stats"("project_id", "query_hash");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
