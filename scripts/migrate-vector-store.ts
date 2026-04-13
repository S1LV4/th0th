#!/usr/bin/env bun

/**
 * Vector Store Migration Script
 * 
 * Migrates vector documents from SQLite to PostgreSQL.
 * Usage: bun run scripts/migrate-vector-store.ts <postgres-url>
 * 
 * Example:
 *   bun run scripts/migrate-vector-store.ts postgresql://user:pass@localhost:5432/th0th
 */

import { sqliteVectorStore } from '../packages/core/src/data/vector/sqlite-vector-store.js';
import { PostgresVectorStore } from '../packages/core/src/data/vector/postgres-vector-store.js';

async function migrate(postgresUrl: string, batchSize = 1000) {
  const postgres = new PostgresVectorStore({ connectionString: postgresUrl });
  
  console.log('Starting migration from SQLite to PostgreSQL...');
  
  const projects = await sqliteVectorStore.listProjects();
  console.log(`Found ${projects.length} projects to migrate`);
  
  let totalMigrated = 0;
  
  for (const project of projects) {
    console.log(`\nMigrating project: ${project.projectId}`);
    console.log(`  Documents: ${project.documentCount}`);
    
    const collection = await sqliteVectorStore.getCollection(project.projectId);
    const docs = await collection.query({ nResults: 100000 });
    
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      
      const documents = batch.map(d => ({
        id: d.id,
        content: d.content,
        metadata: { ...d.metadata, projectId: project.projectId },
      }));
      
      await postgres.addDocuments(documents);
      
      const migrated = Math.min(i + batchSize, docs.length);
      totalMigrated += batch.length;
      console.log(`  Progress: ${migrated}/${docs.length} (${Math.round(migrated / docs.length * 100)}%)`);
    }
    
    console.log(`  ✓ Project ${project.projectId} migrated`);
  }
  
  console.log(`\n✓ Migration complete! Migrated ${totalMigrated} documents.`);
  
  await postgres.close();
}

const postgresUrl = process.argv[2];

if (!postgresUrl) {
  console.error('Usage: bun run scripts/migrate-vector-store.ts <postgres-url>');
  console.error('Example: bun run scripts/migrate-vector-store.ts postgresql://user:pass@localhost:5432/th0th');
  process.exit(1);
}

migrate(postgresUrl).catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
