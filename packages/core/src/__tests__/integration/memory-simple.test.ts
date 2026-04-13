#!/usr/bin/env bun
/**
 * Simple test of PostgreSQL Memory storage (without embeddings)
 */

import { logger } from "@th0th-ai/shared";
import { getPrismaClient, disconnectPrisma } from "../../services/query/prisma-client.js";
import { randomUUID } from "crypto";

async function testMemoryStorage() {
  try {
    const prisma = getPrismaClient();
    
    logger.info("=== Test 1: Store a memory directly ===");
    const memoryId = randomUUID();
    const memory = await prisma.memory.create({
      data: {
        id: memoryId,
        content: "PostgreSQL migration test - direct storage without embeddings",
        type: "conversation",
        level: 1,
        projectId: "test-project-pg",
        importance: 0.9,
        tags: ["test", "postgresql", "migration"],
      }
    });
    
    logger.info("✅ Memory stored in PostgreSQL:", {
      id: memory.id,
      content: memory.content.substring(0, 50) + "...",
      type: memory.type,
      importance: memory.importance,
      projectId: memory.projectId,
    });
    
    logger.info("=== Test 2: Query the memory ===");
    const found = await prisma.memory.findUnique({
      where: { id: memoryId }
    });
    
    if (found) {
      console.log("✅ Memory found via query");
    } else {
      throw new Error("Memory not found!");
    }
    
    logger.info("=== Test 3: Update the memory ===");
    const updated = await prisma.memory.update({
      where: { id: memoryId },
      data: {
        importance: 0.95,
        accessCount: { increment: 1 }
      }
    });
    
    console.log("✅ Memory updated:");
    console.log(`  New importance: ${updated.importance}`);
    console.log(`  Access count: ${updated.accessCount}`);
    
    logger.info("=== Test 4: Search memories by project ===");
    const projectMemories = await prisma.memory.findMany({
      where: {
        projectId: "test-project-pg"
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    console.log(`✅ Found ${projectMemories.length} memories for project`);
    
    logger.info("=== Test 5: Clean up ===");
    await prisma.memory.delete({
      where: { id: memoryId }
    });
    
    console.log("✅ Test memory deleted");
    
    logger.info("\n🎉 All PostgreSQL storage tests passed!");
    
  } catch (error) {
    logger.error("❌ Test failed:", error);
    throw error;
  } finally {
    await disconnectPrisma();
  }
}

testMemoryStorage();
