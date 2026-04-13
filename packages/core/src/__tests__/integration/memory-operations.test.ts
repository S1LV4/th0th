#!/usr/bin/env bun
/**
 * Test Memory operations with PostgreSQL
 */

import { MemoryController } from "../../controllers/memory-controller.js";
import { logger, MemoryType } from "@th0th-ai/shared";
import { getPrismaClient, disconnectPrisma } from "../../services/query/prisma-client.js";

async function testMemoryOperations() {
  try {
    const controller = MemoryController.getInstance();
    const prisma = getPrismaClient();
    
    logger.info("=== Test 1: Store a memory ===");
    const storeResult = await controller.store({
      content: "PostgreSQL migration test - this is a test memory to verify the system is working correctly with cloud database",
      type: MemoryType.CONVERSATION,
      projectId: "test-project-pg",
      importance: 0.9,
      tags: ["test", "postgresql", "migration"],
    });
    
    console.log("✅ Memory stored:", JSON.stringify(storeResult, null, 2));
    const memoryId = storeResult.memoryId;
    
    // Wait a bit for async operations
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    logger.info("=== Test 2: Verify memory in database ===");
    const memoryInDb = await prisma.memory.findUnique({
      where: { id: memoryId }
    });
    
    if (memoryInDb) {
      console.log("✅ Memory found in PostgreSQL:");
      console.log(JSON.stringify({
        id: memoryInDb.id,
        content: memoryInDb.content.substring(0, 50) + "...",
        type: memoryInDb.type,
        importance: memoryInDb.importance,
        tags: memoryInDb.tags,
        projectId: memoryInDb.projectId,
        createdAt: memoryInDb.createdAt,
      }, null, 2));
    } else {
      throw new Error("Memory not found in database!");
    }
    
    logger.info("=== Test 3: Search for the memory ===");
    const searchResult = await controller.search({
      query: "PostgreSQL migration test",
      projectId: "test-project-pg",
      limit: 5,
    });
    
    console.log("✅ Search completed:");
    console.log(`  Found ${searchResult.total} memories`);
    if (searchResult.memories.length > 0) {
      console.log(`  Top result score: ${searchResult.memories[0].score}`);
      console.log(`  Top result content: ${searchResult.memories[0].content.substring(0, 60)}...`);
    }
    
    logger.info("=== Test 4: List all test memories ===");
    const allTestMemories = await prisma.memory.findMany({
      where: {
        projectId: "test-project-pg"
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 10
    });
    
    console.log(`✅ Found ${allTestMemories.length} test memories in database`);
    
    logger.info("=== Test 5: Clean up test data ===");
    const deleted = await prisma.memory.deleteMany({
      where: {
        projectId: "test-project-pg"
      }
    });
    
    console.log(`✅ Cleaned up ${deleted.count} test memories`);
    
    logger.info("\n🎉 All memory tests passed! PostgreSQL integration is working correctly.");
    
  } catch (error) {
    logger.error("❌ Memory test failed:", error);
    throw error;
  } finally {
    await disconnectPrisma();
  }
}

testMemoryOperations();
