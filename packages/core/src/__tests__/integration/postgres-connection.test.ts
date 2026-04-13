#!/usr/bin/env bun
/**
 * Test script to verify PostgreSQL connection via Prisma
 */

import { getPrismaClient, disconnectPrisma } from "../../services/query/prisma-client.js";
import { logger } from "@th0th-ai/shared";

async function testConnection() {
  try {
    logger.info("Testing PostgreSQL connection...");
    
    const prisma = getPrismaClient();
    
    // Test 1: Raw query to check connection
    logger.info("Test 1: Executing raw query...");
    const result = await prisma.$queryRaw`SELECT 1 as test`;
    console.log("Raw query result:", result);
    
    // Test 2: Count existing projects
    logger.info("Test 2: Counting projects...");
    const projectCount = await prisma.project.count();
    logger.info(`Found ${projectCount} projects in database`);
    
    // Test 3: List all projects
    logger.info("Test 3: Listing projects...");
    const projects = await prisma.project.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' }
    });
    console.log(`Retrieved ${projects.length} projects:`, JSON.stringify(projects, null, 2));
    
    // Test 4: Count memories
    logger.info("Test 4: Counting memories...");
    const memoryCount = await prisma.memory.count();
    logger.info(`Found ${memoryCount} memories in database`);
    
    logger.info("✅ All tests passed! PostgreSQL connection is working.");
    
  } catch (error) {
    logger.error("❌ Connection test failed:", error);
    throw error;
  } finally {
    await disconnectPrisma();
  }
}

testConnection();
