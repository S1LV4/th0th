-- ============================================
-- Schema Improvements - Fase 1c - Complementar
-- ============================================
-- Itens identificados após revisão do relatório:
-- 1. SymbolImport.imported_names → text[]
-- 2. NOT NULL constraints críticos
-- 3. Defaults faltantes

BEGIN;

-- ============================================
-- 1. MIGRAR imported_names → text[]
-- ============================================
-- CRÍTICO: Habilita queries O(log n) com GIN index
-- Query comum: "Quais arquivos importam UserService?"

ALTER TABLE symbol_imports
  ALTER COLUMN imported_names TYPE text[]
  USING CASE 
    WHEN imported_names IS NULL OR imported_names = '' THEN '{}'::text[]
    WHEN imported_names LIKE '%,%' THEN string_to_array(trim(imported_names), ',')
    ELSE ARRAY[imported_names]
  END;

-- ============================================
-- 2. NOT NULL CONSTRAINTS
-- ============================================

-- embedding_cache.model: embedding sem modelo = cache inválido
ALTER TABLE embedding_cache
  ALTER COLUMN model SET NOT NULL;

-- symbol_references.target_fqn: referência sem FQN = dado inválido
-- Primeiro limpar NULLs existentes se houver
UPDATE symbol_references 
  SET target_fqn = 'unknown' 
  WHERE target_fqn IS NULL;

ALTER TABLE symbol_references
  ALTER COLUMN target_fqn SET NOT NULL;

-- memories.importance: já tem default 0.5, garantir NOT NULL
ALTER TABLE memories
  ALTER COLUMN importance SET NOT NULL;

-- ============================================
-- 3. DEFAULTS FALTANTES
-- ============================================

-- memories.access_count: garantir default
ALTER TABLE memories
  ALTER COLUMN access_count SET DEFAULT 0;

-- symbol_files.symbol_count: garantir default
ALTER TABLE symbol_files
  ALTER COLUMN symbol_count SET DEFAULT 0;

-- symbol_files.chunk_count: garantir default
ALTER TABLE symbol_files
  ALTER COLUMN chunk_count SET DEFAULT 0;

COMMIT;
