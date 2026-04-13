#!/usr/bin/env bun
import '@th0th-ai/shared/config';
import { getPgPool } from './src/data/db-connection.js';

async function main() {
  const url = process.env.DATABASE_URL;
  console.log('DATABASE_URL:', url?.substring(0, 50) + '...');
  console.log('Starts with postgresql?', url?.startsWith('postgresql'));
  console.log('Starts with postgres?', url?.startsWith('postgres'));
  
  const pool = await getPgPool();

  try {
    // Check if pgvector extension is available
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    console.log('✅ pgvector extension ready');

    // Create table for Google Gemini (3072 dimensions)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vector_documents_3072d (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        embedding vector(3072),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ Table vector_documents_3072d created');

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vector_documents_3072d_project_id 
      ON vector_documents_3072d(project_id)
    `);
    console.log('✅ Index on project_id created');

    // NOTE: pgvector indices (HNSW/IVFFlat) have 2000-dimension limit
    // For 3072D vectors, we'll use sequential scan - slower but accurate
    // Consider dimension reduction or external vector DB for production
    console.log('⚠️  No vector index created: pgvector max dimension is 2000');
    console.log('   Using sequential scan for similarity search (slower but accurate)');

    // Verify table structure
    const { rows } = await pool.query(`
      SELECT 
        column_name,
        data_type,
        udt_name
      FROM information_schema.columns
      WHERE table_name = 'vector_documents_3072d'
      ORDER BY ordinal_position
    `);
    
    console.log('\n📋 Table structure:');
    rows.forEach(r => console.log(`  - ${r.column_name}: ${r.data_type} (${r.udt_name})`));

    // Check existing dimension
    const { rows: dimRows } = await pool.query(`
      SELECT 
        a.attname,
        a.atttypmod as dimension
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      WHERE c.relname = 'vector_documents_3072d'
        AND a.attname = 'embedding'
    `);
    
    if (dimRows.length > 0) {
      console.log(`\n🎯 Embedding dimension: ${dimRows[0].dimension}`);
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
