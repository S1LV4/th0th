#!/usr/bin/env bun
/**
 * Test CRUD operations with PostgreSQL
 */

import { getPrismaClient, disconnectPrisma } from "../../services/query/prisma-client.js";
import { logger } from "@th0th-ai/shared";
import { randomUUID } from "crypto";

async function testCrudOperations() {
  try {
    const prisma = getPrismaClient();
    
    // Test 1: Create a project
    logger.info("Test 1: Creating a test project...");
    const projectId = randomUUID();
    const project = await prisma.project.create({
      data: {
        projectId: projectId,
        path: "/test/project",
        documentCount: 0,
        totalSize: 0
      }
    });
    logger.info("✅ Project created:", { project });
    
    // Test 2: Create a memory
    logger.info("Test 2: Creating a test memory...");
    const memoryId = randomUUID();
    const memory = await prisma.memory.create({
      data: {
        id: memoryId,
        content: "Test memory for PostgreSQL migration",
        type: "conversation",
        level: 1,
        importance: 0.8,
        tags: ["test", "migration"],
        projectId: projectId
      }
    });
    logger.info("✅ Memory created:", { memory });
    
    // Test 3: Read the project
    logger.info("Test 3: Reading project...");
    const projectWithData = await prisma.project.findUnique({
      where: { projectId: projectId }
    });
    logger.info("✅ Project found:", { project: projectWithData });
    
    // Test 4: Update the project
    logger.info("Test 4: Updating project...");
    const updatedProject = await prisma.project.update({
      where: { projectId: projectId },
      data: {
        documentCount: 10,
        totalSize: 1024000
      }
    });
    logger.info("✅ Project updated:", { project: updatedProject });
    
    // Test 5: Search memories
    logger.info("Test 5: Searching memories...");
    const memories = await prisma.memory.findMany({
      where: {
        type: "conversation",
        importance: { gte: 0.5 }
      },
      take: 5
    });
    logger.info(`✅ Found ${memories.length} memories`);
    
    // Test 6: Delete test data
    logger.info("Test 6: Cleaning up test data...");
    await prisma.memory.delete({ where: { id: memoryId } });
    await prisma.project.delete({ where: { projectId: projectId } });
    logger.info("✅ Test data cleaned up");
    
    logger.info("\n🎉 All CRUD operations passed! PostgreSQL is fully functional.");
    
  } catch (error) {
    logger.error("❌ CRUD test failed:", error);
    throw error;
  } finally {
    await disconnectPrisma();
  }
}

testCrudOperations();
