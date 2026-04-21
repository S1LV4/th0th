-- ============================================
-- Schema Improvements - Fase 1d - Índices Compostos
-- ============================================
-- Índices identificados como críticos após análise de queries

-- ============================================
-- CRITICAL: symbol_references find usages
-- ============================================
-- Query: "Quem referencia este símbolo neste projeto?"
-- Uso: Toda operação "Go to Definition" / "Find References"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_symref_target
  ON symbol_references (project_id, target_fqn)
  WHERE target_fqn IS NOT NULL;

-- ============================================
-- CRITICAL: symbol_imports array search
-- ============================================
-- Query: "Quais arquivos importam UserService?"
-- Requer imported_names como text[] (migration 001c)
-- GIN index: O(log n) containment queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_imports_names
  ON symbol_imports USING gin(imported_names);

-- ============================================
-- OPTIONAL: symbol_imports compostos
-- ============================================
-- Query: "De onde vem esta importação neste projeto?"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_imports_from_to
  ON symbol_imports (project_id, from_file, to_file)
  WHERE to_file IS NOT NULL;
