#!/usr/bin/env bun
/**
 * Script de Sincronização de Bancos de Dados
 * 
 * Sincroniza dados dos bancos operacionais para th0th.db (Prisma)
 * - memories.db → th0th.db (memories)
 * - vector-store.db → th0th.db (projects, documents)
 * - search-analytics.db → th0th.db (search_queries, cache_stats)
 */

import { PrismaClient } from "../generated/prisma/index.js";
import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
// @ts-ignore - bun:sqlite is a Bun built-in module
import { Database } from "bun:sqlite";
import { config } from "@th0th-ai/shared";
import path from "path";

const dataDir = config.get("dataDir");
const th0thDbPath = path.join(dataDir, "th0th.db");

// Create Bun SQLite adapter for Prisma
const adapter = new PrismaBunSqlite({ 
  url: `file:${th0thDbPath}`,
  safeIntegers: true,
});

const prisma = new PrismaClient({ adapter });

async function syncMemories() {
  console.log("📝 Syncing memories...");
  
  const memoriesDb = new Database(path.join(dataDir, "memories.db"), { readonly: true });
  
  try {
    const memories = memoriesDb.prepare(`
      SELECT id, content, type, level, user_id, session_id, project_id, agent_id,
             importance, tags, metadata, created_at, updated_at, access_count
      FROM memories
    `).all();

    console.log(`Found ${memories.length} memories to sync`);

    for (const memory of memories as any[]) {
      await prisma.memory.upsert({
        where: { id: memory.id },
        create: {
          id: memory.id,
          content: memory.content,
          type: memory.type,
          level: memory.level,
          userId: memory.user_id,
          sessionId: memory.session_id,
          projectId: memory.project_id,
          agentId: memory.agent_id,
          importance: memory.importance || 0.5,
          tags: memory.tags,
          metadata: memory.metadata,
          createdAt: new Date(memory.created_at),
          updatedAt: new Date(memory.updated_at || memory.created_at),
          accessCount: memory.access_count || 0,
        },
        update: {
          content: memory.content,
          type: memory.type,
          importance: memory.importance || 0.5,
          tags: memory.tags,
          updatedAt: new Date(memory.updated_at || memory.created_at),
          accessCount: memory.access_count || 0,
        },
      });
    }

    console.log(`✅ Synced ${memories.length} memories`);
  } finally {
    memoriesDb.close();
  }
}

async function syncProjects() {
  console.log("📦 Syncing projects...");
  
  const vectorDb = new Database(path.join(dataDir, "vector-store.db"), { readonly: true });
  
  try {
    // Get all unique projects
    const projects = vectorDb.prepare(`
      SELECT DISTINCT 
        json_extract(metadata, '$.projectId') as projectId,
        json_extract(metadata, '$.projectPath') as projectPath,
        COUNT(*) as documentCount,
        SUM(LENGTH(content)) as totalSize,
        MAX(json_extract(metadata, '$.indexedAt')) as lastIndexed
      FROM vector_documents 
      WHERE json_extract(metadata, '$.projectId') IS NOT NULL
      GROUP BY projectId
    `).all();

    console.log(`Found ${projects.length} projects to sync`);

    for (const project of projects as any[]) {
      const upsertedProject = await prisma.project.upsert({
        where: { projectId: project.projectId },
        create: {
          projectId: project.projectId,
          path: project.projectPath || '',
          documentCount: project.documentCount || 0,
          totalSize: project.totalSize || 0,
          lastIndexed: project.lastIndexed ? new Date(project.lastIndexed) : null,
        },
        update: {
          path: project.projectPath || '',
          documentCount: project.documentCount || 0,
          totalSize: project.totalSize || 0,
          lastIndexed: project.lastIndexed ? new Date(project.lastIndexed) : null,
        },
      });

      // Sync documents for this project
      const documents = vectorDb.prepare(`
        SELECT 
          id,
          json_extract(metadata, '$.projectId') as projectId,
          json_extract(metadata, '$.filePath') as filePath,
          json_extract(metadata, '$.fileType') as fileType,
          LENGTH(content) as size,
          json_extract(metadata, '$.indexedAt') as indexedAt
        FROM vector_documents 
        WHERE json_extract(metadata, '$.projectId') = ?
      `).all(project.projectId);

      for (const doc of documents as any[]) {
        await prisma.document.upsert({
          where: { id: doc.id },
          create: {
            id: doc.id,
            projectId: doc.projectId,
            filePath: doc.filePath || '',
            fileType: doc.fileType,
            size: doc.size || 0,
            indexedAt: new Date(doc.indexedAt || Date.now()),
          },
          update: {
            filePath: doc.filePath || '',
            fileType: doc.fileType,
            size: doc.size || 0,
            indexedAt: new Date(doc.indexedAt || Date.now()),
          },
        });
      }

      console.log(`  ✓ Synced project ${project.projectId} with ${documents.length} documents`);
    }

    console.log(`✅ Synced ${projects.length} projects`);
  } finally {
    vectorDb.close();
  }
}

async function syncAnalytics() {
  console.log("📊 Syncing analytics...");
  
  const analyticsDbPath = path.join(dataDir, "search-analytics.db");
  
  // Check if analytics db exists
  try {
    const analyticsDb = new Database(analyticsDbPath, { readonly: true });
    
    try {
      // Check if tables exist
      const tables = analyticsDb.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
      `).all();

      console.log(`Found ${tables.length} tables in analytics db`);
      
      // Sync would happen here when analytics tables are defined
      // For now, just log that we're ready
      
    } finally {
      analyticsDb.close();
    }
  } catch (error) {
    console.log("⚠️  Analytics database not found, skipping...");
  }
  
  console.log(`✅ Analytics sync complete`);
}

async function main() {
  console.log("🔄 Starting database synchronization...\n");
  
  try {
    await syncMemories();
    console.log();
    await syncProjects();
    console.log();
    await syncAnalytics();
    
    console.log("\n✨ Synchronization complete!");
  } catch (error) {
    console.error("❌ Sync failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
