-- ============================================
-- Schema Improvements - Fase 1 - Part B (Concurrent Indexes)
-- ============================================
-- Must run OUTSIDE transaction (after Part A)

-- Memory: busca por agente + projeto
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mem_agent_project
  ON memories (agent_id, project_id)
  WHERE agent_id IS NOT NULL;

-- Memory: GIN index para array tags
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mem_tags
  ON memories USING gin(tags)
  WHERE array_length(tags, 1) > 0;

-- SearchQuery: busca por projeto + tempo
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sq_proj_time
  ON search_queries (project_id, timestamp DESC)
  WHERE project_id IS NOT NULL;

-- SymbolCentrality: top N arquivos mais centrais
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_centrality_score
  ON symbol_centrality (project_id, score DESC);
