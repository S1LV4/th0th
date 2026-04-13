-- ============================================
-- Schema Improvements - Fase 1
-- ============================================
-- Baseado no relatório de Code Intelligence
-- Implementa: FKs críticas, tipos corretos, CHECK constraints
--
-- Executar em ordem:
-- 1. Backup do banco
-- 2. Rodar este script em transação
-- 3. Validar com testes

BEGIN;

-- ============================================
-- 1. MIGRAR TIPOS DE DADOS
-- ============================================

-- Memory.tags: CSV → text[]
-- Converte "tag1,tag2,tag3" para PostgreSQL array
ALTER TABLE memories
  ALTER COLUMN tags TYPE text[]
  USING CASE 
    WHEN tags IS NULL OR tags = '' THEN '{}'::text[]
    ELSE string_to_array(trim(tags), ',')
  END;

-- Memory.metadata: String → Json
-- Converte string JSON para tipo nativo
ALTER TABLE memories
  ALTER COLUMN metadata TYPE jsonb
  USING CASE
    WHEN metadata IS NULL OR metadata = '' THEN '{}'::jsonb
    WHEN metadata::text ~ '^[\s]*[\{\[]' THEN metadata::jsonb
    ELSE jsonb_build_object('raw', metadata)
  END;

-- MemoryEdge.metadata: String → Json
ALTER TABLE memory_edges
  ALTER COLUMN metadata TYPE jsonb
  USING CASE
    WHEN metadata IS NULL OR metadata = '' THEN NULL
    WHEN metadata::text ~ '^[\s]*[\{\[]' THEN metadata::jsonb
    ELSE jsonb_build_object('raw', metadata)
  END;

-- ============================================
-- 2. FOREIGN KEYS CRÍTICAS
-- ============================================

-- MemoryEdge → Memory (CRÍTICO: previne arestas penduradas)
ALTER TABLE memory_edges
  ADD CONSTRAINT fk_edge_from
    FOREIGN KEY (from_id)
    REFERENCES memories(id)
    ON DELETE CASCADE,
  ADD CONSTRAINT fk_edge_to
    FOREIGN KEY (to_id)
    REFERENCES memories(id)
    ON DELETE CASCADE;

-- Nota: Workspace ↔ Project NÃO tem FK
-- São entidades separadas com projectId de naturezas diferentes:
-- - workspaces.projectId = path-based string (ex: "shared")
-- - projects.id = CUID (ex: "clx...")
-- - projects.projectId = UUID quando criado via API

-- ============================================
-- 3. CHECK CONSTRAINTS (em vez de ENUMs)
-- ============================================

-- Workspace status: validação sem rigidez de ENUM
ALTER TABLE workspaces
  ADD CONSTRAINT chk_workspace_status
  CHECK (status IN ('pending', 'indexing', 'indexed', 'ready', 'error'));

-- MemoryEdge type: validação de tipos conhecidos
ALTER TABLE memory_edges
  ADD CONSTRAINT chk_edge_type
  CHECK (edge_type IN (
    'relates_to',
    'conflicts_with', 
    'depends_on',
    'derived_from',
    'references',
    'implements'
  ));

-- Memory type: validação de categorias
ALTER TABLE memories
  ADD CONSTRAINT chk_memory_type
  CHECK (type IN (
    'preference',
    'conversation',
    'code',
    'decision',
    'pattern',
    'critical'
  ));

-- ============================================
-- 4. ÍNDICES DE PERFORMANCE
-- ============================================

-- Memory: busca por agente + projeto
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mem_agent_project
  ON memories (agent_id, project_id)
  WHERE agent_id IS NOT NULL;

-- Memory: GIN index para array tags
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mem_tags
  ON memories USING gin(tags)
  WHERE array_length(tags, 1) > 0;

-- SymbolImport: após migração para text[]
-- (comentado porque symbol_imports.imported_names ainda é text)
-- ALTER TABLE symbol_imports
--   ALTER COLUMN imported_names TYPE text[]
--   USING string_to_array(imported_names, ',');
-- CREATE INDEX CONCURRENTLY idx_imports_names
--   ON symbol_imports USING gin(imported_names);

-- SearchQuery: busca por projeto + tempo
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sq_proj_time
  ON search_queries (project_id, timestamp DESC)
  WHERE project_id IS NOT NULL;

-- SymbolCentrality: top N arquivos mais centrais
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_centrality_score
  ON symbol_centrality (project_id, score DESC);

-- ============================================
-- 5. VALIDAÇÕES PÓS-MIGRATION
-- ============================================

-- Verificar se há arestas órfãs ANTES de aplicar FK
DO $$
DECLARE
  orphan_count int;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM memory_edges e
  WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = e.from_id)
     OR NOT EXISTS (SELECT 1 FROM memories WHERE id = e.to_id);
  
  IF orphan_count > 0 THEN
    RAISE WARNING 'Found % orphan edges. Run cleanup before adding FK.', orphan_count;
    -- Para evitar falha, comentar as linhas de FK acima e rodar:
    -- DELETE FROM memory_edges e
    -- WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = e.from_id)
    --    OR NOT EXISTS (SELECT 1 FROM memories WHERE id = e.to_id);
  END IF;
END $$;

COMMIT;

-- ============================================
-- 6. ROLLBACK MANUAL (se necessário)
-- ============================================
/*
BEGIN;

-- Remover FKs
ALTER TABLE memory_edges DROP CONSTRAINT IF EXISTS fk_edge_from;
ALTER TABLE memory_edges DROP CONSTRAINT IF EXISTS fk_edge_to;

-- Remover CHECK constraints
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS chk_workspace_status;
ALTER TABLE memory_edges DROP CONSTRAINT IF EXISTS chk_edge_type;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS chk_memory_type;

-- Reverter tipos (perde dados de tags!)
ALTER TABLE memories ALTER COLUMN tags TYPE text;
ALTER TABLE memories ALTER COLUMN metadata TYPE text;
ALTER TABLE memory_edges ALTER COLUMN metadata TYPE text;

COMMIT;
*/
