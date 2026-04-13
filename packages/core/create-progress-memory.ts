#!/usr/bin/env bun
/**
 * Create a memory of our PostgreSQL migration progress
 */

import { logger, MemoryType } from "@th0th-ai/shared";
import { getPrismaClient, disconnectPrisma } from "./src/services/query/prisma-client.js";
import { randomUUID } from "crypto";

async function createProgressMemory() {
  try {
    const prisma = getPrismaClient();
    
    const memoryContent = `
# Migração PostgreSQL th0th - Status Completo

## ✅ CONCLUÍDO COM SUCESSO

### 1. Configuração Base
- Prisma Client configurado com @prisma/adapter-pg e pg
- Connection pooling PostgreSQL funcionando
- Auto-detecção de database type
- Singleton pattern para conexões

### 2. Schema e Migrations
- Provider: sqlite → postgresql
- Campos adicionados ao Memory: embedding (Bytes), lastAccessed (DateTime)
- Todas as tabelas criadas no Prisma Cloud PostgreSQL
- DATABASE_URL: postgres://...@db.prisma.io:5432/postgres

### 3. MemoryRepository Migrado
- ✅ MemoryRepositoryPg implementado (assíncrono)
- ✅ Factory pattern: getMemoryRepository()
- ✅ CRUD completo: insert, getById, search, update, delete
- ✅ Full-text search com PostgreSQL LIKE
- ✅ MemoryController atualizado para async/await

### 4. Build e Runtime
- Script de build copia generated/ para dist/
- Prisma Client disponível em runtime
- Dev server iniciando corretamente

### 5. Testes Validados
- ✅ Conexão PostgreSQL Cloud
- ✅ CREATE memórias
- ✅ READ queries
- ✅ UPDATE importance/accessCount
- ✅ DELETE remoção
- ✅ SEARCH por projectId

## 📊 Arquitetura Híbrida Atual

**PostgreSQL Cloud (Prisma):**
- Memories ✅ MIGRADO
- Projects ✅
- Documents ✅
- Search Queries ✅
- Cache Stats ✅

**SQLite Local (Performance):**
- SearchCache (mantido local)
- SearchAnalytics (pendente migração)
- SymbolDb (pendente migração)
- GraphStore (pendente migração)
- Embedding Cache (mantido local)

## 🎯 Sistema Funcionando

Logs confirmam migração:
\`\`\`
[INFO] Using PostgreSQL MemoryRepository
[INFO] Prisma Client initialized with PostgreSQL (pg adapter)
[INFO] MemoryRepositoryPg initialized (PostgreSQL)
\`\`\`

## 📁 Arquivos Principais Modificados

1. \`packages/core/src/services/query/prisma-client.ts\`
   - Adicionado PrismaPg adapter
   - Pool do pg configurado

2. \`packages/core/src/data/memory/memory-repository-pg.ts\`
   - Nova implementação PostgreSQL
   - Interface assíncrona completa

3. \`packages/core/src/data/memory/memory-repository-factory.ts\`
   - Factory retorna MemoryRepositoryPg

4. \`packages/core/src/controllers/memory-controller.ts\`
   - Métodos store() e search() com await
   - Compatível com async repository

5. \`packages/core/prisma/schema.prisma\`
   - Provider: postgresql
   - Memory com embedding e lastAccessed

6. \`packages/core/package.json\`
   - Build: "tsc && cp -r src/generated dist/"

## ⚠️ Nota Menor
SSL warning: recomendar sslmode=verify-full no .env

## 🚀 Próximos Passos (Opcional)
- Migrar SearchAnalytics para Prisma
- Migrar GraphStore para PostgreSQL
- Migrar SymbolDb para PostgreSQL
- Avaliar SearchCache (manter local ou migrar)

## ✨ Status Final
**MEMÓRIAS 100% FUNCIONAIS COM POSTGRESQL CLOUD** 🎉

Testado e validado em: ${new Date().toISOString()}
`;

    const memoryId = randomUUID();
    
    logger.info("Creating progress memory in PostgreSQL...");
    
    const memory = await prisma.memory.create({
      data: {
        id: memoryId,
        content: memoryContent,
        type: MemoryType.DECISION,
        level: 3,
        projectId: "th0th",
        importance: 1.0,
        tags: JSON.stringify([
          "postgresql",
          "migration",
          "progress",
          "architecture",
          "completed",
          "prisma-cloud"
        ]),
        metadata: JSON.stringify({
          migrationDate: new Date().toISOString(),
          status: "completed",
          databaseType: "postgresql",
          provider: "prisma-cloud"
        })
      }
    });
    
    console.log("\n✅ Progress memory created successfully!");
    console.log(`Memory ID: ${memory.id}`);
    console.log(`Type: ${memory.type}`);
    console.log(`Importance: ${memory.importance}`);
    console.log(`Project: ${memory.projectId}`);
    console.log(`Tags: ${memory.tags}`);
    console.log(`Created at: ${memory.createdAt}`);
    
    logger.info("\n📝 Memory content preview:");
    console.log(memoryContent.split('\n').slice(0, 15).join('\n'));
    console.log("...");
    
    logger.info("\n🎉 Memória de progresso salva no PostgreSQL Cloud!");
    console.log("Você pode recuperá-la posteriormente com o ID:", memoryId);
    
  } catch (error) {
    logger.error("❌ Failed to create progress memory:", error as Error);
    throw error;
  } finally {
    await disconnectPrisma();
  }
}

createProgressMemory();
