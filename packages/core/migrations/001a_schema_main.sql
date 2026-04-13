-- ============================================
-- Schema Improvements - Fase 1 - Part A (Main Transaction)
-- ============================================

BEGIN;

-- ============================================
-- 1. MIGRAR TIPOS DE DADOS
-- ============================================

-- Memory.tags: CSV → text[]
ALTER TABLE memories
  ALTER COLUMN tags TYPE text[]
  USING CASE 
    WHEN tags IS NULL OR tags = '' THEN '{}'::text[]
    ELSE string_to_array(trim(tags), ',')
  END;

-- Memory.metadata: String → Json
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

-- ============================================
-- 3. CHECK CONSTRAINTS
-- ============================================

-- Workspace status
ALTER TABLE workspaces
  ADD CONSTRAINT chk_workspace_status
  CHECK (status IN ('pending', 'indexing', 'indexed', 'ready', 'error'));

-- MemoryEdge type
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

-- Memory type
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
-- 4. VALIDAÇÕES
-- ============================================

DO $$
DECLARE
  orphan_count int;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM memory_edges e
  WHERE NOT EXISTS (SELECT 1 FROM memories WHERE id = e.from_id)
     OR NOT EXISTS (SELECT 1 FROM memories WHERE id = e.to_id);
  
  IF orphan_count > 0 THEN
    RAISE WARNING 'Found % orphan edges (will be cleaned by FK)', orphan_count;
  END IF;
END $$;

COMMIT;
